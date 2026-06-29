import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { api } from "../services/api";
import type { Machine } from "../types";

const COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"];
const METRIC_VALUES = ["cpu", "memory", "disk", "load"];

export default function Compare() {
  const { t } = useTranslation(["compare", "common"]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [metric, setMetric] = useState("cpu");
  const [range, setRange] = useState("1h");
  const [chartData, setChartData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getMachines().then(setMachines).catch((err) => console.warn("[Compare] getMachines failed:", err));
  }, []);

  useEffect(() => {
    if (selectedIds.length === 0) { setChartData([]); return; }
    setLoading(true);

    Promise.all(
      selectedIds.map(id =>
        api.getMetrics(id, range).then(res => ({ id, metrics: res.metrics }))
      )
    ).then(results => {
      // Merge metrics by timestamp buckets
      const timeMap = new Map<string, any>();

      for (const { id, metrics } of results) {
        const name = machines.find(m => m.id === id)?.name || id;
        for (const m of metrics) {
          const timeKey = new Date(m.timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
          const existing = timeMap.get(timeKey) || { time: timeKey };

          let value = 0;
          switch (metric) {
            case "cpu": value = m.cpuPercent; break;
            case "memory": value = m.memoryPercent; break;
            case "disk": value = m.disks?.[0]?.percent ?? 0; break;
            case "load": value = m.loadAvg1 ?? 0; break;
          }
          existing[name] = Math.round(value * 10) / 10;
          timeMap.set(timeKey, existing);
        }
      }

      setChartData(Array.from(timeMap.values()));
    }).catch((err) => console.warn("[Compare] load metrics failed:", err)).finally(() => setLoading(false));
  }, [selectedIds, metric, range, machines]);

  const toggleMachine = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id)
        ? prev.filter(x => x !== id)
        : prev.length < 3 ? [...prev, id] : prev
    );
  };

  const selectedNames = selectedIds.map(id => machines.find(m => m.id === id)?.name || id);

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
        {/* Range selector */}
        <div className="flex gap-1 rounded-lg border border-border p-1">
          {["15m", "1h", "6h", "24h"].map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                range === r
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r}
            </button>
          ))}
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
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                    color: "var(--foreground)",
                  }}
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
