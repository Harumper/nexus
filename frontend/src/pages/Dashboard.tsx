import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Server,
  ServerOff,
  Shield,
  Activity,
  Plus,
  Download,
  AlertTriangle,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { buildTimeGrid, formatAxisTick, formatAxisLabel } from "../lib/chartTime";
import { useMachines } from "../hooks/useMachines";
import { useWebSocket } from "../hooks/useWebSocket";
import { api } from "../services/api";
import MachineCard from "../components/MachineCard";
import { useNavigate } from "react-router-dom";
import BatchUpdateDialog from "../components/BatchUpdateDialog";
import { PageLoader } from "../components/ui";
import type { Metric, WSDashboardMessage } from "../types";

interface FleetSummary {
  avgCpu: number;
  avgMemory: number;
  avgDisk: number;
  topCpu: { machineId: string; name: string; value: number }[];
  topMemory: { machineId: string; name: string; value: number }[];
  topDisk: { machineId: string; name: string; value: number }[];
  healthScore: number;
  machineCount: number;
  onlineCount: number;
  alertCount: number;
  rebootCount: number;
}

export default function Dashboard() {
  const { t } = useTranslation(["dashboard", "common"]);
  const navigate = useNavigate();
  const { machines, loading, refresh, updateMachineStatus } = useMachines();
  const [latestMetrics, setLatestMetrics] = useState<Record<string, Metric>>(
    {}
  );
  const [showBatchUpdate, setShowBatchUpdate] = useState(false);
  const [fleetSummary, setFleetSummary] = useState<FleetSummary | null>(null);
  const [fleetLive, setFleetLive] = useState<{
    bucketSeconds: number;
    since: string;
    series: Array<{ timestamp: string; avgCpu: number; avgMemory: number }>;
  } | null>(null);
  const [alertCounts, setAlertCounts] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<"cpu" | "memory" | "disk">("cpu");

  // INITIAL load of the latest metrics (live updates then arrive via WebSocket
  // — cf. handleWsMessage "machine.metrics"). We no longer do sequential 15s
  // polling (50 HTTP req/15s that duplicated the WS): parallel requests + a
  // single grouped setState, replayed when the machine list changes (new
  // machine coming online).
  // Stable key = set of online IDs. useMachines refreshes `machines` every 30s
  // (new array reference); without this key, loadMetrics re-ran every time → N
  // HTTP req/30s DUPLICATING the WS stream that already pushes these metrics.
  // With the key, we only redo the initial snapshot when the set of online
  // machines actually changes.
  const onlineIdsKey = machines
    .filter((m) => m.status === "ONLINE")
    .map((m) => m.id)
    .sort()
    .join(",");
  const loadMetrics = useCallback(async () => {
    const ids = onlineIdsKey ? onlineIdsKey.split(",") : [];
    const results = await Promise.all(
      ids.map((id) =>
        api
          .getLatestMetrics(id)
          .then((metric) => [id, metric] as const)
          .catch(() => null)
      )
    );
    setLatestMetrics((prev) => {
      const next = { ...prev };
      for (const r of results) if (r) next[r[0]] = r[1];
      return next;
    });
  }, [onlineIdsKey]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  // Fetch fleet summary and trends
  useEffect(() => {
    const loadFleet = () => {
      api
        .getFleetSummary()
        .then(setFleetSummary)
        .catch((err) => console.warn("[Dashboard] fleet summary failed:", err));
      api
        .getFleetLive()
        .then(setFleetLive)
        .catch((err) => console.warn("[Dashboard] fleet live failed:", err));
      // Count of active alerts per machine — shown as a badge on MachineCard
      api
        .getActiveAlerts()
        .then((alerts) => {
          const counts: Record<string, number> = {};
          for (const a of alerts) counts[a.machineId] = (counts[a.machineId] || 0) + 1;
          setAlertCounts(counts);
        })
        .catch((err) => console.warn("[Dashboard] active alerts failed:", err));
    };
    loadFleet();
    const interval = setInterval(loadFleet, 30_000);
    return () => clearInterval(interval);
  }, []);

  // WebSocket for real-time updates
  const handleWsMessage = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.type === "machine.status" && msg.machine_id) {
        updateMachineStatus(msg.machine_id, msg.data);
      }
      if (msg.type === "machine.metrics" && msg.machine_id && msg.data) {
        const d = msg.data;
        const normalized: Metric = {
          id: "",
          cpuPercent: d.cpuPercent ?? d.cpu_percent ?? 0,
          memoryUsed: d.memoryUsed ?? d.memory_used ?? 0,
          memoryTotal: d.memoryTotal ?? d.memory_total ?? 0,
          memoryPercent: d.memoryPercent ?? d.memory_percent ?? 0,
          disks: d.disks ?? [],
          network: d.network ?? null,
          loadAvg1: d.loadAvg1 ?? d.load_avg_1 ?? null,
          loadAvg5: d.loadAvg5 ?? d.load_avg_5 ?? null,
          loadAvg15: d.loadAvg15 ?? d.load_avg_15 ?? null,
          uptime: d.uptime ?? null,
          timestamp: d.timestamp ?? new Date().toISOString(),
        };
        setLatestMetrics((prev) => ({
          ...prev,
          [msg.machine_id!]: normalized,
        }));
      }
    },
    [updateMachineStatus]
  );

  useWebSocket({ onMessage: handleWsMessage });

  // Stats
  const stats = {
    total: machines.length,
    online: machines.filter((m) => m.status === "ONLINE").length,
    offline: machines.filter((m) => m.status === "OFFLINE").length,
    pending: machines.filter((m) => m.status === "ENROLLMENT_PENDING").length,
    updates: machines.filter((m) => m.agentUpdateAvailable).length,
    redeploys: machines.filter((m) => m.sudoersOutdated).length,
  };

  // Top consumers data based on active tab
  const topConsumers =
    activeTab === "cpu"
      ? fleetSummary?.topCpu
      : activeTab === "memory"
        ? fleetSummary?.topMemory
        : fleetSummary?.topDisk;

  // Health score color
  const healthColor = (score: number) =>
    score >= 80 ? "var(--nx-success)" : score >= 50 ? "var(--nx-warning)" : "var(--nx-danger)";
  const healthGradient = (score: number) =>
    score >= 80
      ? "linear-gradient(90deg, #10b981, #34d399)"
      : score >= 50
        ? "linear-gradient(90deg, #f59e0b, #fbbf24)"
        : "linear-gradient(90deg, #f43f5e, #fb7185)";

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("common:nav.dashboard")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("subtitle")}
          </p>
        </div>
        <div className="flex gap-3">
          {stats.online > 0 && (
            <button
              onClick={() => setShowBatchUpdate(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-primary/30 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
            >
              <Download className="w-4 h-4" />
              {t("updateAll")}
            </button>
          )}
          <button
            onClick={() => navigate("/machines/new")}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t("addMachine")}
          </button>
        </div>
      </div>

      {/* ── Stats ─────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
        <KPI icon={Server} label={t("common:nav.machines")} value={stats.total} color="var(--nx-primary)" />
        <KPI icon={Activity} label={t("common:status.online")} value={stats.online} color="var(--nx-success)" glow={stats.online > 0} />
        <KPI icon={ServerOff} label={t("common:status.offline")} value={stats.offline} color="var(--nx-danger)" glow={stats.offline > 0} />
        <KPI icon={AlertTriangle} label={t("common:nav.alerts")} value={fleetSummary?.alertCount ?? 0} color="var(--nx-warning)" glow={(fleetSummary?.alertCount ?? 0) > 0} />
        <KPI icon={RotateCcw} label={t("kpi.reboot")} value={fleetSummary?.rebootCount ?? 0} color="#fb923c" />
        <KPI icon={Shield} label={t("common:status.pending")} value={stats.pending} color="var(--nx-info)" />
        <KPI icon={Download} label={t("kpi.agentUpdate")} value={stats.updates} color="var(--nx-info)" glow={stats.updates > 0} />
        <KPI icon={Wrench} label={t("kpi.agentRedeploy")} value={stats.redeploys} color="#f59e0b" glow={stats.redeploys > 0} />
      </div>

      {/* ── Fleet Health + Top Consumers ────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        {/* Health — spans 2 cols */}
        <div className="lg:col-span-2 rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <SectionTitle>{t("fleetHealth")}</SectionTitle>

          <div className="flex items-end gap-4 mb-5">
            <span className="text-4xl font-extrabold tabular-nums" style={{ color: healthColor(fleetSummary?.healthScore ?? 0) }}>
              {fleetSummary?.healthScore ?? 0}
              <span className="text-lg font-semibold">%</span>
            </span>
            <div className="flex-1 pb-2">
              <div className="h-3 rounded-full overflow-hidden" style={{ background: "var(--nx-bg-elevated)" }}>
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${fleetSummary?.healthScore ?? 0}%`, background: healthGradient(fleetSummary?.healthScore ?? 0) }} />
              </div>
            </div>
          </div>

          <div className="space-y-2.5">
            <AvgBar label="CPU" value={fleetSummary?.avgCpu ?? 0} color="var(--nx-chart-1)" />
            <AvgBar label="RAM" value={fleetSummary?.avgMemory ?? 0} color="var(--nx-chart-3)" />
            <AvgBar label="Disk" value={fleetSummary?.avgDisk ?? 0} color="var(--nx-chart-5)" />
          </div>
        </div>

        {/* Top consumers — spans 3 cols */}
        <div className="lg:col-span-3 rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <div className="flex items-center justify-between mb-4">
            <SectionTitle>{t("topConsumers")}</SectionTitle>
            <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--nx-border)" }}>
              {(["cpu", "memory", "disk"] as const).map((tab) => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className="px-3 py-1 text-xs font-medium transition-colors"
                  style={{
                    background: activeTab === tab ? "var(--nx-primary-subtle)" : "transparent",
                    color: activeTab === tab ? "var(--nx-primary)" : "var(--nx-text-weak)",
                  }}>
                  {tab === "cpu" ? "CPU" : tab === "memory" ? "RAM" : "Disk"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {topConsumers && topConsumers.length > 0 ? topConsumers.slice(0, 5).map((item, i) => (
              <div key={item.machineId} className="flex items-center gap-3 group">
                <span className="w-5 text-[10px] font-bold tabular-nums text-center" style={{ color: "var(--nx-text-weak)" }}>{i + 1}</span>
                <span className="w-28 text-xs font-medium truncate text-foreground group-hover:text-primary transition-colors">{item.name}</span>
                <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--nx-bg-elevated)" }}>
                  <div className="h-full rounded-full transition-all duration-500" style={{
                    width: `${Math.min(item.value, 100)}%`,
                    background: item.value > 90 ? "var(--nx-danger)" : item.value > 70 ? "var(--nx-warning)" : "var(--nx-primary)",
                  }} />
                </div>
                <span className="w-14 text-xs text-right font-semibold tabular-nums text-foreground">{item.value.toFixed(1)}%</span>
              </div>
            )) : (
              <p className="text-xs text-muted-foreground text-center py-6">{t("noData")}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Live fleet trend (~30 min; long-term history is Grafana) ── */}
      {fleetLive && fleetLive.series.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <LiveTrend title={t("trends.cpu")} data={fleetLive} dataKey="avgCpu" color="var(--nx-chart-1)" gradientId="cpuLiveG" />
          <LiveTrend title={t("trends.ram")} data={fleetLive} dataKey="avgMemory" color="var(--nx-chart-3)" gradientId="ramLiveG" />
        </div>
      )}


      {/* ── Machines ───────────────────────────── */}
      {machines.length === 0 ? (
        <div className="text-center py-20">
          <Server className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">{t("empty.title")}</h3>
          <p className="text-sm text-muted-foreground mb-4">{t("empty.description")}</p>
          <button onClick={() => navigate("/machines/new")} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            <Plus className="w-4 h-4" /> {t("addMachine")}
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <SectionTitle>{t("common:nav.machines")}</SectionTitle>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "var(--nx-primary-subtle)", color: "var(--nx-primary)" }}>
              {stats.online}/{stats.total}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} latestMetric={latestMetrics[machine.id]} alertCount={alertCounts[machine.id] || 0} onDeleted={refresh} />
            ))}
          </div>
        </div>
      )}

      {/* Dialogs */}
      {showBatchUpdate && <BatchUpdateDialog machines={machines} onClose={() => setShowBatchUpdate(false)} />}
    </div>
  );
}

/* ── Subcomponents ─────────────────────────────────────── */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[13px] font-semibold text-foreground tracking-tight">{children}</h2>;
}

function KPI({ icon: Icon, label, value, color, glow }: {
  icon: typeof Server; label: string; value: number; color: string; glow?: boolean;
}) {
  return (
    <div className="rounded-xl p-4 transition-all duration-200 hover:-translate-y-0.5"
      style={{
        background: "var(--nx-bg-surface)",
        border: "1px solid var(--nx-border)",
        boxShadow: glow ? `0 0 16px ${color}22` : "var(--nx-shadow-sm)",
      }}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${color}12` }}>
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums leading-none" style={{ color }}>{value}</div>
          <div className="text-[10px] font-medium mt-0.5" style={{ color: "var(--nx-text-weak)" }}>{label}</div>
        </div>
      </div>
    </div>
  );
}

function AvgBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-10 text-[11px] font-medium" style={{ color: "var(--nx-text-weak)" }}>{label}</span>
      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--nx-bg-elevated)" }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(value, 100)}%`, background: value > 90 ? "var(--nx-danger)" : value > 70 ? "var(--nx-warning)" : color }} />
      </div>
      <span className="w-12 text-[11px] text-right font-semibold tabular-nums text-foreground">{value.toFixed(1)}%</span>
    </div>
  );
}

// Small live fleet trend (~30 min) fed by the in-memory buffer aggregate. Numeric
// temporal axis + gap-fill (missing bucket → null → visible hole, no false line).
function LiveTrend({ title, data, dataKey, color, gradientId }: {
  title: string;
  data: { bucketSeconds: number; since: string; series: Array<{ timestamp: string; avgCpu: number; avgMemory: number }> };
  dataKey: "avgCpu" | "avgMemory";
  color: string;
  gradientId: string;
}) {
  const bucketMs = (data.bucketSeconds || 60) * 1000;
  const sinceMs = new Date(data.since).getTime();
  const byTs = new Map<number, number>();
  for (const s of data.series) byTs.set(new Date(s.timestamp).getTime(), s[dataKey]);
  const chartData = buildTimeGrid(sinceMs, Date.now(), bucketMs).map((ts) => ({
    timestamp: ts,
    value: byTs.has(ts) ? byTs.get(ts)! : null,
  }));
  const xDomain: [number, number] | undefined =
    chartData.length > 0 ? [chartData[0].timestamp, chartData[chartData.length - 1].timestamp] : undefined;
  return (
    <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
      <SectionTitle>{title}</SectionTitle>
      <div className="h-36 mt-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="timestamp" type="number" scale="time" domain={xDomain ?? ["dataMin", "dataMax"]}
              tickFormatter={(v) => formatAxisTick(v as number, "live")}
              tick={{ fontSize: 10, fill: "var(--nx-text-weak)" }} tickLine={false} axisLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--nx-text-weak)" }} tickLine={false} axisLine={false} width={28} />
            <Tooltip
              contentStyle={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", borderRadius: "8px", fontSize: 12, color: "var(--nx-text)" }}
              labelFormatter={(v) => formatAxisLabel(v as number)}
              formatter={(value: any) => [`${Number(value).toFixed(1)}%`, title]}
            />
            <Area type="monotone" dataKey="value" stroke={color} fill={`url(#${gradientId})`} strokeWidth={2} dot={false} connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

