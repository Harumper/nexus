import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  RefreshCw, Folder, File as FileIcon, FileText, Image, Link2, ChevronRight,
  Download, Upload, Copy, Check, Search, Lock, AlertTriangle, Loader2, Home,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { Button } from "./ui";
import type { FsEntry, Machine } from "../types";

interface FilesTabProps {
  machine: Machine;
  canUpload: boolean; // false côté PROBE
}

// Cap aligné avec l'agent (files.go: fsMaxSize). Au-delà → on propose scp/rsync.
const FS_MAX_SIZE = 50 * 1024 * 1024;

// Chemins de raccourci proposés dans une barre latérale. Pure UX, pas
// d'allow-list backend : la denylist côté agent reste l'autorité.
const QUICK_PATHS = [
  { label: "/", path: "/" },
  { label: "/etc", path: "/etc" },
  { label: "/var/log", path: "/var/log" },
  { label: "/home", path: "/home" },
  { label: "/root", path: "/root" },
  { label: "/tmp", path: "/tmp" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function iconFor(entry: FsEntry): React.ReactNode {
  const cls = "w-4 h-4 shrink-0";
  if (entry.kind === "dir") return <Folder className={cls} style={{ color: "var(--nx-info)" }} />;
  if (entry.kind === "symlink") return <Link2 className={cls} style={{ color: "var(--nx-text-weak)" }} />;
  if (entry.kind !== "file") return <FileIcon className={cls} style={{ color: "var(--nx-text-weak)" }} />;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"].includes(ext)) {
    return <Image className={cls} style={{ color: "var(--nx-success)" }} />;
  }
  if (["log", "txt", "conf", "cfg", "yaml", "yml", "json", "toml", "ini", "md"].includes(ext)) {
    return <FileText className={cls} style={{ color: "var(--nx-text-weak)" }} />;
  }
  return <FileIcon className={cls} style={{ color: "var(--nx-text-weak)" }} />;
}

// Concatène un chemin Linux proprement (gère les // et le cas root).
function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}

// Renvoie le parent d'un chemin. "/" reste "/".
function parentOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

// Génère la commande scp pour download depuis cette machine vers le
// poste de l'utilisateur. ipAddress peut être multi-IPs séparés par virgule
// (cf. la string vue dans le header machine) → on prend la première.
function scpDownloadCmd(machine: Machine, remotePath: string): string {
  const host = (machine.ipAddress?.split(",")[0].trim() || machine.hostname || machine.name).trim();
  const user = machine.sshUser || "root";
  return `scp ${user}@${host}:${shellQuote(remotePath)} ./`;
}

function rsyncDownloadCmd(machine: Machine, remotePath: string): string {
  const host = (machine.ipAddress?.split(",")[0].trim() || machine.hostname || machine.name).trim();
  const user = machine.sshUser || "root";
  return `rsync -avP ${user}@${host}:${shellQuote(remotePath)} ./`;
}

function scpUploadCmd(machine: Machine, localExample: string, inboxPath: string): string {
  const host = (machine.ipAddress?.split(",")[0].trim() || machine.hostname || machine.name).trim();
  const user = machine.sshUser || "root";
  return `scp ${shellQuote(localExample)} ${user}@${host}:${shellQuote(inboxPath)}`;
}

// Quoting shell minimal : entoure de ' et échappe les ' internes.
// Suffisant pour des chemins non hostiles.
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:+\-,]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export default function FilesTab({ machine, canUpload }: FilesTabProps) {
  const [cwd, setCwd] = useState<string>("/");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [inbox, setInbox] = useState<string>("/var/lib/nexus-agent/inbox");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [downloadingFor, setDownloadingFor] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [tooLargeFile, setTooLargeFile] = useState<{ name: string; size: number; path: string } | null>(null);
  const [pathInput, setPathInput] = useState<string>("/");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.fsList(machine.id, target);
      setEntries(res.data.entries || []);
      setTruncated(res.data.truncated);
      setCwd(res.data.path);
      setPathInput(res.data.path);
      if (res.data.inbox) setInbox(res.data.inbox);
    } catch (err) {
      setError(getErrorMessage(err, "Erreur de chargement"));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [machine.id]);

  useEffect(() => { load("/"); }, [load]);

  const isInbox = cwd === inbox || cwd === inbox.replace(/\/$/, "");
  const showUpload = canUpload && isInbox;

  // Filtrage local + tri : dossiers d'abord, puis alphabétique.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...entries]
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [entries, search]);

  const onEntryClick = (e: FsEntry) => {
    if (e.denied) {
      toast.error(`Accès refusé par la politique de sécurité : ${e.name}`);
      return;
    }
    if (e.kind === "dir") {
      load(joinPath(cwd, e.name));
    } else if (e.kind === "file") {
      handleDownload(e);
    } else if (e.kind === "symlink") {
      toast.message(`Symlink → ${e.symlink ?? "?"} (non suivi)`);
    }
  };

  const handleDownload = async (e: FsEntry) => {
    const fullPath = joinPath(cwd, e.name);
    if (e.size > FS_MAX_SIZE) {
      setTooLargeFile({ name: e.name, size: e.size, path: fullPath });
      return;
    }
    setDownloadingFor(e.name);
    try {
      const res = await api.fsRead(machine.id, fullPath);
      const bin = base64ToBlob(res.data.content_base64);
      triggerBrowserDownload(bin, e.name);
      toast.success(`${e.name} téléchargé`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Download échoué"));
    } finally {
      setDownloadingFor(null);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (!canUpload) return;
    if (file.size > FS_MAX_SIZE) {
      setTooLargeFile({ name: file.name, size: file.size, path: inbox });
      return;
    }
    const cleanName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    if (cleanName !== file.name) {
      toast.message(`Nom assaini : ${file.name} → ${cleanName}`);
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const res = await api.fsUpload(machine.id, cleanName, b64);
      toast.success(`Uploadé : ${res.data.filename} (${formatBytes(res.data.size)})`);
      await load(cwd);
    } catch (err) {
      toast.error(getErrorMessage(err, "Upload échoué"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Clipboard refusé");
    }
  };

  // Construit les segments du breadcrumb pour rendre les sauts au milieu d'un chemin.
  const breadcrumbs = useMemo(() => {
    if (cwd === "/") return [{ label: "/", path: "/" }];
    const parts = cwd.split("/").filter(Boolean);
    const segs = [{ label: "/", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += "/" + p;
      segs.push({ label: p, path: acc });
    }
    return segs;
  }, [cwd]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => load("/")}
          className="p-1.5 rounded hover:bg-muted transition-colors"
          title="Racine"
          aria-label="Aller à la racine"
        >
          <Home className="w-4 h-4" />
        </button>
        <button
          onClick={() => load(parentOf(cwd))}
          disabled={cwd === "/"}
          className="px-2 py-1 text-xs rounded border border-border hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ..
        </button>

        <form
          className="flex-1 min-w-[260px] flex items-center gap-1"
          onSubmit={(e) => { e.preventDefault(); load(pathInput.trim() || "/"); }}
        >
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/chemin/absolu"
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" variant="ghost" size="sm">Aller</Button>
        </form>

        <div className="relative min-w-[160px]">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: "var(--nx-text-weak)" }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrer..."
            className="w-full rounded-md border border-input bg-background pl-7 pr-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <Button variant="ghost" size="sm" onClick={() => load(cwd)} loading={loading} icon={<RefreshCw />} aria-label="Rafraîchir" />
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs flex-wrap" style={{ color: "var(--nx-text-weak)" }}>
        {breadcrumbs.map((b, i) => (
          <span key={b.path} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="w-3 h-3" />}
            <button
              onClick={() => load(b.path)}
              className="hover:text-foreground hover:underline font-mono"
            >
              {b.label}
            </button>
          </span>
        ))}
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
        {/* Quick paths */}
        <aside className="rounded-xl p-3 h-fit" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--nx-text-weak)" }}>
            Raccourcis
          </h3>
          <div className="space-y-0.5">
            {QUICK_PATHS.map((q) => (
              <button
                key={q.path}
                onClick={() => load(q.path)}
                className={`w-full text-left px-2 py-1 rounded text-xs font-mono hover:bg-muted transition-colors ${cwd === q.path ? "bg-muted font-semibold" : ""}`}
              >
                {q.label}
              </button>
            ))}
            {canUpload && (
              <>
                <div className="border-t border-border my-2" />
                <button
                  onClick={() => load(inbox)}
                  className={`w-full text-left px-2 py-1 rounded text-xs font-mono hover:bg-muted transition-colors flex items-center gap-1.5 ${isInbox ? "bg-muted font-semibold" : ""}`}
                  style={{ color: "var(--nx-warning)" }}
                  title="Boîte d'upload Nexus"
                >
                  <Upload className="w-3 h-3" /> inbox
                </button>
              </>
            )}
          </div>
        </aside>

        {/* Table */}
        <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
          {/* Upload zone — uniquement dans l'inbox */}
          {showUpload && (
            <div className="p-3 border-b border-border" style={{ background: "var(--nx-warning-subtle)" }}>
              <div className="flex items-center gap-3 flex-wrap">
                <Upload className="w-4 h-4" style={{ color: "var(--nx-warning)" }} />
                <div className="flex-1 min-w-[200px] text-xs" style={{ color: "var(--nx-text)" }}>
                  Inbox <span className="font-mono">{inbox}</span> · fichiers en 0640 non exécutables · auto-purge après 7 j · max {formatBytes(FS_MAX_SIZE)}.
                  Connecte-toi en SSH puis <span className="font-mono">sudo mv</span> pour déplacer.
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUploadFile(f);
                  }}
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => fileInputRef.current?.click()}
                  loading={uploading}
                  icon={<Upload />}
                >
                  Uploader un fichier
                </Button>
              </div>
            </div>
          )}

          {truncated && (
            <div className="px-3 py-1.5 text-[11px]" style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>
              Listing tronqué (trop d'entrées). Affine via le champ de filtre ou descend dans un sous-dossier.
            </div>
          )}

          <table className="w-full text-sm">
            <thead style={{ background: "var(--nx-bg-elevated)" }}>
              <tr className="text-xs uppercase" style={{ color: "var(--nx-text-weak)" }}>
                <th className="px-4 py-2 text-left">Nom</th>
                <th className="px-4 py-2 text-right">Taille</th>
                <th className="px-4 py-2 text-left hidden md:table-cell">Modifié</th>
                <th className="px-4 py-2 text-left hidden lg:table-cell">Mode</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm" style={{ color: "var(--nx-text-weak)" }}>
                    {entries.length === 0 ? "Dossier vide." : "Aucune entrée ne correspond au filtre."}
                  </td>
                </tr>
              )}
              {filtered.map((e) => {
                const fullPath = joinPath(cwd, e.name);
                const scpKey = `scp:${fullPath}`;
                return (
                  <tr
                    key={e.name}
                    className="border-t hover:bg-muted/30"
                    style={{ borderColor: "var(--nx-border)" }}
                  >
                    <td className="px-4 py-2">
                      <button
                        onClick={() => onEntryClick(e)}
                        className="flex items-center gap-2 text-left hover:underline disabled:no-underline disabled:cursor-not-allowed"
                        disabled={e.denied}
                        style={{ color: e.denied ? "var(--nx-text-weak)" : "var(--nx-text)" }}
                      >
                        {e.denied ? <Lock className="w-4 h-4 shrink-0" style={{ color: "var(--nx-danger)" }} /> : iconFor(e)}
                        <span className="font-mono text-xs truncate max-w-[260px]">{e.name}</span>
                        {e.symlink && (
                          <span className="text-[10px] font-mono truncate max-w-[200px]" style={{ color: "var(--nx-text-weak)" }}>
                            → {e.symlink}
                          </span>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums" style={{ color: "var(--nx-text-weak)" }}>
                      {e.kind === "file" ? formatBytes(e.size) : ""}
                    </td>
                    <td className="px-4 py-2 hidden md:table-cell text-xs" style={{ color: "var(--nx-text-weak)" }}>
                      {e.mtime ? new Date(e.mtime).toLocaleString("fr-FR") : ""}
                    </td>
                    <td className="px-4 py-2 hidden lg:table-cell text-xs font-mono" style={{ color: "var(--nx-text-weak)" }}>
                      {e.mode}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1 justify-end">
                        {e.kind === "file" && !e.denied && (
                          <>
                            <button
                              onClick={() => handleDownload(e)}
                              disabled={downloadingFor === e.name}
                              className="p-1.5 rounded hover:bg-muted transition-colors"
                              title={e.size > FS_MAX_SIZE ? `> ${formatBytes(FS_MAX_SIZE)}, propose une commande scp` : "Télécharger via Nexus"}
                              style={{ color: "var(--nx-info)" }}
                            >
                              {downloadingFor === e.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => copyToClipboard(scpDownloadCmd(machine, fullPath), scpKey)}
                              className="p-1.5 rounded hover:bg-muted transition-colors"
                              title={`Copier : ${scpDownloadCmd(machine, fullPath)}`}
                              style={{ color: copied === scpKey ? "var(--nx-success)" : "var(--nx-text-weak)" }}
                            >
                              {copied === scpKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal "fichier trop gros" */}
      {tooLargeFile && (
        <TooLargeModal
          file={tooLargeFile}
          machine={machine}
          inbox={inbox}
          onClose={() => setTooLargeFile(null)}
        />
      )}
    </div>
  );
}

// Affiche les commandes scp/rsync prêtes à copier quand un fichier
// dépasse le cap. Inboxpath sert quand c'est un upload qui rate.
function TooLargeModal({
  file,
  machine,
  inbox,
  onClose,
}: {
  file: { name: string; size: number; path: string };
  machine: Machine;
  inbox: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const isUpload = file.path === inbox;

  const cmds = isUpload
    ? [
        { label: "scp (depuis ton poste)", cmd: scpUploadCmd(machine, `./${file.name}`, `${inbox}/`) },
        { label: "rsync (avec progression)", cmd: `rsync -avP ${shellQuote(`./${file.name}`)} ${(machine.sshUser || "root")}@${(machine.ipAddress?.split(",")[0] || machine.hostname || machine.name).trim()}:${shellQuote(`${inbox}/`)}` },
      ]
    : [
        { label: "scp (vers ton poste)", cmd: scpDownloadCmd(machine, file.path) },
        { label: "rsync (avec progression)", cmd: rsyncDownloadCmd(machine, file.path) },
      ];

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("Clipboard refusé");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl max-w-2xl w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--nx-warning)" }} />
          <div>
            <h2 className="text-sm font-semibold">Fichier trop volumineux pour Nexus</h2>
            <p className="text-xs mt-1" style={{ color: "var(--nx-text-weak)" }}>
              <span className="font-mono">{file.name}</span> · {formatBytes(file.size)} · cap Nexus : {formatBytes(FS_MAX_SIZE)}.<br />
              {isUpload
                ? "Utilise scp ou rsync directement vers l'inbox de l'agent."
                : "Utilise scp ou rsync depuis ton poste pour récupérer le fichier."}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {cmds.map((c) => (
            <div key={c.label}>
              <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: "var(--nx-text-weak)" }}>
                {c.label}
              </div>
              <div className="flex items-stretch gap-2">
                <code className="flex-1 px-3 py-2 rounded text-xs font-mono break-all" style={{ background: "var(--nx-bg-elevated)" }}>
                  {c.cmd}
                </code>
                <button
                  onClick={() => copy(c.cmd, c.label)}
                  className="px-3 rounded border border-border hover:bg-muted transition-colors"
                  style={{ color: copied === c.label ? "var(--nx-success)" : "var(--nx-text-weak)" }}
                  title="Copier"
                >
                  {copied === c.label ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end mt-5">
          <Button variant="ghost" onClick={onClose}>Fermer</Button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers binaires ────────────────────────────────────────

function base64ToBlob(b64: string): Blob {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // btoa() ne supporte pas l'unicode/binaire directement, on convertit en
  // string ASCII char-par-char. Pour 50 MB ça reste raisonnable.
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000; // 32 KB à la fois pour éviter "Maximum call stack size"
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}
