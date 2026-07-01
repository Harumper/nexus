import { useState, useCallback, useRef, useEffect } from "react";
import { ShieldCheck, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useWebSocket } from "../hooks/useWebSocket";
import { Dialog, Button } from "./ui";
import type { WSDashboardMessage, SecurityAuditResult } from "../types";

interface Props {
  machineId: string;
  machineName?: string;
  onClose: () => void;
  /** Called when the audit returns its result (to refresh the tab). */
  onResult: (data: SecurityAuditResult) => void;
}

type Status = "working" | "success" | "failed";

// Safety net: a bit beyond the backend timeout.
const CLIENT_TIMEOUT_MS = 195_000;

// Strips ANSI sequences (colors AND cursor movements). lynis
// --no-colors removes colors but not the `\x1b[<n>C` alignment of
// `[ FOUND ]`, which showed up as "[38C" in the console.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\u009b]\[[0-9;?]*[ -\/]*[@-~]/g;
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(ANSI_RE, "").replace(/[\r]/g, "");
}

// Lynis audit progress modal (like the agent update): progress bar + shell
// output streamed live (WebSocket), until the result arrives.
export default function SecurityAuditDialog({ machineId, machineName, onClose, onResult }: Props) {
  const { t } = useTranslation(["security", "common"]);
  const [status, setStatus] = useState<Status>("working");
  const [percent, setPercent] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const startedAtRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<Status>("working");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const append = useCallback((line: string) => setLog((prev) => [...prev.slice(-500), stripAnsi(line)]), []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Timer + timeout safety net during the work.
  useEffect(() => {
    if (status !== "working") return;
    const iv = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(Math.floor(ms / 1000));
      if (ms > CLIENT_TIMEOUT_MS) {
        setStatus("failed");
        setErrorMsg(t("auditDialog.timeout"));
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [status]);

  const handleWs = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.machine_id !== machineId || statusRef.current !== "working") return;
      if (msg.type === "security.audit.progress") {
        const d = msg.data as { line?: string; percent?: number };
        if (d?.line) append(d.line);
        if (typeof d?.percent === "number") setPercent(d.percent);
      } else if (msg.type === "security.audit.result") {
        const data = msg.data as SecurityAuditResult;
        setPercent(100);
        setScore(typeof data.hardening_index === "number" ? data.hardening_index : null);
        append(
          t("auditDialog.resultLine", {
            index: data.hardening_index >= 0 ? `${data.hardening_index}/100` : "n/a",
            warnings: data.warning_count,
            suggestions: data.suggestion_count,
          })
        );
        setStatus("success");
        onResult(data);
      }
    },
    [machineId, append, onResult]
  );

  useWebSocket({ onMessage: handleWs, enabled: status === "working" });

  // Start the audit on mount (the dispatch is async: the rest arrives via WS).
  useEffect(() => {
    startedAtRef.current = Date.now();
    setLog([t("auditDialog.starting")]);
    api.securityAudit(machineId).catch((err) => {
      append(`✗ ${getErrorMessage(err, t("auditDialog.startError"))}`);
      setErrorMsg(getErrorMessage(err, t("auditDialog.launchError")));
      setStatus("failed");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modal persists during the work (no accidental close).
  const guardedClose = status === "working" ? () => {} : onClose;

  const scoreColor =
    score === null ? "var(--nx-text-weak)" : score >= 70 ? "var(--nx-success)" : score >= 50 ? "var(--nx-warning)" : "var(--nx-danger)";

  return (
    <Dialog
      open
      onClose={guardedClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" style={{ color: "var(--nx-accent)" }} />
          {machineName ? t("auditDialog.titleWithName", { name: machineName }) : t("auditDialog.title")}
        </span>
      }
    >
      <div className="space-y-4">
        {status === "working" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--nx-accent)" }} />
              <span>{t("auditDialog.analyzing")}</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">{elapsed}s</span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${percent}%`, background: "var(--nx-accent)" }}
              />
            </div>
          </div>
        )}

        {status === "success" && (
          <div className="flex items-center gap-3 rounded-lg px-4 py-3 text-sm bg-emerald-500/10 border border-emerald-500/20">
            <CheckCircle2 className="w-5 h-5 shrink-0" style={{ color: "var(--nx-success)" }} />
            <span className="text-foreground">
              <Trans
                i18nKey="auditDialog.successText"
                t={t}
                values={{ score: score === null ? "n/a" : `${score}/100` }}
                components={[<strong key="0" className="tabular-nums" style={{ color: scoreColor }} />]}
              />
            </span>
          </div>
        )}

        {status === "failed" && (
          <div className="flex items-start gap-2 rounded-lg px-4 py-3 text-sm bg-destructive/10 border border-destructive/20 text-destructive">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Streamed shell output */}
        {log.length > 0 && (
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-black/90 text-emerald-300 p-3 max-h-72 overflow-y-auto">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            <div ref={logEndRef} />
          </pre>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {status === "working" && (
            <Button variant="ghost" size="md" disabled>
              {t("auditDialog.working")}
            </Button>
          )}
          {status !== "working" && (
            <Button variant="primary" size="md" onClick={onClose}>
              {t("common:actions.close")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
