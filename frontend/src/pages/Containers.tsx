import { useState, useEffect, useCallback } from "react";
import { formatBytes as fmtBytes } from "../lib/format";
import { Container, RefreshCw, Loader2, Server, AlertTriangle, Cpu, MemoryStick, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";

interface NautilusServer {
  id: string;
  name: string;
  up: boolean;
  agentVersion: string | null;
  boundIp: string | null;
  lastPingAt: string | null;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  cpuCores: number | null;
  networkRxRate: number | null;
  networkTxRate: number | null;
  containerCounts: Record<string, number>;
}

interface NautilusContainer {
  serverId: string;
  serverName: string;
  name: string;
  containerId: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxRate: number | null;
  networkTxRate: number | null;
  pids: number;
}

// Shows "—" for empty/0, otherwise delegates to the central locale-aware format.
function formatBytes(n: number): string {
  if (!n || n <= 0) return "—";
  return fmtBytes(n);
}

function formatRate(n: number | null): string {
  if (n === null || n === 0) return "—";
  return `${formatBytes(n)}/s`;
}

export default function Containers() {
  const { t } = useTranslation(["containers", "common"]);
  const [snapshot, setSnapshot] = useState<{
    servers: NautilusServer[];
    containers: NautilusContainer[];
    meta: { totalServers: number; activeServers: number; scrapeSuccess: boolean };
    scrapedAt: string;
    scrapeDurationMs: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.getNautilusSnapshot();
      setSnapshot(res);
    } catch (err) {
      setError(getErrorMessage(err, t("common:errors.generic")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    // Auto-refresh every 15s
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Container className="w-6 h-6" /> {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("subtitle")}
            {snapshot && t("subtitleStats", {
              active: snapshot.meta.activeServers,
              total: snapshot.meta.totalServers,
              ms: snapshot.scrapeDurationMs,
            })}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
          style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t("common:actions.refresh")}
        </button>
      </div>

      {error && (
        <div className="rounded-lg px-4 py-3 text-sm mb-4" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          <AlertTriangle className="w-4 h-4 inline mr-2" />
          {error}
          <div className="text-xs mt-2" style={{ color: "var(--nx-text-weak)" }}>
            {t("errorHint")}
          </div>
        </div>
      )}

      {!snapshot && !error && !loading && (
        <div className="rounded-xl border border-border p-8 text-center" style={{ background: "var(--nx-bg-surface)" }}>
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" style={{ color: "var(--nx-text-weak)" }} />
          <p className="text-sm" style={{ color: "var(--nx-text-weak)" }}>{t("common:status.loading")}</p>
        </div>
      )}

      {snapshot && snapshot.servers.length === 0 && (
        <div className="rounded-xl border border-border p-8 text-center" style={{ background: "var(--nx-bg-surface)" }}>
          <Server className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm" style={{ color: "var(--nx-text-weak)" }}>
            {t("emptyServers")}
          </p>
        </div>
      )}

      {snapshot && snapshot.servers.length > 0 && (
        <>
          {/* Servers grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {snapshot.servers.map((server) => (
              <ServerCard key={server.id} server={server} />
            ))}
          </div>

          {/* Top containers table */}
          {snapshot.containers.length > 0 && (
            <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t("tableTitle")}</h2>
                <span className="text-xs" style={{ color: "var(--nx-text-weak)" }}>
                  {t("containerCount", { count: snapshot.containers.length })}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead style={{ background: "var(--nx-bg-elevated)" }}>
                    <tr className="text-left" style={{ color: "var(--nx-text-weak)" }}>
                      <th className="px-3 py-2 font-medium">{t("headers.container")}</th>
                      <th className="px-3 py-2 font-medium">{t("headers.server")}</th>
                      <th className="px-3 py-2 font-medium text-right">{t("headers.cpu")}</th>
                      <th className="px-3 py-2 font-medium text-right">{t("headers.ram")}</th>
                      <th className="px-3 py-2 font-medium text-right">{t("headers.rx")}</th>
                      <th className="px-3 py-2 font-medium text-right">{t("headers.tx")}</th>
                      <th className="px-3 py-2 font-medium text-right">{t("headers.pids")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.containers.map((c) => (
                      <tr key={`${c.serverId}-${c.containerId}`} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                        <td className="px-3 py-1.5 font-mono">{c.name}</td>
                        <td className="px-3 py-1.5" style={{ color: "var(--nx-text-weak)" }}>{c.serverName}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                          <span style={{ color: cpuColor(c.cpuPercent) }}>{c.cpuPercent.toFixed(1)}%</span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                          {formatBytes(c.memoryUsedBytes)}
                          {c.memoryLimitBytes > 0 && (
                            <span style={{ color: "var(--nx-text-weak)" }}> / {formatBytes(c.memoryLimitBytes)}</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{formatRate(c.networkRxRate)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{formatRate(c.networkTxRate)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{c.pids}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ServerCard({ server }: { server: NautilusServer }) {
  const { t } = useTranslation("containers");
  const running = server.containerCounts.running || 0;
  const stopped = (server.containerCounts.exited || 0) + (server.containerCounts.dead || 0);
  const other = Object.entries(server.containerCounts)
    .filter(([k]) => !["running", "exited", "dead"].includes(k))
    .reduce((sum, [, v]) => sum + v, 0);

  return (
    <div className="rounded-xl border border-border p-4" style={{ background: "var(--nx-bg-surface)" }}>
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${server.up ? "bg-emerald-400" : "bg-red-400"}`} />
            <h3 className="text-sm font-semibold truncate">{server.name}</h3>
          </div>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
            {server.boundIp || "—"}{server.agentVersion ? ` · v${server.agentVersion}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        <div className="rounded-lg py-1.5" style={{ background: "var(--nx-success-subtle)" }}>
          <div className="text-lg font-bold tabular-nums" style={{ color: "var(--nx-success)" }}>{running}</div>
          <div className="text-[9px] uppercase" style={{ color: "var(--nx-text-weak)" }}>{t("states.running")}</div>
        </div>
        <div className="rounded-lg py-1.5" style={{ background: "var(--nx-bg-elevated)" }}>
          <div className="text-lg font-bold tabular-nums" style={{ color: "var(--nx-text-weak)" }}>{stopped}</div>
          <div className="text-[9px] uppercase" style={{ color: "var(--nx-text-weak)" }}>{t("states.stopped")}</div>
        </div>
        <div className="rounded-lg py-1.5" style={{ background: other > 0 ? "var(--nx-warning-subtle)" : "var(--nx-bg-elevated)" }}>
          <div className="text-lg font-bold tabular-nums" style={{ color: other > 0 ? "var(--nx-warning)" : "var(--nx-text-weak)" }}>{other}</div>
          <div className="text-[9px] uppercase" style={{ color: "var(--nx-text-weak)" }}>{t("states.other")}</div>
        </div>
      </div>

      <div className="space-y-1.5 text-xs">
        <Gauge icon={Cpu} label="CPU" value={server.cpuPercent} unit="%" subtext={server.cpuCores ? t("cores", { count: server.cpuCores }) : ""} />
        <Gauge icon={MemoryStick} label="RAM" value={server.memoryPercent} unit="%" subtext={`${formatBytes(server.memoryUsedBytes)} / ${formatBytes(server.memoryLimitBytes)}`} />
      </div>
    </div>
  );
}

function Gauge({ icon: Icon, label, value, unit, subtext }: { icon: any; label: string; value: number; unit: string; subtext?: string }) {
  const pct = Math.min(value, 100);
  const color = cpuColor(pct);
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] mb-0.5">
        <span className="flex items-center gap-1" style={{ color: "var(--nx-text-weak)" }}>
          <Icon className="w-3 h-3" /> {label}
        </span>
        <span className="tabular-nums font-semibold" style={{ color }}>
          {value.toFixed(1)}{unit}
        </span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--nx-bg-base)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      {subtext && <div className="text-[9px] mt-0.5" style={{ color: "var(--nx-text-weak)" }}>{subtext}</div>}
    </div>
  );
}

function cpuColor(pct: number): string {
  if (pct > 90) return "var(--nx-danger)";
  if (pct > 70) return "var(--nx-warning)";
  return "var(--nx-success)";
}

// Re-export for tests if needed
export { formatBytes, formatRate };

// Reuses the imports to avoid unused warnings
export const _icons = { ExternalLink };
