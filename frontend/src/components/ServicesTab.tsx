import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Play, Square, RotateCcw, FileText, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api } from "../services/api";
import { useConfirm } from "./ui";
import { getErrorMessage } from "../services/errors";

interface SystemdUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

type StateFilter = "all" | "active" | "inactive" | "failed";

interface ServicesTabProps {
  machineId: string;
  onViewLogs?: (service: string) => void;
  /** Filter requested from outside (e.g. click on "failed services" in
   * AttentionPanel). One-shot: applied on receipt and then
   * onPendingFilterConsumed is called to nullify it, so the user can
   * subsequently change the filter freely. */
  pendingFilter?: StateFilter | null;
  onPendingFilterConsumed?: () => void;
}

type ActionKind = "start" | "stop" | "restart";

export default function ServicesTab({ machineId, onViewLogs, pendingFilter, onPendingFilterConsumed }: ServicesTabProps) {
  const { t } = useTranslation(["services", "common"]);
  const [services, setServices] = useState<SystemdUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>(pendingFilter ?? "all");

  useEffect(() => {
    if (pendingFilter) {
      setStateFilter(pendingFilter);
      onPendingFilterConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFilter]);
  const [actingOn, setActingOn] = useState<{ service: string; action: ActionKind } | null>(null);
  const { confirm, ConfirmDialogElement } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listServices(machineId);
      const list = (res?.data?.services || []) as SystemdUnit[];
      // Keep only .service units
      const filtered = list.filter(u => (u.unit || "").endsWith(".service"));
      setServices(filtered);
    } catch (err) {
      setError(getErrorMessage(err, t("common:errors.loadError")));
    } finally {
      setLoading(false);
    }
  }, [machineId, t]);

  useEffect(() => { load(); }, [load]);

  const handleAction = async (service: string, action: ActionKind) => {
    const verb = t(`common:actions.${action}`);
    if (!(await confirm({ title: t("confirmAction", { verb, service }), confirmLabel: verb, variant: action === "stop" ? "danger" : "primary" }))) return;
    setActingOn({ service, action });
    try {
      await api.serviceAction(machineId, service, action);
      toast.success(t("toastOk", { service, verb: verb.toLowerCase() }));
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.actionFailed")));
    } finally {
      setActingOn(null);
    }
  };

  const filtered = services.filter(s => {
    if (search && !s.unit.toLowerCase().includes(search.toLowerCase()) &&
        !(s.description || "").toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    if (stateFilter !== "all") {
      if (stateFilter === "failed" && s.active !== "failed") return false;
      if (stateFilter === "active" && s.active !== "active") return false;
      if (stateFilter === "inactive" && s.active !== "inactive") return false;
    }
    return true;
  });

  const stateColor = (active: string) => {
    switch (active) {
      case "active": return "var(--nx-success)";
      case "failed": return "var(--nx-danger)";
      case "inactive": return "var(--nx-text-weak)";
      default: return "var(--nx-warning)";
    }
  };

  return (
    <div className="space-y-4">
      {/* Header + filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--nx-text-weak)" }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full rounded-lg border border-input bg-background pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as any)}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">{t("filter.all")}</option>
          <option value="active">{t("filter.active")}</option>
          <option value="inactive">{t("filter.inactive")}</option>
          <option value="failed">{t("filter.failed")}</option>
        </select>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          {t("common:actions.refresh")}
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="flex gap-4 text-xs">
        <span style={{ color: "var(--nx-text-weak)" }}>
          {t("stats.total", { count: services.length })}
        </span>
        <span style={{ color: "var(--nx-success)" }}>
          {t("stats.active", { count: services.filter(s => s.active === "active").length })}
        </span>
        <span style={{ color: "var(--nx-danger)" }}>
          {t("stats.failed", { count: services.filter(s => s.active === "failed").length })}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
        <table className="w-full text-sm">
          <thead style={{ background: "var(--nx-bg-elevated)" }}>
            <tr className="text-xs uppercase" style={{ color: "var(--nx-text-weak)" }}>
              <th className="px-4 py-2 text-left">{t("headers.service")}</th>
              <th className="px-4 py-2 text-left">{t("headers.state")}</th>
              <th className="px-4 py-2 text-left">{t("headers.description")}</th>
              <th className="px-4 py-2 text-right">{t("headers.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm" style={{ color: "var(--nx-text-weak)" }}>
                  {t("empty")}
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr key={s.unit} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                  <td className="px-4 py-2 font-mono text-xs">{s.unit}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full" style={{ background: stateColor(s.active) }} />
                      {s.active} / {s.sub}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs truncate max-w-[300px]" style={{ color: "var(--nx-text-weak)" }}>
                    {s.description}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1 justify-end">
                      {onViewLogs && (
                        <button
                          onClick={() => onViewLogs(s.unit)}
                          className="p-1.5 rounded hover:bg-muted transition-colors"
                          title={t("viewLogs")}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {s.active !== "active" && (
                        <button
                          onClick={() => handleAction(s.unit, "start")}
                          disabled={actingOn?.service === s.unit}
                          className="p-1.5 rounded hover:bg-muted transition-colors"
                          title={t("common:actions.start")}
                          style={{ color: "var(--nx-success)" }}
                        >
                          {actingOn?.service === s.unit && actingOn.action === "start" ?
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                            <Play className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {s.active === "active" && (
                        <>
                          <button
                            onClick={() => handleAction(s.unit, "restart")}
                            disabled={actingOn?.service === s.unit}
                            className="p-1.5 rounded hover:bg-muted transition-colors"
                            title={t("common:actions.restart")}
                            style={{ color: "var(--nx-info)" }}
                          >
                            {actingOn?.service === s.unit && actingOn.action === "restart" ?
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                              <RotateCcw className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => handleAction(s.unit, "stop")}
                            disabled={actingOn?.service === s.unit}
                            className="p-1.5 rounded hover:bg-muted transition-colors"
                            title={t("common:actions.stop")}
                            style={{ color: "var(--nx-warning)" }}
                          >
                            {actingOn?.service === s.unit && actingOn.action === "stop" ?
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                              <Square className="w-3.5 h-3.5" />}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {ConfirmDialogElement}
    </div>
  );
}
