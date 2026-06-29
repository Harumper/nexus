import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api } from "../services/api";
import { niceYDomain } from "../lib/utils";
import type { Metric } from "../types";

interface MetricsChartProps {
  machineId: string;
}

const RANGES = ["15m", "1h", "6h", "24h", "7d"];

export default function MetricsChart({ machineId }: MetricsChartProps) {
  const { t } = useTranslation("metricsChart");
  const [range, setRange] = useState("1h");
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getMetrics(machineId, range)
      .then((res) => { if (!cancelled) setMetrics(res.metrics); })
      .catch((err) => console.warn("[MetricsChart] initial fetch failed:", err))
      .finally(() => { if (!cancelled) setLoading(false); });

    const interval = setInterval(() => {
      api.getMetrics(machineId, range)
        .then((res) => { if (!cancelled) setMetrics(res.metrics); })
        .catch((err) => console.warn("[MetricsChart] poll failed:", err));
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
            key={r}
            onClick={() => setRange(r)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              range === r
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {r === "7d" ? t("range7d") : r}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </div>
      ) : metrics.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RechartCard
            title={t("charts.cpu")}
            currentValue={`${currentValues?.cpu.toFixed(1)}%`}
            data={chartData}
            dataKey="cpu"
            color="#3b82f6"
            unit="%"
            max={100}
          />
          <RechartCard
            title={t("charts.memory")}
            currentValue={`${currentValues?.memory.toFixed(1)}%`}
            data={chartData}
            dataKey="memory"
            color="#8b5cf6"
            unit="%"
            max={100}
          />
          <RechartCard
            title={t("charts.load")}
            currentValue={currentValues?.load.toFixed(2) ?? "N/A"}
            data={chartData}
            dataKey="load"
            color="#f59e0b"
            unit=""
          />
          <RechartCard
            title={t("charts.disk")}
            currentValue={`${currentValues?.disk.toFixed(1)}%`}
            data={chartData}
            dataKey="disk"
            color="#ef4444"
            unit="%"
            max={100}
          />
          <RechartCard
            title={t("charts.networkIn")}
            currentValue={`${currentValues?.networkIn?.toFixed(1) ?? "0"} KB/s`}
            data={chartData}
            dataKey="networkIn"
            color="#06b6d4"
            unit=" KB/s"
          />
          <RechartCard
            title={t("charts.networkOut")}
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
  data: Array<{ time: string; [key: string]: number | string }>;
  dataKey: string;
  color: string;
  unit: string;
  max?: number;
}) {
  // Échelle Y adaptative : floor 10 pour les % (CPU/mem/disk), pas de cap
  // pour load/network. Le pic reste à l'échelle tant qu'il est dans la
  // fenêtre temporelle, puis l'axe redescend automatiquement.
  const yValues = data
    .map((d) => d[dataKey])
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
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
