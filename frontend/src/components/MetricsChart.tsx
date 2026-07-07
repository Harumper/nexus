import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api } from "../services/api";
import { niceYDomain } from "../lib/utils";
import { alignToBucket, buildTimeGrid, formatAxisTick, formatAxisLabel } from "../lib/chartTime";
import type { MetricsResponse } from "../types";

interface MetricsChartProps {
  machineId: string;
}

type ChartPoint = {
  timestamp: number;
  cpu: number | null;
  memory: number | null;
  load: number | null;
  disk: number | null;
  networkIn: number | null;
  networkOut: number | null;
};

export default function MetricsChart({ machineId }: MetricsChartProps) {
  const { t } = useTranslation("metricsChart");
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Live-only: the backend serves an in-memory window (~30 min). Long-term history
  // is Prometheus/Grafana. Poll every 60s (the collection cadence).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getMetrics(machineId)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => console.warn("[MetricsChart] initial fetch failed:", err))
      .finally(() => { if (!cancelled) setLoading(false); });

    const interval = setInterval(() => {
      api.getMetrics(machineId)
        .then((res) => { if (!cancelled) setData(res); })
        .catch((err) => console.warn("[MetricsChart] poll failed:", err));
    }, 60_000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [machineId]);

  // Transforms the downsampled series for Recharts. X axis = NUMERIC timestamp
  // (no more "HH:mm" string that glued two points of the same minute together and
  // confused days over 7d). GAP-FILL: we rebuild a regular grid
  // aligned on the bucket and any missing bucket becomes a `null` point → a
  // visible GAP in the graph, never a straight line masking an offline agent.
  const chartData = useMemo<ChartPoint[]>(() => {
    const metrics = data?.metrics ?? [];
    if (metrics.length === 0) return [];
    const bucketMs = (data?.bucketSeconds ?? 60) * 1000;
    const sinceMs = data?.since ? new Date(data.since).getTime() : Date.now();
    const byTs = new Map<number, (typeof metrics)[number]>();
    for (const m of metrics) {
      byTs.set(alignToBucket(new Date(m.timestamp).getTime(), bucketMs), m);
    }
    return buildTimeGrid(sinceMs, Date.now(), bucketMs).map((ts) => {
      const m = byTs.get(ts);
      if (!m) {
        return { timestamp: ts, cpu: null, memory: null, load: null, disk: null, networkIn: null, networkOut: null };
      }
      const net = (m.network as any)?.[0];
      return {
        timestamp: ts,
        cpu: m.cpuPercent,
        memory: m.memoryPercent,
        load: m.loadAvg1 ?? 0,
        disk: m.disks?.[0]?.percent ?? 0,
        networkIn: net?.rx_bytes_per_sec != null ? net.rx_bytes_per_sec / 1024 : 0,
        networkOut: net?.tx_bytes_per_sec != null ? net.tx_bytes_per_sec / 1024 : 0,
      };
    });
  }, [data]);

  // X domain = full requested window (first→last bucket of the grid).
  const xDomain: [number, number] | undefined =
    chartData.length > 0
      ? [chartData[0].timestamp, chartData[chartData.length - 1].timestamp]
      : undefined;

  // "Current" value = last REAL point (ignores end-of-window gaps).
  const currentValues = useMemo(
    () => [...chartData].reverse().find((d) => d.cpu != null) ?? null,
    [chartData]
  );

  return (
    <div className="space-y-6">
      {/* Live window indicator — long-term history is Prometheus/Grafana */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground w-fit">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        {t("live")}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </div>
      ) : chartData.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RechartCard
            title={t("charts.cpu")}
            currentValue={`${currentValues?.cpu?.toFixed(1) ?? "—"}%`}
            data={chartData}
            dataKey="cpu"
            color="#3b82f6"
            unit="%"
            max={100}
            range="live"
            domain={xDomain}
          />
          <RechartCard
            title={t("charts.memory")}
            currentValue={`${currentValues?.memory?.toFixed(1) ?? "—"}%`}
            data={chartData}
            dataKey="memory"
            color="#8b5cf6"
            unit="%"
            max={100}
            range="live"
            domain={xDomain}
          />
          <RechartCard
            title={t("charts.load")}
            currentValue={currentValues?.load?.toFixed(2) ?? "N/A"}
            data={chartData}
            dataKey="load"
            color="#f59e0b"
            unit=""
            range="live"
            domain={xDomain}
          />
          <RechartCard
            title={t("charts.disk")}
            currentValue={`${currentValues?.disk?.toFixed(1) ?? "—"}%`}
            data={chartData}
            dataKey="disk"
            color="#ef4444"
            unit="%"
            max={100}
            range="live"
            domain={xDomain}
          />
          <RechartCard
            title={t("charts.networkIn")}
            currentValue={`${currentValues?.networkIn?.toFixed(1) ?? "0"} KB/s`}
            data={chartData}
            dataKey="networkIn"
            color="#06b6d4"
            unit=" KB/s"
            range="live"
            domain={xDomain}
          />
          <RechartCard
            title={t("charts.networkOut")}
            currentValue={`${currentValues?.networkOut?.toFixed(1) ?? "0"} KB/s`}
            data={chartData}
            dataKey="networkOut"
            color="#10b981"
            unit=" KB/s"
            range="live"
            domain={xDomain}
          />
        </div>
      )}
    </div>
  );
}

function RechartCard({
  title,
  currentValue,
  data,
  dataKey,
  color,
  unit,
  max,
  range,
  domain,
}: {
  title: string;
  currentValue: string;
  data: ChartPoint[];
  dataKey: string;
  color: string;
  unit: string;
  max?: number;
  range: string;
  domain?: [number, number];
}) {
  // Adaptive Y scale: floor 10 for % (CPU/mem/disk), no cap
  // for load/network. The peak stays in scale as long as it's within the
  // time window, then the axis drops back automatically. (the nulls from
  // gap-fill holes are ignored by the typeof === "number" filter.)
  const yValues = data
    .map((d) => (d as Record<string, number | null>)[dataKey])
    .filter((v): v is number => typeof v === "number");
  const yDomain = niceYDomain(yValues, { floor: 10, cap: max });

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <span className="text-lg font-bold" style={{ color }}>
          {currentValue}
        </span>
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: -20 }}>
            <defs>
              <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={domain ?? ["dataMin", "dataMax"]}
              tickFormatter={(ts) => formatAxisTick(ts as number, range)}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              domain={yDomain}
              width={35}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                fontSize: "12px",
                color: "var(--foreground)",
              }}
              labelStyle={{ color: "var(--muted-foreground)" }}
              labelFormatter={(label) => formatAxisLabel(label as number)}
              formatter={(value) => [`${Number(value).toFixed(1)}${unit}`, title]}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              fill={`url(#grad-${dataKey})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: color }}
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
