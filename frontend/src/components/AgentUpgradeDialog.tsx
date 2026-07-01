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
import { Trans, useTranslation } from "react-i18next";
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
  /** Called when the agent is confirmed reconnected on the new version. */
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

// Client-side safety net: slightly beyond the backend timeout (180s).
const CLIENT_TIMEOUT_MS = 195_000;

export default function AgentUpgradeDialog({
  machineId,
  machineName,
  ipAddress,
  sshUser,
  onClose,
  onSuccess,
}: Props) {
  const { t } = useTranslation(["agentUpgrade", "common"]);
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
  // Current status accessible in the WS handler (stable closure): we only act
  // during "working" to ignore any late message after a terminal state.
  const statusRef = useRef<Status>("confirm");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  // "Agent reconnected…" must only display once (otherwise it floods on every heartbeat).
  const reconnectNotedRef = useRef(false);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
  }, []);

  // Auto-scroll the log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Elapsed-time timer + timeout safety net during the work
  useEffect(() => {
    if (status !== "working") return;
    const iv = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(Math.floor(ms / 1000));
      if (ms > CLIENT_TIMEOUT_MS) {
        setStatus("failed");
        setResultMsg(t("errors.timeout"));
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [status]);

  const handleWs = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.machine_id !== machineId) return;
      // Only act during the operation: ignore any late message (periodic
      // machine.status, etc.) once in a terminal state (success/failed).
      if (statusRef.current !== "working") return;
      if (msg.type === "agent.upgrade.progress") {
        const d = msg.data as ProgressMsg;
        if (d?.line) append(d.line);
        if (typeof d?.percent === "number") setPercent(d.percent);
        lastProgressAtRef.current = Date.now();
      } else if (msg.type === "machine.status" && msg.data?.status === "ONLINE") {
        // Reconnection detected — displayed only once; we wait for the
        // version confirmation (agent.upgrade.result) before success.
        if (!reconnectNotedRef.current) {
          reconnectNotedRef.current = true;
          append(t("log.reconnected"));
        }
      } else if (msg.type === "agent.upgrade.result") {
        const r = msg.data as ResultMsg;
        if (r?.success) {
          setPercent(100);
          setResultVersion(r.version ?? null);
          append(
            t("log.upToDate", {
              version: r.version ? t("versionFrag", { version: r.version }) : "",
              duration: r.durationMs ? t("log.durationFrag", { seconds: Math.round(r.durationMs / 1000) }) : "",
            })
          );
          setStatus("success");
          onSuccess?.();
        } else {
          append(t("log.failed", { reason: r?.message || r?.reason || t("log.unknownReason") }));
          setResultMsg(r?.message || t("errors.failMessage"));
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
    setLog([t("log.starting")]);
    setResultMsg("");
    reconnectNotedRef.current = false;
    startedAtRef.current = Date.now();
    lastProgressAtRef.current = Date.now();
    try {
      // Tolerate a transient disconnect (the agent may be in a short WS
      // reconnection window): we retry before failing.
      const maxAttempts = 4;
      for (let attempt = 1; ; attempt++) {
        try {
          await api.upgradeAgent(machineId);
          break;
        } catch (err) {
          const msg = getErrorMessage(err, t("errors.trigger"));
          const transient = /not connected|connect/i.test(msg);
          if (transient && attempt < maxAttempts) {
            append(
              t("log.retrying", { attempt, total: maxAttempts - 1 })
            );
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      append(t("log.triggerFail", { msg: getErrorMessage(err, t("errors.trigger")) }));
      setResultMsg(getErrorMessage(err, t("errors.triggerFull")));
      setStatus("failed");
    }
  };

  // During the work, we block closing (modal persists until a terminal
  // state). Outside of work, normal close.
  const guardedClose = status === "working" ? () => {} : onClose;

  // Phase label during the work
  const sinceProgress = Date.now() - lastProgressAtRef.current;
  const workingPhase =
    percent >= 90 || sinceProgress > 3000
      ? t("phaseRestarting")
      : t("phaseUpdating");

  return (
    <Dialog
      open
      onClose={guardedClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <ArrowUpCircle className="w-4 h-4 text-primary" />
          {t("title", { name: machineName })}
        </span>
      }
    >
      <div className="space-y-4">
        {/* ─── Confirmation ─── */}
        {status === "confirm" && (
          <>
            <p className="text-sm text-muted-foreground">
              {t("confirmDesc")}
            </p>
            <p className="text-xs rounded-lg border border-border bg-elevated px-3 py-2 text-muted-foreground">
              <Trans i18nKey="confirmWarning" t={t} components={[<strong key="0" />, <code key="1" />, <strong key="2" />, <code key="3" />]} />
            </p>
          </>
        )}

        {/* ─── In progress ─── */}
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

        {/* ─── Success ─── */}
        {status === "success" && (
          <div className="flex items-center gap-2 rounded-lg px-4 py-3 text-sm bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>
              {t("successText", { version: resultVersion ? t("versionFrag", { version: resultVersion }) : "" })}
            </span>
          </div>
        )}

        {/* ─── Failure ─── */}
        {status === "failed" && (
          <div className="flex items-start gap-2 rounded-lg px-4 py-3 text-sm bg-destructive/10 border border-destructive/20 text-destructive">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{resultMsg}</span>
          </div>
        )}

        {/* ─── Event log ─── */}
        {log.length > 0 && (
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-black/90 text-emerald-300 p-3 max-h-48 overflow-y-auto">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            <div ref={logEndRef} />
          </pre>
        )}

        {/* ─── Collapsible debug / SSH panel ─── */}
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
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={start}
                icon={<ArrowUpCircle />}
              >
                {t("update")}
              </Button>
            </>
          )}
          {status === "working" && (
            <Button variant="ghost" size="md" disabled>
              {t("working")}
            </Button>
          )}
          {status === "failed" && (
            <>
              <Button variant="ghost" size="md" onClick={onClose}>
                {t("common:actions.close")}
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={start}
                icon={<RotateCcw />}
              >
                {t("common:actions.retry")}
              </Button>
            </>
          )}
          {status === "success" && (
            <Button variant="primary" size="md" onClick={onClose}>
              {t("common:actions.close")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/* ════════════════════════════════════════════
   Collapsible debug panel: SSH + diagnostic commands
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
  const { t } = useTranslation(["agentUpgrade", "common"]);
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
    { label: t("debug.cmdStatus"), cmd: "sudo systemctl status nexus-agent" },
    {
      label: t("debug.cmdLogs"),
      cmd: "sudo journalctl -u nexus-agent -n 100 --no-pager",
    },
    { label: t("debug.cmdFollow"), cmd: "sudo journalctl -u nexus-agent -f" },
    {
      label: t("debug.cmdSha"),
      cmd: "sha256sum /usr/local/bin/nexus-agent",
    },
    { label: t("debug.cmdRestart"), cmd: "sudo systemctl restart nexus-agent" },
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
        {t("debug.title")}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          {/* SSH connection */}
          {sshCmd ? (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("debug.sshConnection")}
              </div>
              <CommandRow cmd={sshCmd} />
              {sshUri && (
                <a
                  href={sshUri}
                  className="inline-flex items-center gap-1.5 text-xs text-info hover:opacity-80"
                >
                  <ExternalLink className="w-3 h-3" /> {t("debug.openInTerminal")}
                </a>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              <Trans
                i18nKey="debug.noIp"
                t={t}
                components={[
                  <Link key="0" to="/docs?section=ssh" className="underline text-info" onClick={onCloseDialog} />,
                ]}
              />
            </p>
          )}

          {/* Diagnostic commands */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("debug.diagnostics")}
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
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="flex gap-2">
      <code className="flex-1 rounded border border-input bg-elevated px-2.5 py-1.5 text-[11px] font-mono truncate">
        {cmd}
      </code>
      <button
        onClick={copy}
        title={t("actions.copy")}
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
