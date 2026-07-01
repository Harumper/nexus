import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { formatBytes, formatDateTime } from "../lib/format";
import {
  RefreshCw, Folder, File as FileIcon, FileText, Image, Link2, ChevronRight,
  Download, Upload, Copy, Check, Search, Lock, AlertTriangle, Loader2, Home, Eye, X,
} from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { Button } from "./ui";
import type { FsEntry, Machine } from "../types";

interface FilesTabProps {
  machine: Machine;
}

// Cap aligned with the agent (files.go: fsMaxSize). Beyond it → we offer scp/rsync.
const FS_MAX_SIZE = 50 * 1024 * 1024;

// Preview caps — lower than the download cap to avoid bogging down the
// browser on a 50 MB image. Beyond it → direct download.
const PREVIEW_IMAGE_MAX = 8 * 1024 * 1024;   // 8 MB: covers most PNG/JPG
const PREVIEW_TEXT_MAX = 512 * 1024;          // 512 KB: generous for a config/log file

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"]);
const TEXT_EXTS = new Set([
  "txt", "log", "conf", "cfg", "ini", "yaml", "yml", "json", "toml", "md",
  "csv", "tsv", "xml", "html", "htm", "sh", "bash", "py", "js", "ts", "tsx",
  "jsx", "css", "scss", "go", "rs", "rb", "java", "c", "cpp", "h", "hpp",
  "service", "timer", "socket", "rules", "list", "sources", "env",
]);

type PreviewKind = "image" | "text" | null;

function previewKindFor(entry: FsEntry): PreviewKind {
  if (entry.kind !== "file" || entry.denied) return null;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return entry.size <= PREVIEW_IMAGE_MAX ? "image" : null;
  if (TEXT_EXTS.has(ext)) return entry.size <= PREVIEW_TEXT_MAX ? "text" : null;
  // Heuristic for extensionless files: if small (<= 256 KB), we try text
  if (!entry.name.includes(".") && entry.size > 0 && entry.size <= 256 * 1024) return "text";
  return null;
}

// Basic MIME by extension for the data: URL. Serving an SVG image as
// "image/svg+xml" avoids falling back to text/plain.
function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "webp": return "image/webp";
    case "ico": return "image/x-icon";
    case "bmp": return "image/bmp";
    case "avif": return "image/avif";
    default: return "application/octet-stream";
  }
}

// Shortcut paths offered in a sidebar. Pure UX, no backend
// allow-list: the agent-side denylist remains the authority.
const QUICK_PATHS = [
  { label: "/", path: "/" },
  { label: "/etc", path: "/etc" },
  { label: "/var/log", path: "/var/log" },
  { label: "/home", path: "/home" },
  { label: "/root", path: "/root" },
  { label: "/tmp", path: "/tmp" },
];

// formatBytes: central locale-aware helper (lib/format).

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

// Joins a Linux path cleanly (handles // and the root case).
function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}

// Returns the parent of a path. "/" stays "/".
function parentOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

// Generates the scp command to download from this machine to the
// user's workstation. ipAddress may be multiple comma-separated IPs
// (cf. the string seen in the machine header) → we take the first.
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

// Minimal shell quoting: wraps in ' and escapes internal '.
// Sufficient for non-hostile paths.
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:+\-,]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export default function FilesTab({ machine }: FilesTabProps) {
  const { t } = useTranslation(["files", "common"]);
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
  const [preview, setPreview] = useState<{ entry: FsEntry; fullPath: string; kind: "image" | "text"; data: string; sha256: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
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
      setError(getErrorMessage(err, "Loading error"));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [machine.id]);

  useEffect(() => { load("/"); }, [load]);

  const isInbox = cwd === inbox || cwd === inbox.replace(/\/$/, "");
  const showUpload = isInbox;

  // Local filtering + sort: directories first, then alphabetical.
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
      toast.error(t("toasts.accessDenied", { name: e.name }));
      return;
    }
    if (e.kind === "dir") {
      load(joinPath(cwd, e.name));
    } else if (e.kind === "file") {
      // Default behavior: preview if the type allows it, otherwise download.
      // The "DL" button remains available to force a direct download.
      if (previewKindFor(e)) {
        handlePreview(e);
      } else {
        handleDownload(e);
      }
    } else if (e.kind === "symlink") {
      toast.message(t("toasts.symlink", { target: e.symlink ?? "?" }));
    }
  };

  const handlePreview = async (e: FsEntry) => {
    const kind = previewKindFor(e);
    if (!kind) return;
    const fullPath = joinPath(cwd, e.name);
    setPreviewLoading(true);
    try {
      const res = await api.fsRead(machine.id, fullPath);
      let data: string;
      if (kind === "image") {
        data = `data:${mimeFor(e.name)};base64,${res.data.content_base64}`;
      } else {
        // UTF-8 decoding of the base64. For ~500 KB it stays instant.
        const bin = atob(res.data.content_base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        data = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
      setPreview({ entry: e, fullPath, kind, data, sha256: res.data.sha256 });
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.previewError")));
    } finally {
      setPreviewLoading(false);
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
      toast.success(t("toasts.downloaded", { name: e.name }));
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.downloadError")));
    } finally {
      setDownloadingFor(null);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (file.size > FS_MAX_SIZE) {
      setTooLargeFile({ name: file.name, size: file.size, path: inbox });
      return;
    }
    const cleanName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    if (cleanName !== file.name) {
      toast.message(t("toasts.sanitized", { orig: file.name, clean: cleanName }));
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const res = await api.fsUpload(machine.id, cleanName, b64);
      toast.success(t("toasts.uploaded", { filename: res.data.filename, size: formatBytes(res.data.size) }));
      await load(cwd);
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.uploadError")));
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
      toast.error(t("toasts.clipboardDenied"));
    }
  };

  // Builds the breadcrumb segments to render jumps into the middle of a path.
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
          title={t("rootTitle")}
          aria-label={t("rootAria")}
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
            placeholder={t("pathPlaceholder")}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" variant="ghost" size="sm">{t("go")}</Button>
        </form>

        <div className="relative min-w-[160px]">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: "var(--nx-text-weak)" }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("filterPlaceholder")}
            className="w-full rounded-md border border-input bg-background pl-7 pr-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <Button variant="ghost" size="sm" onClick={() => load(cwd)} loading={loading} icon={<RefreshCw />} aria-label={t("common:actions.refresh")} />
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
            {t("shortcuts")}
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
            <div className="border-t border-border my-2" />
            <button
              onClick={() => load(inbox)}
              className={`w-full text-left px-2 py-1 rounded text-xs font-mono hover:bg-muted transition-colors flex items-center gap-1.5 ${isInbox ? "bg-muted font-semibold" : ""}`}
              style={{ color: "var(--nx-warning)" }}
              title={t("inboxTitle")}
            >
              <Upload className="w-3 h-3" /> inbox
            </button>
          </div>
        </aside>

        {/* Table */}
        <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
          {/* Upload zone — only in the inbox */}
          {showUpload && (
            <div className="p-3 border-b border-border" style={{ background: "var(--nx-warning-subtle)" }}>
              <div className="flex items-center gap-3 flex-wrap">
                <Upload className="w-4 h-4" style={{ color: "var(--nx-warning)" }} />
                <div className="flex-1 min-w-[200px] text-xs" style={{ color: "var(--nx-text)" }}>
                  <Trans
                    i18nKey="inboxDesc"
                    t={t}
                    values={{ inbox, max: formatBytes(FS_MAX_SIZE) }}
                    components={[<span key="0" className="font-mono" />, <span key="1" className="font-mono" />]}
                  />
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
                  {t("uploadButton")}
                </Button>
              </div>
            </div>
          )}

          {truncated && (
            <div className="px-3 py-1.5 text-[11px]" style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>
              {t("truncated")}
            </div>
          )}

          <table className="w-full text-sm">
            <thead style={{ background: "var(--nx-bg-elevated)" }}>
              <tr className="text-xs uppercase" style={{ color: "var(--nx-text-weak)" }}>
                <th className="px-4 py-2 text-left">{t("headers.name")}</th>
                <th className="px-4 py-2 text-right">{t("headers.size")}</th>
                <th className="px-4 py-2 text-left hidden md:table-cell">{t("headers.modified")}</th>
                <th className="px-4 py-2 text-left hidden lg:table-cell">{t("headers.mode")}</th>
                <th className="px-4 py-2 text-right">{t("headers.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm" style={{ color: "var(--nx-text-weak)" }}>
                    {entries.length === 0 ? t("emptyDir") : t("noMatch")}
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
                      {e.mtime ? formatDateTime(e.mtime) : ""}
                    </td>
                    <td className="px-4 py-2 hidden lg:table-cell text-xs font-mono" style={{ color: "var(--nx-text-weak)" }}>
                      {e.mode}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1 justify-end">
                        {e.kind === "file" && !e.denied && (
                          <>
                            {previewKindFor(e) && (
                              <button
                                onClick={() => handlePreview(e)}
                                disabled={previewLoading}
                                className="p-1.5 rounded hover:bg-muted transition-colors"
                                title={t("previewTitle")}
                                style={{ color: "var(--nx-text-weak)" }}
                              >
                                {previewLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            )}
                            <button
                              onClick={() => handleDownload(e)}
                              disabled={downloadingFor === e.name}
                              className="p-1.5 rounded hover:bg-muted transition-colors"
                              title={e.size > FS_MAX_SIZE ? t("downloadTooLargeTitle", { max: formatBytes(FS_MAX_SIZE) }) : t("downloadTitle")}
                              style={{ color: "var(--nx-info)" }}
                            >
                              {downloadingFor === e.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => copyToClipboard(scpDownloadCmd(machine, fullPath), scpKey)}
                              className="p-1.5 rounded hover:bg-muted transition-colors"
                              title={t("copyCmdTitle", { cmd: scpDownloadCmd(machine, fullPath) })}
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

      {/* "file too large" modal */}
      {tooLargeFile && (
        <TooLargeModal
          file={tooLargeFile}
          machine={machine}
          inbox={inbox}
          onClose={() => setTooLargeFile(null)}
        />
      )}

      {/* image / text preview modal */}
      {preview && (
        <PreviewModal
          entry={preview.entry}
          fullPath={preview.fullPath}
          kind={preview.kind}
          data={preview.data}
          sha256={preview.sha256}
          machine={machine}
          onClose={() => setPreview(null)}
          onDownload={() => {
            handleDownload(preview.entry);
            setPreview(null);
          }}
        />
      )}
    </div>
  );
}

function PreviewModal({
  entry,
  fullPath,
  kind,
  data,
  sha256,
  machine,
  onClose,
  onDownload,
}: {
  entry: FsEntry;
  fullPath: string;
  kind: "image" | "text";
  data: string;
  sha256: string;
  machine: Machine;
  onClose: () => void;
  onDownload: () => void;
}) {
  const { t } = useTranslation(["files", "common"]);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedContent, setCopiedContent] = useState(false);
  const scpCmd = scpDownloadCmd(machine, fullPath);

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(scpCmd);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1500);
    } catch {
      toast.error(t("toasts.clipboardDenied"));
    }
  };

  const copyTextContent = async () => {
    try {
      await navigator.clipboard.writeText(data);
      setCopiedContent(true);
      setTimeout(() => setCopiedContent(false), 1500);
    } catch {
      toast.error(t("toasts.clipboardDenied"));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl max-w-5xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-border shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {kind === "image" ? <Image className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
              <span className="font-mono text-xs truncate">{entry.name}</span>
            </div>
            <div className="text-[10px] mt-0.5 font-mono truncate" style={{ color: "var(--nx-text-weak)" }}>
              {fullPath} · {formatBytes(entry.size)} · sha256 {sha256.slice(0, 12)}…
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
            aria-label={t("common:a11y.close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto" style={{ background: kind === "image" ? "var(--nx-bg-elevated)" : "var(--nx-bg-surface)" }}>
          {kind === "image" ? (
            <div className="flex items-center justify-center p-4 min-h-full">
              <img
                src={data}
                alt={entry.name}
                className="max-w-full max-h-[70vh] object-contain rounded"
                style={{ background: "repeating-conic-gradient(#444 0% 25%, transparent 0% 50%) 50% / 16px 16px" }}
              />
            </div>
          ) : (
            <pre
              className="p-4 text-xs font-mono whitespace-pre-wrap break-words"
              style={{ color: "var(--nx-text)" }}
            >
              {data}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border shrink-0 flex-wrap">
          <code className="text-[10px] font-mono truncate flex-1 min-w-[200px] px-2 py-1 rounded" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}>
            {scpCmd}
          </code>
          <div className="flex gap-2 shrink-0">
            {kind === "text" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={copyTextContent}
                icon={copiedContent ? <Check /> : <Copy />}
              >
                {copiedContent ? t("copied") : t("common:actions.copy")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={copyCmd}
              icon={copiedCmd ? <Check /> : <Copy />}
            >
              {copiedCmd ? t("copiedScp") : t("copyScp")}
            </Button>
            <Button variant="primary" size="sm" onClick={onDownload} icon={<Download />}>
              {t("common:actions.download")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Displays ready-to-copy scp/rsync commands when a file
// exceeds the cap. inbox path is used when it's a failing upload.
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
  const { t } = useTranslation(["files", "common"]);
  const [copied, setCopied] = useState<string | null>(null);
  const isUpload = file.path === inbox;

  const cmds = isUpload
    ? [
        { label: t("tooLarge.scpUpload"), cmd: scpUploadCmd(machine, `./${file.name}`, `${inbox}/`) },
        { label: t("tooLarge.rsync"), cmd: `rsync -avP ${shellQuote(`./${file.name}`)} ${(machine.sshUser || "root")}@${(machine.ipAddress?.split(",")[0] || machine.hostname || machine.name).trim()}:${shellQuote(`${inbox}/`)}` },
      ]
    : [
        { label: t("tooLarge.scpDownload"), cmd: scpDownloadCmd(machine, file.path) },
        { label: t("tooLarge.rsync"), cmd: rsyncDownloadCmd(machine, file.path) },
      ];

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error(t("toasts.clipboardDenied"));
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
            <h2 className="text-sm font-semibold">{t("tooLarge.title")}</h2>
            <p className="text-xs mt-1" style={{ color: "var(--nx-text-weak)" }}>
              <Trans
                i18nKey="tooLarge.line1"
                t={t}
                values={{ name: file.name, size: formatBytes(file.size), max: formatBytes(FS_MAX_SIZE) }}
                components={[<span key="0" className="font-mono" />]}
              /><br />
              {isUpload ? t("tooLarge.uploadHint") : t("tooLarge.downloadHint")}
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
                  title={t("common:actions.copy")}
                >
                  {copied === c.label ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end mt-5">
          <Button variant="ghost" onClick={onClose}>{t("common:actions.close")}</Button>
        </div>
      </div>
    </div>
  );
}

// ── Binary helpers ──────────────────────────────────────────

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
  // btoa() doesn't support unicode/binary directly, so we convert to an
  // ASCII string char-by-char. For 50 MB it stays reasonable.
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000; // 32 KB at a time to avoid "Maximum call stack size"
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}
