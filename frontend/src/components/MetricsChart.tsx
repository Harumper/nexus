import { useState, useEffect } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api } from "../services/api";
import type { Metric } from "../types";

interface MetricsChartProps {
  machineId: string;
}

const RANGES = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7j" },
];

export default function MetricsChart({ machineId }: MetricsChartProps) {
  const [range, setRange] = useState("1h");
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getMetrics(machineId, range)
      .then((res) => { if (!cancelled) setMetrics(res.metrics); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });

    const interval = setInterval(() => {
      api.getMetrics(machineId, range)
        .then((res) => { if (!cancelled) setMetrics(res.metrics); })
        .catch(() => {});
    }, 60_000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [machineId, range]);

  // Transform metrics for Recharts
  const chartData = metrics.map((m) => ({
    time: new Date(m.timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    timestamp: new Date(m.timestamp).getTime(),
    cpu: m.cpuPercent,
    memory: m.memoryPercent,
    load: m.loadAvg1 ?? 0,
    disk: m.disks?.[0]?.percent ?? 0,
    networkIn: (m.network as any)?.[0]?.rx_bytes_per_sec ? ((m.network as any)[0].rx_bytes_per_sec / 1024) : 0,
    networkOut: (m.network as any)?.[0]?.tx_bytes_per_sec ? ((m.network as any)[0].tx_bytes_per_sec / 1024) : 0,
  }));

  const currentValues = chartData.length > 0 ? chartData[chartData.length - 1] : null;

  return (
    <div className="space-y-6">
      {/* Range selector */}
      <div className="flex gap-1 rounded-lg border border-border p-1 w-fit">
        {RANGES.map((r) => (
          <button
            key={r.value}
            onClick={() => setRange(r.value)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              range === r.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </div>
      ) : metrics.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          Aucune métrique pour cette période
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RechartCard
            title="CPU"
            currentValue={`${currentValues?.cpu.toFixed(1)}%`}
            data={chartData}
            dataKey="cpu"
            color="#3b82f6"
            unit="%"
            max={100}
          />
          <RechartCard
            title="Mémoire"
            currentValue={`${currentValues?.memory.toFixed(1)}%`}
            data={chartData}
            dataKey="memory"
            color="#8b5cf6"
            unit="%"
            max={100}
          />
          <RechartCard
            title="Load Average (1m)"
            currentValue={currentValues?.load.toFixed(2) ?? "N/A"}
            data={chartData}
            dataKey="load"
            color="#f59e0b"
            unit=""
          />
          <RechartCard
            title="Disque principal"
            currentValue={`${currentValues?.disk.toFixed(1)}%`}
            data={chartData}
            dataKey="disk"
            color="#ef4444"
            unit="%"
            max={100}
          />
          <RechartCard
            title="Réseau In"
            currentValue={`${currentValues?.networkIn?.toFixed(1) ?? "0"} KB/s`}
            data={chartData}
            dataKey="networkIn"
            color="#06b6d4"
            unit=" KB/s"
          />
          <RechartCard
            title="Réseau Out"
            currentValue={`${currentValues?.networkOut?.toFixed(1) ?? "0"} KB/s`}
            data={chartData}
            dataKey="networkOut"
            color="#10b981"
            unit=" KB/s"
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
}: {
  title: string;
  currentValue: string;
  data: any[];
  dataKey: string;
  color: string;
  unit: string;
  max?: number;
}) {
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
              dataKey="time"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              domain={max ? [0, max] : ["auto", "auto"]}
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
              formatter={(value: any) => [`${Number(value).toFixed(1)}${unit}`, title]}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              fill={`url(#grad-${dataKey})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: color }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
