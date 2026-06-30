// Formats temporels des axes de graphes — CENTRALISÉS ici.
//
// COORDINATION i18n (Lot 9a, formats date/nombre locale-aware) : tout format de
// date d'axe/tooltip passe par CE module. La locale active vient de
// lib/format (localeTag → fr-FR / en-GB) ; on ne rechasse pas des
// `toLocaleString("fr-FR")` éparpillés dans les composants de graphes.
import { localeTag } from "./format";

// Parse un timestamp d'axe : accepte un epoch ms (number, MetricsChart/Compare) OU
// une date ISO (string, ex. buckets /fleet/trends du Dashboard). Retourne null si
// invalide → les formateurs rendent "" plutôt que "Invalid Date" à l'écran.
function toAxisDate(ts: number | string): Date | null {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Tick de l'axe X : heure (HH:mm) pour les fenêtres <= 24h ; date (JJ/MM) au-delà
// (7j/30j), où l'heure n'a plus de sens et où les jours se confondraient sinon.
export function formatAxisTick(ts: number | string, range: string): string {
  const d = toAxisDate(ts);
  if (!d) return "";
  if (range === "7d" || range === "30d") {
    return d.toLocaleDateString(localeTag(), { day: "2-digit", month: "2-digit" });
  }
  return d.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" });
}

// Libellé du tooltip : TOUJOURS date + heure complètes — lève l'ambiguïté de
// minuit (24h) et des jours identiques (7j).
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

// Aligne un timestamp (ms) sur la frontière de bucket basse — MÊMES frontières
// que le downsampling SQL (`floor(epoch/bucket)*bucket`), pour que les points
// front et les buckets backend coïncident exactement.
export function alignToBucket(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

// Grille temporelle régulière alignée sur le bucket, de `sinceMs` à `untilMs`.
// Sert au GAP-FILL : tout bucket sans donnée devient un point `null` → un TROU
// visible dans le graphe, jamais une ligne droite qui masquerait un agent
// offline. Garde-fou de taille pour ne jamais exploser (les buckets bornent
// déjà ~170 points, mais on protège contre un bucketMs aberrant).
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
