import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Gauge, RefreshCw, Download, Trash2 } from "lucide-react";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";

interface Props {
  machineId: string;
}

interface NodeExporterStatus {
  installed: boolean;
  active: boolean;
  port: number;
}

// Metrics side of the Observability tab: install/status/uninstall of
// prometheus-node-exporter. Detailed system metrics are then scraped by
// Prometheus (via the http_sd targets endpoint) — not stored by Nexus.
export default function NodeExporterCard({ machineId }: Props) {
  const { t } = useTranslation(["machineDetail", "common"]);
  const [status, setStatus] = useState<NodeExporterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "install" | "uninstall">(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await api.dispatchActionSync<NodeExporterStatus>(
        machineId,
        "monitoring.node_exporter_status"
      );
      setStatus(res.data);
    } catch {
      setStatus(null); // best-effort; the agent may be busy
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const run = async (action: "install" | "uninstall") => {
    setBusy(action);
    try {
      await api.dispatchActionSync(
        machineId,
        action === "install"
          ? "monitoring.install_node_exporter"
          : "monitoring.uninstall_node_exporter",
        {},
        120000
      );
      toast.success(t(action === "install" ? "nodeExporter.installedOk" : "nodeExporter.uninstalledOk"));
      await loadStatus();
    } catch (err) {
      toast.error(getErrorMessage(err, t("nodeExporter.error")));
    } finally {
      setBusy(null);
    }
  };

  const healthy = !!status?.installed && !!status?.active;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Gauge className="w-4 h-4" /> {t("nodeExporter.title")}
        </h3>
        <button
          onClick={loadStatus}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title={t("common:actions.refresh")}
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">{t("nodeExporter.description")}</p>

      {loading ? (
        <div className="text-xs text-muted-foreground">…</div>
      ) : (
        <>
          <div className="flex items-center gap-3 text-sm mb-4">
            <span className={`w-2 h-2 rounded-full ${healthy ? "bg-emerald-400" : "bg-muted-foreground"}`} />
            <span className="text-foreground">
              {status?.installed
                ? healthy
                  ? t("nodeExporter.running", { port: status.port })
                  : t("nodeExporter.installedInactive")
                : t("nodeExporter.notInstalled")}
            </span>
          </div>
          <div className="flex gap-2">
            {!healthy && (
              <button
                disabled={busy !== null}
                onClick={() => run("install")}
                className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                {busy === "install" ? t("nodeExporter.installing") : t("nodeExporter.install")}
              </button>
            )}
            {status?.installed && (
              <button
                disabled={busy !== null}
                onClick={() => run("uninstall")}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {busy === "uninstall" ? t("nodeExporter.uninstalling") : t("nodeExporter.uninstall")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
