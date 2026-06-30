// Formatage SENSIBLE À LA LANGUE — point central unique.
//
// Tout ce qui dépend de la locale (dates, nombres, octets, durées relatives)
// passe par ce module. La langue active est lue sur le singleton i18n
// (`i18n.language`), donc ces fonctions sont des drop-in sans hook : un
// composant qui souscrit déjà à i18n (via useTranslation) se re-rend au switch
// de langue et ré-appelle ces helpers avec la nouvelle locale.
//
// Conventions (Lot 9a) :
//   FR → fr-FR : 1 234,56 · JJ/MM · « 1,5 Go » · « il y a 5m »
//   EN → en-GB : 1,234.56 · DD/MM · « 1.5 GB » · « 5m ago »
// (en-GB et non en-US : DD/MM aligne l'ordre jour/mois sur le FR et lève
//  l'ambiguïté MM/DD pour un public non-US.)
//
// HORS scope 9a (dérogation consciente) : les `.toFixed()` de pourcentages
// (CPU/RAM/disque) et de nombres « métier » (load average, débits KB/s) gardent
// la notation point — convention sysadmin (top/uptime/CLI).
import i18n from "../i18n";

const LOCALE_TAGS: Record<string, string> = { fr: "fr-FR", en: "en-GB" };

/** Étiquette BCP-47 de la langue active, pour les API Intl/toLocale*. */
export function localeTag(): string {
  return LOCALE_TAGS[i18n.language] ?? "fr-FR";
}

// Unités d'octets localisées : la France compte en octets (o/Ko/Mo/Go/To).
const BYTE_UNITS: Record<string, string[]> = {
  "fr-FR": ["o", "Ko", "Mo", "Go", "To"],
  "en-GB": ["B", "KB", "MB", "GB", "TB"],
};
function byteUnits(): string[] {
  return BYTE_UNITS[localeTag()] ?? BYTE_UNITS["en-GB"];
}

/** Nombre formaté selon la locale active (séparateurs de milliers/décimale). */
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(localeTag(), opts);
}

/** Taille en octets, unité + séparateur décimal localisés (« 1,5 Go » / « 1.5 GB »). */
export function formatBytes(bytes: number, decimals = 1): string {
  const units = byteUnits();
  if (!bytes || bytes <= 0) return `0 ${units[0]}`;
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${formatNumber(value, { maximumFractionDigits: decimals })} ${units[i]}`;
}

/** Date seule, locale active (JJ/MM/AAAA en FR, DD/MM/YYYY en en-GB). */
export function formatDate(d: string | number | Date): string {
  return new Date(d).toLocaleDateString(localeTag());
}

/** Date + heure, locale active. `opts` pour un format compact (ex. 2-digit). */
export function formatDateTime(d: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleString(localeTag(), opts);
}

/** Heure seule, locale active. */
export function formatTime(d: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleTimeString(localeTag(), opts);
}

/** Durée relative compacte (« il y a 5m » / « 5m ago »), mots via i18n common. */
export function timeAgo(date: string | null): string {
  if (!date) return i18n.t("common:relativeTime.never");
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diff < 10) return i18n.t("common:relativeTime.now");
  if (diff < 60) return i18n.t("common:relativeTime.seconds", { n: diff });
  if (diff < 3600) return i18n.t("common:relativeTime.minutes", { n: Math.floor(diff / 60) });
  if (diff < 86400) return i18n.t("common:relativeTime.hours", { n: Math.floor(diff / 3600) });
  return i18n.t("common:relativeTime.days", { n: Math.floor(diff / 86400) });
}

/** Uptime compact (« 3j 4h » / « 3d 4h »), unités via i18n common. */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return i18n.t("common:uptime.days", { d, h });
  if (h > 0) return i18n.t("common:uptime.hours", { h, m });
  return i18n.t("common:uptime.minutes", { m });
}
