import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// formatBytes / formatUptime / timeAgo have migrated to lib/format.ts (Lot 9a,
// language-sensitive formatting). Import them from "../lib/format".

export function statusColor(
  status: string
): { bg: string; text: string; dot: string } {
  switch (status) {
    case "ONLINE":
      return {
        bg: "bg-emerald-500/10",
        text: "text-emerald-400",
        dot: "bg-emerald-400",
      };
    case "OFFLINE":
      return {
        bg: "bg-red-500/10",
        text: "text-red-400",
        dot: "bg-red-400",
      };
    case "DEGRADED":
      return {
        bg: "bg-amber-500/10",
        text: "text-amber-400",
        dot: "bg-amber-400",
      };
    case "ENROLLMENT_PENDING":
      return {
        bg: "bg-blue-500/10",
        text: "text-blue-400",
        dot: "bg-blue-400",
      };
    case "REVOKED":
      return {
        bg: "bg-zinc-500/10",
        text: "text-zinc-500",
        dot: "bg-zinc-500",
      };
    default:
      return {
        bg: "bg-zinc-500/10",
        text: "text-zinc-400",
        dot: "bg-zinc-400",
      };
  }
}

// i18n key suffix for a machine status (resolved via t(`common:status.${key}`)).
// Separates the status→key mapping from the translation, for i18n-ized components.
export function statusKey(status: string): string {
  const keys: Record<string, string> = {
    ONLINE: "online",
    OFFLINE: "offline",
    DEGRADED: "degraded",
    ENROLLMENT_PENDING: "pending",
    REVOKED: "revoked",
  };
  return keys[status] || "unknown";
}

// ───────────────────────────────────────────────────────────────────────
// Adaptive Y scale for charts: we avoid zooming into noise
// when all values are low, but expand if a spike appears.
// The hysteresis happens naturally via the data's time window:
// the spike stays displayed while it's within range, then the scale drops back
// when it exits.
//
// floor: guaranteed minimum (e.g. 10 for CPU% — avoids seeing 0-1.5 when
//   the machine is idle).
// cap: absolute ceiling (e.g. 100 for %, undefined for load/network).
// headroom: margin above the real max (15% by default).
// ───────────────────────────────────────────────────────────────────────
export function niceYDomain(
  values: number[],
  opts: { floor?: number; cap?: number; headroom?: number } = {}
): [number, number] {
  const { floor = 10, cap, headroom = 0.15 } = opts;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, floor];

  const peak = Math.max(...finite);
  const target = peak * (1 + headroom);

  // Visually pleasant steps (human reading + clean Recharts ticks)
  const niceSteps = [10, 20, 25, 50, 75, 100, 150, 200, 250, 500, 750, 1000];
  let top = niceSteps.find((s) => s >= target) ?? Math.ceil(target / 100) * 100;

  if (top < floor) top = floor;
  if (cap !== undefined && top > cap) top = cap;

  return [0, top];
}
