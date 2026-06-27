import { useState, useEffect, useRef } from "react";
import { Network, Save, RefreshCw, Loader2, AlertTriangle, CheckCircle2, FileText } from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import { useConfirm } from "./ui";
import { getErrorMessage } from "../services/errors";

interface Props {
  machineId: string;
}

interface NetplanFile {
  filename: string;
  content: string;
}

export default function NetworkConfigTab({ machineId }: Props) {
  const [files, setFiles] = useState<NetplanFile[]>([]);
  const [targetFile, setTargetFile] = useState("99-nexus.yaml");
  const [selectedFile, setSelectedFile] = useState("99-nexus.yaml");
  const [editorContent, setEditorContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ requestId: string; expiresAt: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const { confirm, ConfirmDialogElement } = useConfirm();
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Le fichier en cours d'affichage est-il celui géré par Nexus (=> éditable) ?
  const isEditable = selectedFile === targetFile;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.netplanGet(machineId);
      const data = res?.data;
      const allFiles: NetplanFile[] = data?.files || [];
      setFiles(allFiles);
      const tgt = data?.target_file || "99-nexus.yaml";
      setTargetFile(tgt);
      // Garder la sélection courante si elle existe encore, sinon target
      setSelectedFile((cur) => allFiles.some((f) => f.filename === cur) ? cur : tgt);
      const current = allFiles.find((f) => f.filename === (allFiles.some((f) => f.filename === selectedFile) ? selectedFile : tgt));
      const content = current?.content || defaultNetplan();
      setEditorContent(content);
      setOriginalContent(content);
    } catch (err) {
      setError(getErrorMessage(err, "Erreur"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [machineId]);

  // Quand on change de fichier sélectionné, recharger le contenu depuis files cache
  useEffect(() => {
    const f = files.find((x) => x.filename === selectedFile);
    if (!f) return;
    setEditorContent(f.content);
    setOriginalContent(f.content);
  }, [selectedFile, files]);

  // Poll status for pending watchdogs (au cas où un autre admin aurait lancé un apply)
  useEffect(() => {
    if (pending) return; // Ne pas poller si on a nous-même un pending
    const t = setInterval(async () => {
      try {
        const st = await api.networkStatus(machineId);
        const p = st?.data?.pending?.[0];
        if (p) {
          setPending({
            requestId: p.request_id,
            expiresAt: Date.now() + (p.expires_in_seconds || 0) * 1000,
          });
        }
      } catch { /* ignore */ }
    }, 15_000);
    return () => clearInterval(t);
  }, [pending, machineId]);

  // Countdown timer quand un pending est actif
  useEffect(() => {
    if (!pending) {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const r = Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000));
      setRemaining(r);
      if (r <= 0) {
        setPending(null);
        if (countdownRef.current) clearInterval(countdownRef.current);
        load();
      }
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [pending]);

  const handleApply = async () => {
    if (!(await confirm({
      title: "Appliquer cette configuration réseau ?",
      description:
        "Si vous perdez la connexion ou ne confirmez pas dans les 120s, la configuration précédente sera restaurée automatiquement.",
      confirmLabel: "Appliquer",
      variant: "danger",
    }))) return;
    setApplying(true);
    setError("");
    try {
      const res = await api.netplanApply(machineId, editorContent);
      const data = res?.data;
      setPending({
        requestId: data.request_id,
        expiresAt: Date.now() + 120_000,
      });
      setOriginalContent(editorContent);
      toast.success("Configuration appliquée — confirmez avant 120s");
    } catch (err) {
      toast.error(getErrorMessage(err, "Apply failed"));
      setError(getErrorMessage(err, "Apply failed"));
    } finally {
      setApplying(false);
    }
  };

  const handleConfirm = async () => {
    if (!pending) return;
    try {
      await api.netplanConfirm(machineId, pending.requestId);
      setPending(null);
    } catch (err) {
      toast.error("Erreur : " + (getErrorMessage(err, "confirm failed")));
    }
  };

  const isDirty = editorContent !== originalContent;

  return (
    <div className="space-y-4">
      {/* Pending watchdog banner */}
      {pending && remaining > 0 && (
        <div className="rounded-xl border p-4 flex items-center justify-between" style={{ background: "var(--nx-warning-subtle)", borderColor: "var(--nx-warning)" }}>
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5" style={{ color: "var(--nx-warning)" }} />
            <div>
              <div className="text-sm font-semibold" style={{ color: "var(--nx-warning)" }}>
                Configuration appliquée — Confirmer dans {remaining}s
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
                Si vous ne confirmez pas, la configuration précédente sera restaurée automatiquement.
              </div>
            </div>
          </div>
          <button
            onClick={handleConfirm}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
            style={{ background: "var(--nx-success)", color: "var(--nx-bg-base)" }}
          >
            <CheckCircle2 className="w-4 h-4" />
            Confirmer ({remaining}s)
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4" style={{ color: "var(--nx-text-weak)" }} />
              <span className="text-xs font-semibold">/etc/netplan/{selectedFile}</span>
              {isEditable ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--nx-primary-subtle)", color: "var(--nx-primary)" }}>
                  Géré par Nexus
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}>
                  Lecture seule
                </span>
              )}
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs"
              style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </button>
          </div>

          <textarea
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            disabled={!isEditable || !!pending}
            spellCheck={false}
            rows={18}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono resize-y disabled:opacity-90"
            placeholder="network:&#10;  version: 2&#10;  ethernets:&#10;    eth0:&#10;      dhcp4: true"
          />

          {!isEditable && (
            <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>
              <FileText className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Ce fichier n'est pas géré par Nexus. Pour modifier la configuration réseau,
                sélectionnez <code className="font-mono">{targetFile}</code> dans la sidebar
                ou éditez directement via SSH.
              </span>
            </div>
          )}

          {isEditable && (
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: "var(--nx-text-weak)" }}>
                {isDirty ? "Modifications non appliquées" : "Synchronisé"}
              </div>
              <button
                onClick={handleApply}
                disabled={!isDirty || applying || !!pending}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{ background: "var(--nx-primary)", color: "var(--nx-bg-base)" }}
              >
                {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Appliquer (watchdog 120s)
              </button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-border p-4" style={{ background: "var(--nx-bg-surface)" }}>
            <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>
              <Network className="w-3.5 h-3.5 inline mr-1" />
              Fichiers netplan
            </h3>
            {files.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--nx-text-weak)" }}>
                Aucun fichier détecté.
              </p>
            ) : (
              <div className="space-y-1">
                {files.map((f) => {
                  const isTarget = f.filename === targetFile;
                  const isActive = f.filename === selectedFile;
                  return (
                    <button
                      key={f.filename}
                      onClick={() => setSelectedFile(f.filename)}
                      className="w-full flex items-center gap-2 text-left rounded px-2 py-1.5 text-xs transition-colors"
                      style={{
                        background: isActive ? "var(--nx-primary-subtle)" : "transparent",
                        color: isActive ? "var(--nx-primary)" : "var(--nx-text)",
                      }}
                    >
                      <FileText className="w-3 h-3 shrink-0" />
                      <span className="font-mono truncate flex-1">{f.filename}</span>
                      {isTarget && (
                        <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: "var(--nx-primary)", color: "var(--nx-bg-base)" }}>
                          Nexus
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-[10px] mt-3" style={{ color: "var(--nx-text-weak)" }}>
              Nexus ne modifie que <code>{targetFile}</code>. Les autres fichiers sont lisibles ici mais à éditer via SSH.
            </p>
          </div>

          <div className="rounded-xl border border-border p-4 text-xs space-y-2" style={{ background: "var(--nx-bg-surface)" }}>
            <div className="font-semibold" style={{ color: "var(--nx-text)" }}>Watchdog-revert</div>
            <p style={{ color: "var(--nx-text-weak)" }}>
              Après <strong>netplan apply</strong>, vous avez <strong>120 secondes</strong> pour
              confirmer. Sans confirmation (ex: perte d'accès réseau), la configuration
              précédente est restaurée automatiquement.
            </p>
            <p style={{ color: "var(--nx-text-weak)" }}>
              Un <em>dead-man's switch</em> restaure aussi au redémarrage de l'agent si celui-ci
              crash pendant la fenêtre.
            </p>
          </div>
        </div>
      </div>
      {ConfirmDialogElement}
    </div>
  );
}

function defaultNetplan(): string {
  return `network:
  version: 2
  renderer: networkd
  ethernets:
    eth0:
      dhcp4: true
`;
}
