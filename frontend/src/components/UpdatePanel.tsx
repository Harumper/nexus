import { useState, useCallback, useRef, useEffect } from "react";
import {
  Download,
  RefreshCw,
  Shield,
  Package,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Lock,
  Unlock,
  Clock,
  ScrollText,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useWebSocket } from "../hooks/useWebSocket";
import { Dialog } from "./ui/Dialog";
import type { WSDashboardMessage } from "../types";

interface UpdatePanelProps {
  machineId: string;
  machineName: string;
}

interface PendingPackage {
  name: string;
  current_version: string;
  new_version: string;
  security_update: boolean;
  deferred?: boolean;
}

interface PackageListResult {
  package_manager: string;
  total_updates: number;
  security_updates: number;
  deferred_updates?: number;
  packages: PendingPackage[];
}

interface UpdateProgress {
  line: string;
  percent: number;
}

export default function UpdatePanel({
  machineId,
  machineName,
}: UpdatePanelProps) {
  const [packageData, setPackageData] = useState<PackageListResult | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [showAllPackages, setShowAllPackages] = useState(false);
  const [holds, setHolds] = useState<Set<string>>(new Set());
  const [togglingHold, setTogglingHold] = useState<string | null>(null);
  // Journal complet des événements reçus pour la MAJ en cours / la dernière.
  // Conservé après la fin pour permettre la relecture via la modal.
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll du journal en bas quand la modal est ouverte
  useEffect(() => {
    if (showLog) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log, showLog]);

  // WebSocket pour la progression des MAJ
  const handleWsMessage = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.type === "update.progress" && msg.machine_id === machineId) {
        const data = msg.data as UpdateProgress;
        setProgress(data);
        if (data?.line) {
          setLog((prev) => [...prev, data.line]);
        }
        if (data?.percent === 100) {
          setTimeout(() => {
            setUpdating(false);
            setResult({
              success: true,
              message: "Mise à jour terminée avec succès",
            });
            setProgress(null);
            setPackageData(null); // Refresh la liste après MAJ
          }, 1000);
        }
      }
    },
    [machineId]
  );

  useWebSocket({ onMessage: handleWsMessage, enabled: updating });

  // Charger la liste des packages + les holds en parallele
  const checkUpdates = async () => {
    setLoadingList(true);
    setResult(null);
    setPackageData(null);
    try {
      const [resp, holdsResp] = await Promise.all([
        api.dispatchActionSync<PackageListResult>(
          machineId,
          "system.package_list",
          undefined,
          60_000
        ),
        api.packageHoldsList(machineId).catch(() => null),
      ]);
      setPackageData(resp.data);
      setHolds(new Set(holdsResp?.data?.holds || []));
    } catch (err) {
      setResult({ success: false, message: getErrorMessage(err, "Erreur") });
    } finally {
      setLoadingList(false);
    }
  };

  const toggleHold = async (pkgName: string) => {
    setTogglingHold(pkgName);
    try {
      if (holds.has(pkgName)) {
        await api.packageUnhold(machineId, pkgName);
        setHolds((prev) => {
          const next = new Set(prev);
          next.delete(pkgName);
          return next;
        });
      } else {
        await api.packageHold(machineId, pkgName);
        setHolds((prev) => new Set(prev).add(pkgName));
      }
    } catch (err) {
      toast.error("Erreur : " + getErrorMessage(err));
    } finally {
      setTogglingHold(null);
    }
  };

  // Lancer une mise à jour
  const startUpdate = async (securityOnly: boolean) => {
    setUpdating(true);
    setProgress({ line: "Démarrage de la mise à jour...", percent: 0 });
    setResult(null);
    setLog(["Démarrage de la mise à jour..."]);
    try {
      const actionId = securityOnly
        ? "system.update_security"
        : "system.update";
      await api.dispatchAction(machineId, actionId);
    } catch (err) {
      setUpdating(false);
      setProgress(null);
      setResult({ success: false, message: getErrorMessage(err) });
    }
  };

  const securityPkgs =
    packageData?.packages.filter((p) => p.security_update) ?? [];
  const deferredCount =
    packageData?.deferred_updates ??
    (packageData?.packages.filter((p) => p.deferred).length || 0);
  // Nombre réellement installable maintenant par apt (= total - différés),
  // ce qui correspond au "X peuvent être appliquées immédiatement" du terminal.
  const applicableCount = (packageData?.total_updates ?? 0) - deferredCount;
  const displayedPackages = showAllPackages
    ? packageData?.packages ?? []
    : (packageData?.packages ?? []).slice(0, 10);

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Download className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            Mises à jour système
          </h3>
        </div>
        <button
          onClick={checkUpdates}
          disabled={loadingList || updating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
        >
          {loadingList ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {loadingList ? "Vérification..." : "Vérifier les MAJ"}
        </button>
      </div>

      {/* Résultat / Erreur */}
      {result && (
        <div
          className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
            result.success
              ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
              : "bg-destructive/10 border border-destructive/20 text-destructive"
          }`}
        >
          {result.success ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 shrink-0" />
          )}
          {result.message}
        </div>
      )}

      {/* Résumé des packages */}
      {packageData && (
        <div className="space-y-3">
          {/* Stats */}
          <div className="flex gap-4">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted">
              <Package className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-foreground">
                {packageData.total_updates}
              </span>
              <span className="text-xs text-muted-foreground">
                mise{packageData.total_updates > 1 ? "s" : ""} à jour
              </span>
            </div>
            {packageData.security_updates > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <Shield className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-medium text-amber-400">
                  {packageData.security_updates}
                </span>
                <span className="text-xs text-amber-400/80">sécurité</span>
              </div>
            )}
            {deferredCount > 0 && (
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted border border-border"
                title="Phased updates / kept-back : listés comme disponibles mais non installés immédiatement par apt (déploiement progressif Ubuntu)."
              >
                <Clock className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  {deferredCount}
                </span>
                <span className="text-xs text-muted-foreground">différé{deferredCount > 1 ? "s" : ""}</span>
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted">
              <span className="text-xs text-muted-foreground">
                via {packageData.package_manager}
              </span>
            </div>
          </div>

          {deferredCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {deferredCount} mise{deferredCount > 1 ? "s" : ""} à jour différée
              {deferredCount > 1 ? "s" : ""} (phased/kept-back) ne ser
              {deferredCount > 1 ? "ont" : "a"} pas installée
              {deferredCount > 1 ? "s" : ""} immédiatement par apt —{" "}
              {packageData.total_updates - deferredCount} applicable
              {packageData.total_updates - deferredCount > 1 ? "s" : ""}{" "}
              maintenant.
            </p>
          )}

          {/* Liste des packages */}
          {packageData.total_updates > 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/30 border-b border-border">
                    <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">
                      Package
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">
                      Actuelle
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">
                      Nouvelle
                    </th>
                    <th className="text-center px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">
                      Sécu
                    </th>
                    <th className="text-center px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">
                      Hold
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayedPackages.map((pkg, i) => {
                    const isHeld = holds.has(pkg.name);
                    return (
                      <tr
                        key={i}
                        className="border-b border-border/30 last:border-0"
                        style={{ opacity: isHeld ? 0.5 : 1 }}
                      >
                        <td className="px-3 py-1.5 text-xs font-mono text-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            {pkg.name}
                            {pkg.deferred && (
                              <span
                                className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-sans font-medium bg-muted text-muted-foreground border border-border"
                                title="Phased/kept-back : non installé immédiatement par apt"
                              >
                                <Clock className="w-2.5 h-2.5" />
                                différé
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground font-mono">
                          {pkg.current_version || "—"}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-primary font-mono">
                          {pkg.new_version}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {pkg.security_update && (
                            <Shield className="w-3 h-3 text-amber-400 mx-auto" />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <button
                            onClick={() => toggleHold(pkg.name)}
                            disabled={togglingHold === pkg.name}
                            title={isHeld ? "Retirer le hold (autoriser l'upgrade)" : "Hold (empêcher l'upgrade)"}
                            className="inline-flex items-center justify-center p-1 rounded transition-colors hover:bg-muted"
                          >
                            {togglingHold === pkg.name ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : isHeld ? (
                              <Lock className="w-3 h-3" style={{ color: "var(--nx-warning)" }} />
                            ) : (
                              <Unlock className="w-3 h-3" style={{ color: "var(--nx-text-weak)" }} />
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {(packageData.packages.length > 10) && (
                <button
                  onClick={() => setShowAllPackages(!showAllPackages)}
                  className="w-full px-3 py-2 text-xs text-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex items-center justify-center gap-1"
                >
                  {showAllPackages ? (
                    <>
                      <ChevronUp className="w-3 h-3" /> Réduire
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-3 h-3" /> Afficher les{" "}
                      {packageData.packages.length - 10} restants
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {packageData.total_updates === 0 && (
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              Système à jour
            </div>
          )}
        </div>
      )}

      {/* Barre de progression */}
      {updating && progress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground truncate max-w-[80%]">
              {progress.line}
            </span>
            <span className="text-primary font-medium">
              {progress.percent}%
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Accès au journal complet des événements de la MAJ */}
      {log.length > 0 && (
        <button
          onClick={() => setShowLog(true)}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ScrollText className="w-3.5 h-3.5" />
          Voir le journal ({log.length} ligne{log.length > 1 ? "s" : ""})
        </button>
      )}

      {/* Modal : journal terminal complet */}
      <Dialog
        open={showLog}
        onClose={() => setShowLog(false)}
        title={`Journal de mise à jour — ${machineName}`}
        description={`${log.length} événement${log.length > 1 ? "s" : ""} reçu${
          log.length > 1 ? "s" : ""
        }${updating ? " · en cours…" : ""}`}
        size="xl"
      >
        <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-black/90 text-emerald-300 p-4 max-h-[60vh] overflow-y-auto">
          {log.map((line, i) => (
            <div key={i} className="flex gap-3">
              <span className="select-none text-emerald-700 tabular-nums">
                {String(i + 1).padStart(3, "0")}
              </span>
              <span className="text-emerald-200">{line}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </pre>
      </Dialog>

      {/* Boutons d'action */}
      {!updating && packageData && packageData.total_updates > 0 && (
        <div className="flex gap-3">
          <button
            onClick={() => startUpdate(false)}
            disabled={applicableCount <= 0}
            title={
              deferredCount > 0
                ? `${deferredCount} mise(s) à jour différée(s) ne sera/seront pas installée(s) maintenant par apt`
                : undefined
            }
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-4 h-4" />
            Tout mettre à jour ({applicableCount})
          </button>
          {securityPkgs.length > 0 && (
            <button
              onClick={() => startUpdate(true)}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-500/30 px-4 py-2.5 text-sm font-medium text-amber-400 hover:bg-amber-500/10 transition-colors"
            >
              <Shield className="w-4 h-4" />
              Sécurité ({securityPkgs.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
