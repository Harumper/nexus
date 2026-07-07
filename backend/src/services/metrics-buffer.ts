import type { MetricsReport } from "../types/index.js";

// In-memory LIVE metrics buffer — replaces the persisted Metric table.
//
// Rationale: long-term history lives in Prometheus/Grafana (the backend already
// exposes per-machine `nexus_machine_*` gauges, scraped by the monitoring stack).
// The UI only needs a short live window ("is this machine saturating *now*?"), so
// we keep a bounded ring of recent points per machine, in memory. No DB writes, no
// retention job, no downsampling. Lost on backend restart — acceptable for a live
// view (it refills within a couple of report intervals).

const LIVE_MINUTES = parseInt(process.env.METRICS_LIVE_MINUTES || "30", 10);
const LIVE_MS = LIVE_MINUTES * 60 * 1000;
// Collection cadence (~1 report/min). Exposed so the frontend gap-fill can build a
// regular grid (visible holes when a machine goes offline mid-window).
const BUCKET_SECONDS = parseInt(process.env.METRICS_INTERVAL_SECONDS || "60", 10);
// Hard cap on points/machine, guarding against a misconfigured tiny interval.
const MAX_POINTS = Math.max(60, Math.ceil((LIVE_MS / 1000 / BUCKET_SECONDS) * 2));

// Shape the frontend already consumes (camelCase, same as the old /metrics rows).
export interface MetricPoint {
  timestamp: string; // ISO
  cpuPercent: number;
  memoryUsed: number; // bytes (< 2^53, safe as Number)
  memoryTotal: number;
  memoryPercent: number;
  disks: unknown; // [{mountpoint, used, total, percent}]
  network: unknown; // [{name, rx_bytes_per_sec, tx_bytes_per_sec, ...}]
  loadAvg1: number | null;
  loadAvg5: number | null;
  loadAvg15: number | null;
  uptime: number | null; // seconds
}

const buffers = new Map<string, MetricPoint[]>();

function toPoint(m: MetricsReport): MetricPoint {
  return {
    timestamp: new Date().toISOString(),
    cpuPercent: m.cpu_percent,
    memoryUsed: Number(m.memory_used),
    memoryTotal: Number(m.memory_total),
    memoryPercent: m.memory_percent,
    disks: m.disks ?? [],
    network: m.network ?? [],
    loadAvg1: m.load_avg_1 ?? null,
    loadAvg5: m.load_avg_5 ?? null,
    loadAvg15: m.load_avg_15 ?? null,
    uptime: m.uptime != null ? Number(m.uptime) : null,
  };
}

function prune(arr: MetricPoint[]): void {
  const cutoff = Date.now() - LIVE_MS;
  while (arr.length && new Date(arr[0].timestamp).getTime() < cutoff) arr.shift();
  while (arr.length > MAX_POINTS) arr.shift();
}

/** Append a report to the machine's live ring (drops points outside the window). */
export function pushMetric(machineId: string, m: MetricsReport): void {
  const arr = buffers.get(machineId) ?? [];
  arr.push(toPoint(m));
  prune(arr);
  buffers.set(machineId, arr);
}

/** Live series (within the window), oldest → newest. */
export function getSeries(machineId: string): MetricPoint[] {
  const arr = buffers.get(machineId);
  if (!arr) return [];
  prune(arr);
  return arr.slice();
}

/** Most recent point, or null if the machine has not reported within the window. */
export function getLatest(machineId: string): MetricPoint | null {
  const arr = buffers.get(machineId);
  if (!arr || arr.length === 0) return null;
  prune(arr);
  return arr.length ? arr[arr.length - 1] : null;
}

/** Latest point per machine that has live data (for the fleet summary). */
export function getFleetLatest(): Map<string, MetricPoint> {
  const out = new Map<string, MetricPoint>();
  for (const [id, arr] of buffers) {
    prune(arr);
    if (arr.length) out.set(id, arr[arr.length - 1]);
  }
  return out;
}

/** Fleet-wide live trend: average cpu/memory across machines, per aligned bucket, over
 *  the window. Feeds the small live charts on the Dashboard (no persistence). */
export function getFleetSeries(): Array<{ timestamp: string; avgCpu: number; avgMemory: number }> {
  const bucketMs = BUCKET_SECONDS * 1000;
  const byBucket = new Map<number, { cpu: number; mem: number; n: number }>();
  for (const arr of buffers.values()) {
    prune(arr);
    for (const p of arr) {
      const b = Math.floor(new Date(p.timestamp).getTime() / bucketMs) * bucketMs;
      const agg = byBucket.get(b) ?? { cpu: 0, mem: 0, n: 0 };
      agg.cpu += p.cpuPercent;
      agg.mem += p.memoryPercent;
      agg.n += 1;
      byBucket.set(b, agg);
    }
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, a]) => ({
      timestamp: new Date(ts).toISOString(),
      avgCpu: Math.round((a.cpu / a.n) * 10) / 10,
      avgMemory: Math.round((a.mem / a.n) * 10) / 10,
    }));
}

/** Drop a machine's buffer (call when the machine is deleted). */
export function evictMachine(machineId: string): void {
  buffers.delete(machineId);
}

/** Window metadata for the frontend (domain + gap-fill grid). */
export function liveWindow(): { bucketSeconds: number; since: string; minutes: number } {
  return {
    bucketSeconds: BUCKET_SECONDS,
    since: new Date(Date.now() - LIVE_MS).toISOString(),
    minutes: LIVE_MINUTES,
  };
}
