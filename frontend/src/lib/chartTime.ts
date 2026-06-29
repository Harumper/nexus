// Formats temporels des axes de graphes — CENTRALISÉS ici.
//
// COORDINATION i18n (Lot 9, formats date/nombre locale-aware) : tout format de
// date d'axe/tooltip passe par CE module. Le Lot 9 n'aura qu'à remplacer
// CHART_LOCALE par la locale active (et adapter les options Intl) en UN endroit,
// au lieu de rechasser des `toLocaleString("fr-FR")` éparpillés dans les graphes.
const CHART_LOCALE = "fr-FR";

// Tick de l'axe X : heure (HH:mm) pour les fenêtres <= 24h ; date (JJ/MM) au-delà
// (7j/30j), où l'heure n'a plus de sens et où les jours se confondraient sinon.
export function formatAxisTick(ts: number, range: string): string {
  const d = new Date(ts);
  if (range === "7d" || range === "30d") {
    return d.toLocaleDateString(CHART_LOCALE, { day: "2-digit", month: "2-digit" });
  }
  return d.toLocaleTimeString(CHART_LOCALE, { hour: "2-digit", minute: "2-digit" });
}

// Libellé du tooltip : TOUJOURS date + heure complètes — lève l'ambiguïté de
// minuit (24h) et des jours identiques (7j).
export function formatAxisLabel(ts: number): string {
  return new Date(ts).toLocaleString(CHART_LOCALE, {
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
