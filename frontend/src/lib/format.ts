// LANGUAGE-SENSITIVE formatting — single central point.
//
// Everything that depends on the locale (dates, numbers, bytes, relative durations)
// goes through this module. The active language is read from the i18n singleton
// (`i18n.language`), so these functions are drop-ins without a hook: a
// component already subscribed to i18n (via useTranslation) re-renders on a
// language switch and re-calls these helpers with the new locale.
//
// Conventions (Lot 9a):
//   FR → fr-FR: 1 234,56 · JJ/MM · « 1,5 Go » · « il y a 5m »
//   EN → en-GB: 1,234.56 · DD/MM · « 1.5 GB » · « 5m ago »
// (en-GB and not en-US: DD/MM aligns the day/month order with FR and resolves
//  the MM/DD ambiguity for a non-US audience.)
//
// OUT of 9a scope (deliberate exception): the `.toFixed()` of percentages
// (CPU/RAM/disk) and "domain" numbers (load average, KB/s throughput) keep
// dot notation — sysadmin convention (top/uptime/CLI).
import i18n from "../i18n";

const LOCALE_TAGS: Record<string, string> = { fr: "fr-FR", en: "en-GB" };

/** BCP-47 tag of the active language, for the Intl/toLocale* APIs. */
export function localeTag(): string {
  return LOCALE_TAGS[i18n.language] ?? "fr-FR";
}

// Localized byte units: France counts in octets (o/Ko/Mo/Go/To).
const BYTE_UNITS: Record<string, string[]> = {
  "fr-FR": ["o", "Ko", "Mo", "Go", "To"],
  "en-GB": ["B", "KB", "MB", "GB", "TB"],
};
function byteUnits(): string[] {
  return BYTE_UNITS[localeTag()] ?? BYTE_UNITS["en-GB"];
}

/** Number formatted per the active locale (thousands/decimal separators). */
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(localeTag(), opts);
}

/** Byte size, localized unit + decimal separator (« 1,5 Go » / « 1.5 GB »). */
export function formatBytes(bytes: number, decimals = 1): string {
  const units = byteUnits();
  if (!bytes || bytes <= 0) return `0 ${units[0]}`;
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${formatNumber(value, { maximumFractionDigits: decimals })} ${units[i]}`;
}

/** Date only, active locale (JJ/MM/AAAA in FR, DD/MM/YYYY in en-GB). */
export function formatDate(d: string | number | Date): string {
  return new Date(d).toLocaleDateString(localeTag());
}

/** Date + time, active locale. `opts` for a compact format (e.g. 2-digit). */
export function formatDateTime(d: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleString(localeTag(), opts);
}

/** Time only, active locale. */
export function formatTime(d: string | number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleTimeString(localeTag(), opts);
}

/** Compact relative duration (« il y a 5m » / « 5m ago »), words via i18n common. */
export function timeAgo(date: string | null): string {
  if (!date) return i18n.t("common:relativeTime.never");
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diff < 10) return i18n.t("common:relativeTime.now");
  if (diff < 60) return i18n.t("common:relativeTime.seconds", { n: diff });
  if (diff < 3600) return i18n.t("common:relativeTime.minutes", { n: Math.floor(diff / 60) });
  if (diff < 86400) return i18n.t("common:relativeTime.hours", { n: Math.floor(diff / 3600) });
  return i18n.t("common:relativeTime.days", { n: Math.floor(diff / 86400) });
}

/** Compact uptime (« 3j 4h » / « 3d 4h »), units via i18n common. */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return i18n.t("common:uptime.days", { d, h });
  if (h > 0) return i18n.t("common:uptime.hours", { h, m });
  return i18n.t("common:uptime.minutes", { m });
}
