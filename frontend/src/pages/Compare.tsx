import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { api } from "../services/api";
import { alignToBucket, buildTimeGrid, formatAxisTick, formatAxisLabel } from "../lib/chartTime";
import type { Machine, Metric } from "../types";

const COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"];
const METRIC_VALUES = ["cpu", "memory", "disk", "load"];

type Series = { id: string; metrics: Metric[] };

function metricValue(m: Metric, metric: string): number {
  switch (metric) {
    case "memory": return m.memoryPercent;
    case "disk": return m.disks?.[0]?.percent ?? 0;
    case "load": return m.loadAvg1 ?? 0;
    default: return m.cpuPercent;
  }
}

export default function Compare() {
  const { t } = useTranslation(["compare", "common"]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [metric, setMetric] = useState("cpu");
  const [series, setSeries] = useState<Series[]>([]);
  const [bucketMs, setBucketMs] = useState(60_000);
  const [sinceMs, setSinceMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getMachines().then(setMachines).catch((err) => console.warn("[Compare] getMachines failed:", err));
  }, []);

  // Fetch DECOUPLED from the metric choice: we only re-download when the machine
  // selection or the range changes (before: it also depended on `machines` → a useless
  // re-fetch on every parent render). Changing the metric is just a recompute.
  useEffect(() => {
    if (selectedIds.length === 0) { setSeries([]); setSinceMs(null); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      selectedIds.map((id) => api.getMetrics(id).then((res) => ({ res, id })))
    ).then((results) => {
      if (cancelled) return;
      setSeries(results.map((r) => ({ id: r.id, metrics: r.res.metrics })));
      const first = results[0]?.res;
      setBucketMs((first?.bucketSeconds ?? 60) * 1000);
      setSinceMs(first?.since ? new Date(first.since).getTime() : Date.now() - 60 * 60 * 1000);
    }).catch((err) => console.warn("[Compare] load metrics failed:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedIds]);

  const nameOf = (id: string) => machines.find((m) => m.id === id)?.name || id;
  const selectedNames = selectedIds.map(nameOf);

  // Multi-machine merge by ALIGNED BUCKET: the SQL downsampling aligns all
  // timestamps to the same boundaries → the merge is EXACT (before: merge by
  // "HH:mm" string → points at 10:30:15 and 10:30:45 collided, and no
  // sorting). GAP-FILL: a machine with no point at a bucket → null (visible gap, no
  // straight line). Light recompute when the metric changes, without re-fetch.
  const chartData = useMemo(() => {
    if (series.length === 0 || sinceMs == null) return [];
    const perMachine = new Map<string, Map<number, number>>();
    for (const s of series) {
      const byTs = new Map<number, number>();
      for (const m of s.metrics) {
        byTs.set(
          alignToBucket(new Date(m.timestamp).getTime(), bucketMs),
          Math.round(metricValue(m, metric) * 10) / 10
        );
      }
      perMachine.set(s.id, byTs);
    }
    return buildTimeGrid(sinceMs, Date.now(), bucketMs).map((ts) => {
      const point: Record<string, number | null> = { timestamp: ts };
      for (const id of selectedIds) {
        point[nameOf(id)] = perMachine.get(id)?.get(ts) ?? null;
      }
      return point;
    });
    // nameOf depends on `machines` (already in deps); no re-fetch, just a remap.
  }, [series, metric, bucketMs, sinceMs, selectedIds, machines]);

  const xDomain: [number, number] | undefined =
    chartData.length > 0
      ? [chartData[0].timestamp as number, chartData[chartData.length - 1].timestamp as number]
      : undefined;

  const toggleMachine = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id)
        ? prev.filter(x => x !== id)
        : prev.length < 3 ? [...prev, id] : prev
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-foreground mb-2">{t("common:nav.compare")}</h1>
      <p className="text-sm text-muted-foreground mb-6">{t("subtitle")}</p>

      {/* Machine selector */}
      <div className="flex flex-wrap gap-2 mb-6">
        {machines.filter(m => m.status === "ONLINE").map(m => (
          <button
            key={m.id}
            onClick={() => toggleMachine(m.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              selectedIds.includes(m.id)
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            {m.name}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex gap-4 mb-6">
        {/* Metric selector */}
        <div className="flex gap-1 rounded-lg border border-border p-1">
          {METRIC_VALUES.map(v => (
            <button
              key={v}
              onClick={() => setMetric(v)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                metric === v
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`metrics.${v}`)}
            </button>
          ))}
        </div>
        {/* Live window — long-term history is Prometheus/Grafana */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          {t("live")}
        </div>
      </div>

      {/* Chart */}
      {selectedIds.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground text-sm">
          {t("empty")}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={xDomain ?? ["dataMin", "dataMax"]}
                  tickFormatter={(ts) => formatAxisTick(ts as number, "live")}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                    color: "var(--foreground)",
                  }}
                  labelFormatter={(label) => formatAxisLabel(label as number)}
                />
                <Legend />
                {selectedNames.map((name, i) => (
                  <Line
                    key={name}
                    type="monotone"
                    dataKey={name}
                    stroke={COLORS[i]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
