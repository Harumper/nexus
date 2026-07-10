import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Gauge, RefreshCw, Download, Trash2, CheckCircle2, XCircle, Copy, Check } from "lucide-react";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { Dialog, Spinner } from "./ui";

interface Props {
  machineId: string;
  ip?: string | null;
  hostname?: string | null;
}

interface NodeExporterStatus {
  installed: boolean;
  active: boolean;
  port: number;
}

type Track = { action: "install" | "uninstall"; phase: "running" | "done" | "error"; message?: string };

// Metrics side of the Observability tab: install/status/uninstall of
// prometheus-node-exporter. Detailed system metrics are then scraped by
// Prometheus (via the http_sd targets endpoint) — not stored by Nexus.
export default function NodeExporterCard({ machineId, ip, hostname }: Props) {
  const { t } = useTranslation(["machineDetail", "common"]);
  const [status, setStatus] = useState<NodeExporterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "install" | "uninstall">(null);
  const [track, setTrack] = useState<Track | null>(null);

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
    setTrack({ action, phase: "running" });
    try {
      await api.dispatchActionSync(
        machineId,
        action === "install"
          ? "monitoring.install_node_exporter"
          : "monitoring.uninstall_node_exporter",
        {},
        120000
      );
      setTrack({ action, phase: "done" });
      await loadStatus();
    } catch (err) {
      setTrack({ action, phase: "error", message: getErrorMessage(err, t("nodeExporter.error")) });
    } finally {
      setBusy(null);
    }
  };

  const healthy = !!status?.installed && !!status?.active;

  // Prometheus scrape snippets. http_sd auto-discovers the whole fleet (add once);
  // the static block targets just this machine. The bearer file mirrors METRICS_TOKEN.
  const origin = window.location.origin;
  const httpSdSnippet = `  - job_name: 'nexus-node-exporter'
    http_sd_configs:
      - url: '${origin}/api/prometheus/targets'
        refresh_interval: 30s
        authorization:
          type: Bearer
          credentials_file: /etc/prometheus/nexus_metrics_token`;
  const staticSnippet = `  - job_name: 'node-${hostname || machineId}'
    static_configs:
      - targets: ['${ip}:9100']
        labels:
          machine_id: '${machineId}'
          hostname: '${hostname || ""}'`;

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

          {/* Prometheus scrape config — shown once the exporter is installed. */}
          {status?.installed && (
            <div className="mt-5 border-t border-border pt-4">
              <h4 className="text-xs font-semibold text-foreground mb-1">{t("nodeExporter.promTitle")}</h4>
              <p className="text-[11px] text-muted-foreground mb-3">{t("nodeExporter.promHint")}</p>
              <Snippet label={t("nodeExporter.promHttpSd")} code={httpSdSnippet} />
              {ip && <Snippet label={t("nodeExporter.promStatic")} code={staticSnippet} />}
            </div>
          )}
        </>
      )}

      {/* Tracking modal: spinner while the sync action runs, then result. */}
      {track && (
        <Dialog
          open
          onClose={() => track.phase !== "running" && setTrack(null)}
          size="sm"
          title={t(track.action === "install" ? "nodeExporter.trackInstallTitle" : "nodeExporter.trackUninstallTitle")}
          footer={
            track.phase !== "running" ? (
              <button
                onClick={() => setTrack(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("nodeExporter.close")}
              </button>
            ) : undefined
          }
        >
          <div className="flex items-center gap-3 text-sm">
            {track.phase === "running" && (
              <>
                <Spinner size="sm" />
                <span className="text-muted-foreground">{t("nodeExporter.trackRunning")}</span>
              </>
            )}
            {track.phase === "done" && (
              <>
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <span className="text-foreground">
                  {t(track.action === "install" ? "nodeExporter.installedOk" : "nodeExporter.uninstalledOk")}
                </span>
              </>
            )}
            {track.phase === "error" && (
              <>
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                <span className="text-foreground break-words">{track.message}</span>
              </>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

// Copyable YAML snippet with a small copy button.
function Snippet({ label, code }: { label: string; code: string }) {
  const { t } = useTranslation(["machineDetail"]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? t("nodeExporter.copied") : t("nodeExporter.copy")}
        </button>
      </div>
      <pre
        className="text-[11px] font-mono rounded-lg p-3 overflow-x-auto"
        style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", color: "var(--nx-text)" }}
      >
        {code}
      </pre>
    </div>
  );
}
