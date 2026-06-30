import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// formatBytes / formatUptime / timeAgo ont migré vers lib/format.ts (Lot 9a,
// formatage sensible à la langue). Importe-les depuis "../lib/format".

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

// Suffixe de clé i18n pour un statut machine (résolu via t(`common:status.${key}`)).
// Sépare le mapping statut→clé de la traduction, pour les composants i18n-isés.
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
// Échelle Y adaptative pour les graphs : on évite de zoomer sur du bruit
// quand toutes les valeurs sont basses, mais on étend si un pic apparaît.
// L'hystérèse se fait naturellement via la fenêtre temporelle des données :
// le pic reste affiché tant qu'il est dans la range, puis l'échelle redescend
// quand il sort.
//
// floor : minimum garanti (ex: 10 pour CPU% — évite de voir 0-1.5 quand
//   la machine est calme).
// cap : plafond absolu (ex: 100 pour %, undefined pour load/network).
// headroom : marge au-dessus du max réel (15 % par défaut).
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

  // Paliers visuellement agréables (lecture humaine + ticks Recharts propres)
  const niceSteps = [10, 20, 25, 50, 75, 100, 150, 200, 250, 500, 750, 1000];
  let top = niceSteps.find((s) => s >= target) ?? Math.ceil(target / 100) * 100;

  if (top < floor) top = floor;
  if (cap !== undefined && top > cap) top = cap;

  return [0, top];
}
