import { useState, useEffect, useCallback, useMemo } from "react";
import { Search, Package, Download, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useConfirm } from "./ui";

interface PackagesTabProps {
  machineId: string;
}

interface AptPackage {
  name: string;
  version: string;
  description: string;
  section: string | null;
  size: number | null;
  suite: string;
  component: string;
}

function formatSize(kb: number | null): string {
  if (!kb || kb <= 0) return "—";
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function PackagesTab({ machineId }: PackagesTabProps) {
  const { t } = useTranslation(["packages", "common"]);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 300);
  const [results, setResults] = useState<AptPackage[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<{ name: string; kind: "install" | "remove" } | null>(null);
  const [suite, setSuite] = useState("noble");
  const { confirm, ConfirmDialogElement } = useConfirm();

  // Extract description title (first line before the full description)
  const getTitle = (desc: string) => desc.split("\n")[0] || "";

  const doSearch = useCallback(async () => {
    if (!debouncedQuery || debouncedQuery.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const res = await api.searchPackages(debouncedQuery, suite);
      setResults(res?.results || []);
    } catch (err) {
      setError(getErrorMessage(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [debouncedQuery, suite]);

  useEffect(() => { doSearch(); }, [doSearch]);

  const handleInstall = async (name: string) => {
    if (!(await confirm({ title: t("confirmInstall", { name }), confirmLabel: t("common:actions.install"), variant: "primary" }))) return;
    setActing({ name, kind: "install" });
    try {
      await api.installPackage(machineId, name);
      toast.success(t("toastInstalled", { name }));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setActing(null);
    }
  };

  const handleRemove = async (name: string) => {
    if (!(await confirm({ title: t("confirmRemove", { name }), confirmLabel: t("common:actions.uninstall"), variant: "danger" }))) return;
    setActing({ name, kind: "remove" });
    try {
      await api.removePackage(machineId, name);
      toast.success(t("toastRemoved", { name }));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setActing(null);
    }
  };

  // Dedup par nom (garder la version la plus recente par suite/component)
  const dedupedResults = useMemo(() => {
    const seen = new Map<string, AptPackage>();
    for (const r of results) {
      if (!seen.has(r.name)) seen.set(r.name, r);
    }
    return Array.from(seen.values());
  }, [results]);

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--nx-text-weak)" }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full rounded-lg border border-input bg-background pl-9 pr-3 py-2 text-sm"
            autoFocus
          />
        </div>
        <select
          value={suite}
          onChange={(e) => setSuite(e.target.value)}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="noble">noble (24.04)</option>
          <option value="jammy">jammy (22.04)</option>
          <option value="bookworm">bookworm (Debian 12)</option>
        </select>
        {searching && <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--nx-text-weak)" }} />}
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!query && (
        <div className="rounded-xl border border-border p-8 text-center" style={{ background: "var(--nx-bg-surface)" }}>
          <Package className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--nx-text-weak)" }} />
          <p className="text-sm" style={{ color: "var(--nx-text-weak)" }}>
            {t("emptyHint")}
          </p>
          <p className="text-xs mt-2" style={{ color: "var(--nx-text-weak)" }}>
            {t("catalogHint")}
          </p>
        </div>
      )}

      {query && query.length >= 2 && !searching && dedupedResults.length === 0 && !error && (
        <div className="rounded-xl border border-border p-8 text-center" style={{ background: "var(--nx-bg-surface)" }}>
          <p className="text-sm" style={{ color: "var(--nx-text-weak)" }}>
            {t("noResults", { query, suite })}
          </p>
        </div>
      )}

      {/* Results */}
      {dedupedResults.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs" style={{ color: "var(--nx-text-weak)" }}>
            {t("count", { count: dedupedResults.length })}
          </div>
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
            {dedupedResults.map((pkg) => (
              <div
                key={`${pkg.name}-${pkg.version}`}
                className="border-t first:border-t-0 px-4 py-3 flex items-start justify-between gap-4"
                style={{ borderColor: "var(--nx-border)" }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-semibold">{pkg.name}</span>
                    <span className="text-xs font-mono" style={{ color: "var(--nx-text-weak)" }}>{pkg.version}</span>
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded"
                      style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}>
                      {pkg.component}
                    </span>
                    {pkg.section && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>
                        {pkg.section}
                      </span>
                    )}
                    {pkg.size && (
                      <span className="text-[10px]" style={{ color: "var(--nx-text-weak)" }}>
                        {formatSize(pkg.size)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs mt-1 truncate" style={{ color: "var(--nx-text-weak)" }}>
                    {getTitle(pkg.description)}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => handleInstall(pkg.name)}
                    disabled={acting?.name === pkg.name}
                    className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors"
                    style={{ border: "1px solid var(--nx-success)", color: "var(--nx-success)" }}
                  >
                    {acting?.name === pkg.name && acting.kind === "install" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    {t("common:actions.install")}
                  </button>
                  <button
                    onClick={() => handleRemove(pkg.name)}
                    disabled={acting?.name === pkg.name}
                    className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors"
                    style={{ border: "1px solid var(--nx-danger)", color: "var(--nx-danger)" }}
                  >
                    {acting?.name === pkg.name && acting.kind === "remove" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    {t("common:actions.remove")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {ConfirmDialogElement}
    </div>
  );
}
