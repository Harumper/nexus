import { useState, useCallback } from "react";
import { X, Download, Shield, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWebSocket } from "../hooks/useWebSocket";
import type { Machine, WSDashboardMessage } from "../types";

interface Props {
  machines: Machine[];
  onClose: () => void;
}

interface MachineProgress {
  status: "pending" | "updating" | "success" | "error";
  percent: number;
  line: string;
}

export default function BatchUpdateDialog({ machines, onClose }: Props) {
  const { t } = useTranslation(["batchUpdate", "common"]);
  const [running, setRunning] = useState(false);
  const [securityOnly, setSecurityOnly] = useState(false);
  const [progress, setProgress] = useState<Record<string, MachineProgress>>({});
  const [result, setResult] = useState<{
    dispatched: number;
    failed: number;
  } | null>(null);

  const onlineMachines = machines.filter((m) => m.status === "ONLINE");

  // WebSocket for streaming
  const handleWsMessage = useCallback((msg: WSDashboardMessage) => {
    if (msg.type === "update.progress" && msg.machine_id) {
      setProgress((prev) => ({
        ...prev,
        [msg.machine_id!]: {
          status: msg.data?.percent === 100 ? "success" : "updating",
          percent: msg.data?.percent || 0,
          line: msg.data?.line || "",
        },
      }));
    }
  }, []);

  useWebSocket({ onMessage: handleWsMessage, enabled: running });

  const startBatch = async () => {
    setRunning(true);
    setResult(null);

    // Initialize progress
    const initial: Record<string, MachineProgress> = {};
    for (const m of onlineMachines) {
      initial[m.id] = { status: "pending", percent: 0, line: t("pending") };
    }
    setProgress(initial);

    try {
      const response = await fetch("/api/machines/actions/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}`,
        },
        body: JSON.stringify({
          action_id: securityOnly ? "system.update_security" : "system.update",
          machine_ids: onlineMachines.map((m) => m.id),
        }),
      });

      const data = await response.json();
      setResult({
        dispatched: data.dispatched || 0,
        failed: data.failed || 0,
      });

      // Mark the failures
      if (data.results?.failed) {
        for (const f of data.results.failed) {
          setProgress((prev) => ({
            ...prev,
            [f.machineId]: {
              status: "error",
              percent: 0,
              line: f.error,
            },
          }));
        }
      }
    } catch (err) {
      setResult({ dispatched: 0, failed: onlineMachines.length });
    }
  };

  const allDone =
    running &&
    Object.values(progress).every(
      (p) => p.status === "success" || p.status === "error"
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold text-foreground">
            {t("title")}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {!running ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t("eligibleCount", { count: onlineMachines.length })}
              </p>

              <div className="space-y-2 max-h-48 overflow-y-auto">
                {onlineMachines.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted"
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span className="text-sm text-foreground">{m.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.hostname}
                    </span>
                  </div>
                ))}
              </div>

              {onlineMachines.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {t("noEligible")}
                </div>
              )}

              {/* Options */}
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={securityOnly}
                    onChange={(e) => setSecurityOnly(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span className="text-sm text-foreground">
                    {t("securityOnly")}
                  </span>
                </label>
              </div>
            </>
          ) : (
            <>
              {/* Per-machine progress */}
              <div className="space-y-3">
                {onlineMachines.map((m) => {
                  const p = progress[m.id];
                  return (
                    <div key={m.id} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {p?.status === "success" && (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          )}
                          {p?.status === "error" && (
                            <XCircle className="w-4 h-4 text-destructive" />
                          )}
                          {p?.status === "updating" && (
                            <Loader2 className="w-4 h-4 text-primary animate-spin" />
                          )}
                          {p?.status === "pending" && (
                            <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/30" />
                          )}
                          <span className="text-sm font-medium text-foreground">
                            {m.name}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {p?.percent || 0}%
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            p?.status === "error"
                              ? "bg-destructive"
                              : p?.status === "success"
                                ? "bg-emerald-500"
                                : "bg-primary"
                          }`}
                          style={{ width: `${p?.percent || 0}%` }}
                        />
                      </div>
                      {p?.line && (
                        <p className="text-[10px] text-muted-foreground truncate">
                          {p.line}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {result && (
                <div className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
                  {t("result", { dispatched: result.dispatched, failed: result.failed })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border shrink-0 flex gap-3">
          {!running ? (
            <>
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                {t("common:actions.cancel")}
              </button>
              <button
                onClick={startBatch}
                disabled={onlineMachines.length === 0}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {securityOnly ? (
                  <Shield className="w-4 h-4" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                {t("start")}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              disabled={!allDone}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {allDone ? t("common:actions.close") : t("inProgress")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
