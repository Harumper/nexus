import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i];
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function timeAgo(date: string | null): string {
  if (!date) return "jamais";
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 10) return "maintenant";
  if (diff < 60) return `il y a ${diff}s`;
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`;
  return `il y a ${Math.floor(diff / 86400)}j`;
}

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

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    ONLINE: "En ligne",
    OFFLINE: "Hors ligne",
    DEGRADED: "Dégradé",
    ENROLLMENT_PENDING: "En attente",
    REVOKED: "Révoqué",
  };
  return labels[status] || status;
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
