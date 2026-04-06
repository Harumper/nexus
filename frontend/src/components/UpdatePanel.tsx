import { useState, useCallback } from "react";
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
} from "lucide-react";
import { api } from "../services/api";
import { useWebSocket } from "../hooks/useWebSocket";
import type { WSDashboardMessage } from "../types";

interface UpdatePanelProps {
  machineId: string;
  machineName: string;
  capabilities: string[];
}

interface PendingPackage {
  name: string;
  current_version: string;
  new_version: string;
  security_update: boolean;
}

interface PackageListResult {
  package_manager: string;
  total_updates: number;
  security_updates: number;
  packages: PendingPackage[];
}

interface UpdateProgress {
  line: string;
  percent: number;
}

export default function UpdatePanel({
  machineId,
  machineName,
  capabilities,
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

  const hasUpdatesCap = capabilities.includes("updates");

  // WebSocket pour la progression des MAJ
  const handleWsMessage = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.type === "update.progress" && msg.machine_id === machineId) {
        setProgress(msg.data as UpdateProgress);
        if (msg.data?.percent === 100) {
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

  // Charger la liste des packages (synchrone — attend la réponse de l'agent)
  const checkUpdates = async () => {
    setLoadingList(true);
    setResult(null);
    setPackageData(null);
    try {
      const resp = await api.dispatchActionSync<PackageListResult>(
        machineId,
        "system.package_list",
        undefined,
        60_000 // 60s timeout (apt-get update peut être lent)
      );
      setPackageData(resp.data);
    } catch (err: any) {
      setResult({ success: false, message: err.message || "Erreur" });
    } finally {
      setLoadingList(false);
    }
  };

  // Lancer une mise à jour
  const startUpdate = async (securityOnly: boolean) => {
    setUpdating(true);
    setProgress({ line: "Démarrage de la mise à jour...", percent: 0 });
    setResult(null);
    try {
      const actionId = securityOnly
        ? "system.update_security"
        : "system.update";
      await api.dispatchAction(machineId, actionId);
    } catch (err: any) {
      setUpdating(false);
      setProgress(null);
      setResult({ success: false, message: err.message });
    }
  };

  if (!hasUpdatesCap) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Shield className="w-5 h-5" />
          <div>
            <p className="text-sm font-medium text-foreground">
              Mises à jour non disponibles
            </p>
            <p className="text-xs mt-0.5">
              La capability "updates" n'est pas assignée à cette machine.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const securityPkgs =
    packageData?.packages.filter((p) => p.security_update) ?? [];
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
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted">
              <span className="text-xs text-muted-foreground">
                via {packageData.package_manager}
              </span>
            </div>
          </div>

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
                  </tr>
                </thead>
                <tbody>
                  {displayedPackages.map((pkg, i) => (
                    <tr
                      key={i}
                      className="border-b border-border/30 last:border-0"
                    >
                      <td className="px-3 py-1.5 text-xs font-mono text-foreground">
                        {pkg.name}
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
                    </tr>
                  ))}
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

      {/* Boutons d'action */}
      {!updating && packageData && packageData.total_updates > 0 && (
        <div className="flex gap-3">
          <button
            onClick={() => startUpdate(false)}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Download className="w-4 h-4" />
            Tout mettre à jour ({packageData.total_updates})
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
