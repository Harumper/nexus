// Chart axis time formats — CENTRALIZED here.
//
// i18n COORDINATION (Lot 9a, locale-aware date/number formats): every axis/tooltip
// date format goes through THIS module. The active locale comes from
// lib/format (localeTag → fr-FR / en-GB); we don't chase scattered
// `toLocaleString("fr-FR")` calls across the chart components.
import { localeTag } from "./format";

// Parse an axis timestamp: accepts an epoch ms (number, MetricsChart/Compare) OR
// an ISO date (string, e.g. Dashboard /fleet/trends buckets). Returns null if
// invalid → the formatters render "" rather than "Invalid Date" on screen.
function toAxisDate(ts: number | string): Date | null {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

// X axis tick: time (HH:mm) for windows <= 24h; date (DD/MM) beyond that
// (7d/30d), where the time no longer matters and days would otherwise blur together.
export function formatAxisTick(ts: number | string, range: string): string {
  const d = toAxisDate(ts);
  if (!d) return "";
  if (range === "7d" || range === "30d") {
    return d.toLocaleDateString(localeTag(), { day: "2-digit", month: "2-digit" });
  }
  return d.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" });
}

// Tooltip label: ALWAYS full date + time — resolves the ambiguity of
// midnight (24h) and identical days (7d).
export function formatAxisLabel(ts: number | string): string {
  const d = toAxisDate(ts);
  if (!d) return "";
  return d.toLocaleString(localeTag(), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Align a timestamp (ms) to the lower bucket boundary — SAME boundaries
// as the SQL downsampling (`floor(epoch/bucket)*bucket`), so the frontend
// points and the backend buckets coincide exactly.
export function alignToBucket(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

// Regular bucket-aligned time grid, from `sinceMs` to `untilMs`.
// Used for GAP-FILL: any bucket with no data becomes a `null` point → a visible
// HOLE in the chart, never a straight line that would mask an offline
// agent. Size guard to never blow up (buckets already cap
// ~170 points, but we protect against an aberrant bucketMs).
export function buildTimeGrid(sinceMs: number, untilMs: number, bucketMs: number): number[] {
  if (!(bucketMs > 0) || untilMs < sinceMs) return [];
  const start = alignToBucket(sinceMs, bucketMs);
  const end = alignToBucket(untilMs, bucketMs);
  const out: number[] = [];
  for (let t = start; t <= end; t += bucketMs) {
    out.push(t);
    if (out.length >= 5000) break;
  }
  return out;
}
