import { useState, useEffect, useCallback } from "react";
import {
  ScrollText,
  Search,
  ChevronLeft,
  ChevronRight,
  Filter,
  Server,
  User as UserIcon,
  Shield,
  Key,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { timeAgo, formatDateTime } from "../lib/format";
import { Spinner } from "../components/ui";

interface AuditEntry {
  id: string;
  action: string;
  resource: string;
  resourceId: string | null;
  details: any;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; username: string } | null;
  machine: { id: string; name: string } | null;
}

// Visual metadata per action type (icon/color). The label is
// resolved via i18n: t(`actions.${ACTION}`) with a fallback to the raw code.
const ACTION_META: Record<string, { icon: typeof Activity; color: string }> = {
  LOGIN: { icon: UserIcon, color: "text-blue-400" },
  LOGOUT: { icon: UserIcon, color: "text-zinc-400" },
  MACHINE_CREATE: { icon: Server, color: "text-emerald-400" },
  MACHINE_DELETE: { icon: Server, color: "text-red-400" },
  MACHINE_ENROLL: { icon: Key, color: "text-primary" },
  MACHINE_REVOKE: { icon: Shield, color: "text-red-400" },
  ACTION_REQUEST: { icon: Activity, color: "text-amber-400" },
  ACTION_COMPLETE: { icon: Activity, color: "text-emerald-400" },
  ACTION_FAILED: { icon: Activity, color: "text-red-400" },
  CAPABILITY_GRANT: { icon: Shield, color: "text-emerald-400" },
  CAPABILITY_REVOKE: { icon: Shield, color: "text-amber-400" },
  ALERT_TRIGGERED: { icon: AlertTriangle, color: "text-red-400" },
  ALERT_RESOLVED: { icon: AlertTriangle, color: "text-emerald-400" },
  SECURITY_ALERT: { icon: Shield, color: "text-red-400" },
  CERT_ROTATE: { icon: Key, color: "text-blue-400" },
  CERT_REVOKE: { icon: Key, color: "text-red-400" },
};

const PAGE_SIZE = 50;

export default function AuditLog() {
  const { t } = useTranslation(["audit", "common"]);
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [selectedLog, setSelectedLog] = useState<AuditEntry | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (actionFilter) params.set("action", actionFilter);
      if (search) params.set("search", search);

      const res = await fetch(`/api/audit?${params}`, {
        headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
      });
      const data = await res.json();
      setLogs(data.logs);
      setTotal(data.total);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [page, actionFilter, search]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const uniqueActions = Object.keys(ACTION_META);
  const actionLabel = (action: string) => t(`actions.${action}`, { defaultValue: action });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("common:nav.audit")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("count", { count: total })}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder={t("searchPlaceholder")}
            className="w-full rounded-lg border border-input bg-background pl-10 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <select
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(0);
            }}
            className="rounded-lg border border-input bg-background pl-10 pr-8 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring appearance-none"
          >
            <option value="">{t("allActions")}</option>
            {uniqueActions.map((action) => (
              <option key={action} value={action}>
                {actionLabel(action)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size="lg" className="text-primary" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <ScrollText className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p>{t("empty")}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">{t("headers.action")}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">{t("headers.machine")}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">{t("headers.user")}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">{t("headers.ip")}</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase">{t("headers.date")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const actionInfo = ACTION_META[log.action] || {
                  icon: Activity,
                  color: "text-muted-foreground",
                };
                const Icon = actionInfo.icon;

                return (
                  <tr
                    key={log.id}
                    onClick={() => setSelectedLog(log)}
                    className="border-b border-border/50 hover:bg-muted/20 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Icon className={`w-4 h-4 ${actionInfo.color}`} />
                        <span className="text-sm text-foreground">
                          {actionLabel(log.action)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {log.machine?.name || "—"}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {log.user?.username || t("system")}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                      {log.ipAddress || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground text-right">
                      {timeAgo(log.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-muted-foreground">
            {t("pagination", { page: page + 1, total: totalPages })}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSelectedLog(null)} />
          <div className="relative w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl p-6">
            <h3 className="text-lg font-semibold text-foreground mb-4">
              {t("detailTitle")}
            </h3>
            <div className="space-y-3">
              <DetailRow label={t("detail.action")} value={actionLabel(selectedLog.action)} />
              <DetailRow label={t("detail.resource")} value={`${selectedLog.resource} ${selectedLog.resourceId || ""}`} />
              <DetailRow label={t("detail.machine")} value={selectedLog.machine?.name || "—"} />
              <DetailRow label={t("detail.user")} value={selectedLog.user?.username || t("system")} />
              <DetailRow label={t("detail.ip")} value={selectedLog.ipAddress || "—"} />
              <DetailRow label={t("detail.date")} value={formatDateTime(selectedLog.createdAt)} />
              {selectedLog.details && (
                <div>
                  <span className="text-xs text-muted-foreground">{t("detail.details")}</span>
                  <pre className="mt-1 rounded-lg bg-muted p-3 text-xs text-foreground overflow-x-auto">
                    {JSON.stringify(selectedLog.details, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <button
              onClick={() => setSelectedLog(null)}
              className="w-full mt-4 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {t("common:actions.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}
