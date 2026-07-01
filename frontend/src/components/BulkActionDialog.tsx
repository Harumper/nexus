import { useState } from "react";
import { Play, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import type { Machine } from "../types";
import { Dialog, Button, Input } from "./ui";
import { getErrorMessage } from "../services/errors";

interface Props {
  machines: Machine[];
  onClose: () => void;
  onCompleted?: () => void;
}

// `key` = stable i18n key (label/description via t(`bulkActions.${key}.*`)).
// `confirmText` is the keyword TYPED by the user and compared as-is
// (handleRun) → NEVER externalize/translate it.
const BULK_ACTIONS: {
  id: string;
  key: string;
  paramsUI?: "service" | "package" | "script";
  destructive?: boolean;
  confirmText?: string;
}[] = [
  { id: "system.update", key: "systemUpdate" },
  { id: "system.update_security", key: "updateSecurity" },
  { id: "system.reboot", key: "reboot", destructive: true, confirmText: "REBOOT" },
  { id: "agent.upgrade", key: "agentUpgrade" },
  { id: "system.service_restart", key: "serviceRestart", paramsUI: "service" },
  { id: "system.service_start", key: "serviceStart", paramsUI: "service" },
  { id: "system.service_stop", key: "serviceStop", paramsUI: "service" },
  { id: "package.install", key: "packageInstall", paramsUI: "package" },
  { id: "package.remove", key: "packageRemove", paramsUI: "package", destructive: true },
  { id: "package.hold", key: "packageHold", paramsUI: "package" },
  { id: "package.unhold", key: "packageUnhold", paramsUI: "package" },
];

export default function BulkActionDialog({ machines, onClose, onCompleted }: Props) {
  const { t } = useTranslation(["bulkAction", "common"]);
  const [actionId, setActionId] = useState<string>("");
  const [paramValue, setParamValue] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<{ total: number; success: number; failed: number; skipped: number } | null>(null);

  const action = BULK_ACTIONS.find((a) => a.id === actionId);
  const onlineMachines = machines.filter((m) => m.status === "ONLINE");
  const critical = machines.filter((m) => m.isCritical);

  const handleRun = async () => {
    if (!action) return;
    if (action.confirmText && confirmInput !== action.confirmText) {
      toast.error(t("toasts.typeToConfirm", { word: action.confirmText }));
      return;
    }

    setRunning(true);
    try {
      const params: Record<string, unknown> = {};
      if (action.paramsUI === "service") {
        if (!paramValue) throw new Error(t("toasts.serviceRequired"));
        params.service = paramValue;
      } else if (action.paramsUI === "package") {
        if (!paramValue) throw new Error(t("toasts.packageRequired"));
        params.name = paramValue;
      }

      const res = await api.bulkDispatch({
        action_id: actionId,
        params,
        machineIds: machines.map((m) => m.id),
        mode: "sync",
        timeout: 60_000,
      });
      setResults(res.results);
      setSummary(res.summary);
      if (res.summary.failed === 0) {
        toast.success(t("toasts.allOk", { success: res.summary.success, total: res.summary.total }));
      } else {
        toast.error(t("toasts.someFailed", { failed: res.summary.failed, total: res.summary.total }));
      }
      if (onCompleted) onCompleted();
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open
      onClose={running ? () => {} : onClose}
      size="lg"
      title={
        <span>
          {t("title")}
          <span className="block text-xs font-normal text-muted-foreground mt-0.5">
            {t("machineCount", { count: machines.length })}
            {onlineMachines.length !== machines.length && t("onlineSuffix", { count: onlineMachines.length })}
          </span>
        </span>
      }
      footer={
        results === null ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose} disabled={running}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant={action?.destructive ? "danger" : "primary"}
              size="sm"
              onClick={handleRun}
              disabled={!action}
              loading={running}
              icon={<Play />}
            >
              {action?.destructive ? t("executeDestructive") : t("execute")}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={onClose}>
            {t("common:actions.close")}
          </Button>
        )
      }
    >
      {results === null && !running && (
        <div className="space-y-4">
          {critical.length > 0 && (
            <div className="rounded-lg p-3 text-xs flex items-start gap-2 bg-warning-subtle text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong>{t("criticalCount", { count: critical.length })}</strong>{" "}
                {t("criticalWarning", { names: critical.map((m) => m.name).join(", ") })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1.5">{t("actionLabel")}</label>
            <select
              value={actionId}
              onChange={(e) => {
                setActionId(e.target.value);
                setParamValue("");
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t("chooseAction")}</option>
              {BULK_ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {t(`bulkActions.${a.key}.label`)}
                </option>
              ))}
            </select>
            {action && (
              <p className="text-[11px] mt-1 text-muted-foreground">
                {t(`bulkActions.${action.key}.desc`)}
                {action.destructive && (
                  <span className="ml-2 font-semibold text-destructive">{t("destructiveBadge")}</span>
                )}
              </p>
            )}
          </div>

          {action?.paramsUI === "service" && (
            <div>
              <label className="block text-xs font-medium mb-1.5">
                {t("serviceLabel")}
              </label>
              <Input
                value={paramValue}
                onChange={(e) => setParamValue(e.target.value)}
                placeholder={t("servicePlaceholder")}
                className="font-mono"
              />
            </div>
          )}

          {action?.paramsUI === "package" && (
            <div>
              <label className="block text-xs font-medium mb-1.5">{t("packageLabel")}</label>
              <Input
                value={paramValue}
                onChange={(e) => setParamValue(e.target.value)}
                placeholder={t("packagePlaceholder")}
                className="font-mono"
              />
            </div>
          )}

          {action?.confirmText && (
            <div>
              <label className="block text-xs font-medium mb-1.5 text-destructive">
                <Trans i18nKey="typeToConfirmLabel" t={t} values={{ word: action.confirmText }} components={[<code key="0" className="font-mono" />]} />
              </label>
              <Input
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                className="font-mono"
              />
            </div>
          )}

          <div className="rounded-lg p-3 text-xs bg-elevated">
            <div className="font-medium mb-1">{t("targetsLabel")}</div>
            <div className="flex flex-wrap gap-1">
              {machines.slice(0, 20).map((m) => (
                <span
                  key={m.id}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    m.status === "ONLINE"
                      ? "bg-success-subtle text-success"
                      : "bg-background text-muted-foreground"
                  }`}
                >
                  {m.name}
                </span>
              ))}
              {machines.length > 20 && (
                <span className="text-[10px] text-muted-foreground">
                  {t("moreTargets", { count: machines.length - 20 })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {running && (
        <div className="py-12 text-center">
          <div className="inline-block w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3 motion-reduce:animate-none" />
          <div className="text-sm font-medium">{t("runningTitle")}</div>
          <div className="text-xs mt-1 text-muted-foreground">
            {t("runningDetail", { count: machines.length })}
          </div>
        </div>
      )}

      {results !== null && summary && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2 text-center">
            <StatCard label={t("stats.total")} value={summary.total} />
            <StatCard label={t("stats.success")} value={summary.success} tone="success" />
            <StatCard label={t("stats.failed")} value={summary.failed} tone="danger" />
            <StatCard label={t("stats.skipped")} value={summary.skipped} />
          </div>

          <div className="rounded-xl border border-border overflow-hidden bg-elevated">
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground">
                    <th className="text-left px-3 py-2">{t("resultHeaders.machine")}</th>
                    <th className="text-left px-3 py-2">{t("resultHeaders.status")}</th>
                    <th className="text-left px-3 py-2">{t("resultHeaders.detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.machineId} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono">{r.machineName}</td>
                      <td className="px-3 py-1.5">
                        {r.skipped ? (
                          <span className="text-muted-foreground">{t("skipped")}</span>
                        ) : r.success ? (
                          <span className="inline-flex items-center gap-1 text-success">
                            <Check className="w-3 h-3" /> OK
                          </span>
                        ) : (
                          <span className="text-destructive">{t("resultFailed")}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 truncate max-w-md text-muted-foreground">
                        {r.error || (r.data ? t("executed") : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  const colorClass =
    tone === "success" ? "text-success" : tone === "danger" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-lg p-3 bg-elevated">
      <div className={`text-xl font-bold tabular-nums ${colorClass}`}>{value}</div>
      <div className="text-[10px] uppercase mt-0.5 text-muted-foreground">{label}</div>
    </div>
  );
}
