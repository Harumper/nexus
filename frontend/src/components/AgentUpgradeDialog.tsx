import { useState, useCallback, useRef, useEffect } from "react";
import {
  ArrowUpCircle,
  CheckCircle2,
  XCircle,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Terminal as TerminalIcon,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useWebSocket } from "../hooks/useWebSocket";
import { Dialog, Button } from "./ui";
import type { WSDashboardMessage } from "../types";

interface Props {
  machineId: string;
  machineName: string;
  ipAddress?: string | null;
  sshUser?: string | null;
  onClose: () => void;
  /** Appelé quand l'agent est confirmé reconnecté en nouvelle version. */
  onSuccess?: () => void;
}

type Status = "confirm" | "working" | "success" | "failed";

interface ProgressMsg {
  line: string;
  percent: number;
}
interface ResultMsg {
  success: boolean;
  reason?: string;
  message?: string;
  version?: string | null;
  durationMs?: number;
}

// Filet de sécurité côté client : un peu au-delà du timeout backend (180s).
const CLIENT_TIMEOUT_MS = 195_000;

export default function AgentUpgradeDialog({
  machineId,
  machineName,
  ipAddress,
  sshUser,
  onClose,
  onSuccess,
}: Props) {
  const [status, setStatus] = useState<Status>("confirm");
  const [percent, setPercent] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [resultMsg, setResultMsg] = useState<string>("");
  const [resultVersion, setResultVersion] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [showDebug, setShowDebug] = useState(false);

  const startedAtRef = useRef<number>(0);
  const lastProgressAtRef = useRef<number>(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  // Statut courant accessible dans le handler WS (closure stable) : on n'agit
  // que pendant "working" pour ignorer tout message tardif après un état terminal.
  const statusRef = useRef<Status>("confirm");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  // "Agent reconnecté…" ne doit s'afficher qu'une fois (sinon flood à chaque heartbeat).
  const reconnectNotedRef = useRef(false);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  // Auto-scroll du journal
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Timer d'écoulement + filet de sécurité timeout pendant le travail
  useEffect(() => {
    if (status !== "working") return;
    const iv = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(Math.floor(ms / 1000));
      if (ms > CLIENT_TIMEOUT_MS) {
        setStatus("failed");
        setResultMsg(
          "Délai dépassé : l'agent ne s'est pas reconnecté avec la nouvelle version. Vérifiez l'agent en SSH (panneau ci-dessous)."
        );
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [status]);

  const handleWs = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.machine_id !== machineId) return;
      // N'agir que pendant l'opération : ignore tout message tardif (machine.status
      // périodique, etc.) une fois en état terminal (success/failed).
      if (statusRef.current !== "working") return;
      if (msg.type === "agent.upgrade.progress") {
        const d = msg.data as ProgressMsg;
        if (d?.line) append(d.line);
        if (typeof d?.percent === "number") setPercent(d.percent);
        lastProgressAtRef.current = Date.now();
      } else if (msg.type === "machine.status" && msg.data?.status === "ONLINE") {
        // Reconnexion détectée — affichée une seule fois ; on attend la
        // confirmation de version (agent.upgrade.result) avant le succès.
        if (!reconnectNotedRef.current) {
          reconnectNotedRef.current = true;
          append("Agent reconnecté — vérification de la version…");
        }
      } else if (msg.type === "agent.upgrade.result") {
        const r = msg.data as ResultMsg;
        if (r?.success) {
          setPercent(100);
          setResultVersion(r.version ?? null);
          append(
            `✓ Agent à jour${r.version ? ` (version ${r.version})` : ""}${
              r.durationMs ? ` en ${Math.round(r.durationMs / 1000)}s` : ""
            }.`
          );
          setStatus("success");
          onSuccess?.();
        } else {
          append(`✗ Échec : ${r?.message || r?.reason || "raison inconnue"}`);
          setResultMsg(r?.message || "La mise à jour a échoué.");
          setStatus("failed");
        }
      }
    },
    [machineId, append, onSuccess]
  );

  useWebSocket({ onMessage: handleWs, enabled: status === "working" });

  const start = async () => {
    setStatus("working");
    setPercent(0);
    setLog(["Déclenchement de la mise à jour de l'agent…"]);
    setResultMsg("");
    reconnectNotedRef.current = false;
    startedAtRef.current = Date.now();
    lastProgressAtRef.current = Date.now();
    try {
      await api.upgradeAgent(machineId);
    } catch (err) {
      append(`✗ ${getErrorMessage(err, "Échec du déclenchement")}`);
      setResultMsg(getErrorMessage(err, "Échec du déclenchement de la mise à jour"));
      setStatus("failed");
    }
  };

  // Pendant le travail, on bloque la fermeture (modal persistant jusqu'à un
  // état terminal). Hors travail, fermeture normale.
  const guardedClose = status === "working" ? () => {} : onClose;

  // Libellé de phase pendant le travail
  const sinceProgress = Date.now() - lastProgressAtRef.current;
  const workingPhase =
    percent >= 90 || sinceProgress > 3000
      ? "Redémarrage et reconnexion de l'agent…"
      : "Mise à jour en cours…";

  return (
    <Dialog
      open
      onClose={guardedClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <ArrowUpCircle className="w-4 h-4 text-primary" />
          Mise à jour de l'agent — {machineName}
        </span>
      }
    >
      <div className="space-y-4">
        {/* ─── Confirmation ─── */}
        {status === "confirm" && (
          <p className="text-sm text-muted-foreground">
            L'agent va télécharger la dernière version servie par le serveur,
            remplacer son binaire puis redémarrer. La connexion est interrompue
            quelques secondes ; cette fenêtre suit l'opération jusqu'à la
            reconnexion en nouvelle version.
          </p>
        )}

        {/* ─── En cours ─── */}
        {status === "working" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span>{workingPhase}</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {elapsed}s
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {/* ─── Succès ─── */}
        {status === "success" && (
          <div className="flex items-center gap-2 rounded-lg px-4 py-3 text-sm bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>
              Agent à jour et reconnecté
              {resultVersion ? ` (version ${resultVersion})` : ""}.
            </span>
          </div>
        )}

        {/* ─── Échec ─── */}
        {status === "failed" && (
          <div className="flex items-start gap-2 rounded-lg px-4 py-3 text-sm bg-destructive/10 border border-destructive/20 text-destructive">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{resultMsg}</span>
          </div>
        )}

        {/* ─── Journal des événements ─── */}
        {log.length > 0 && (
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-black/90 text-emerald-300 p-3 max-h-48 overflow-y-auto">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            <div ref={logEndRef} />
          </pre>
        )}

        {/* ─── Panneau debug / SSH repliable ─── */}
        <DebugPanel
          open={showDebug}
          onToggle={() => setShowDebug((v) => !v)}
          ipAddress={ipAddress}
          sshUser={sshUser}
          onCloseDialog={onClose}
        />

        {/* ─── Actions ─── */}
        <div className="flex justify-end gap-2 pt-1">
          {status === "confirm" && (
            <>
              <Button variant="ghost" size="md" onClick={onClose}>
                Annuler
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={start}
                icon={<ArrowUpCircle />}
              >
                Mettre à jour
              </Button>
            </>
          )}
          {status === "working" && (
            <Button variant="ghost" size="md" disabled>
              Opération en cours…
            </Button>
          )}
          {status === "failed" && (
            <>
              <Button variant="ghost" size="md" onClick={onClose}>
                Fermer
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={start}
                icon={<RotateCcw />}
              >
                Réessayer
              </Button>
            </>
          )}
          {status === "success" && (
            <Button variant="primary" size="md" onClick={onClose}>
              Fermer
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/* ════════════════════════════════════════════
   Panneau debug repliable : SSH + commandes de diagnostic
   ════════════════════════════════════════════ */
function DebugPanel({
  open,
  onToggle,
  ipAddress,
  sshUser,
  onCloseDialog,
}: {
  open: boolean;
  onToggle: () => void;
  ipAddress?: string | null;
  sshUser?: string | null;
  onCloseDialog: () => void;
}) {
  const sshCmd = ipAddress
    ? sshUser
      ? `ssh ${sshUser}@${ipAddress}`
      : `ssh ${ipAddress}`
    : null;
  const sshUri = ipAddress
    ? sshUser
      ? `ssh://${sshUser}@${ipAddress}`
      : `ssh://${ipAddress}`
    : null;

  const debugCommands: { label: string; cmd: string }[] = [
    { label: "Statut du service", cmd: "sudo systemctl status nexus-agent" },
    {
      label: "100 dernières lignes de log",
      cmd: "sudo journalctl -u nexus-agent -n 100 --no-pager",
    },
    { label: "Suivre les logs en direct", cmd: "sudo journalctl -u nexus-agent -f" },
    {
      label: "SHA256 du binaire installé",
      cmd: "sha256sum /usr/local/bin/nexus-agent",
    },
    { label: "Forcer un redémarrage", cmd: "sudo systemctl restart nexus-agent" },
  ];

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <TerminalIcon className="w-3.5 h-3.5" />
        Debug & accès SSH
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          {/* Connexion SSH */}
          {sshCmd ? (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Connexion SSH
              </div>
              <CommandRow cmd={sshCmd} />
              {sshUri && (
                <a
                  href={sshUri}
                  className="inline-flex items-center gap-1.5 text-xs text-info hover:opacity-80"
                >
                  <ExternalLink className="w-3 h-3" /> Ouvrir dans le terminal
                </a>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Aucune IP connue pour cette machine —{" "}
              <Link
                to="/docs?section=ssh"
                className="underline text-info"
                onClick={onCloseDialog}
              >
                config SSH
              </Link>
              .
            </p>
          )}

          {/* Commandes de diagnostic */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Commandes de diagnostic
            </div>
            {debugCommands.map((c) => (
              <div key={c.cmd}>
                <div className="text-[10px] text-muted-foreground mb-0.5">
                  {c.label}
                </div>
                <CommandRow cmd={c.cmd} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CommandRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard indisponible */
    }
  };
  return (
    <div className="flex gap-2">
      <code className="flex-1 rounded border border-input bg-elevated px-2.5 py-1.5 text-[11px] font-mono truncate">
        {cmd}
      </code>
      <button
        onClick={copy}
        title="Copier"
        className="inline-flex items-center justify-center px-2 rounded border border-input hover:bg-muted transition-colors"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <Copy className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>
    </div>
  );
}
