import { useState } from "react";
import { X, Play, Loader2, Check, AlertTriangle } from "lucide-react";
import { api } from "../services/api";
import type { Machine } from "../types";

interface Props {
  machines: Machine[];
  onClose: () => void;
  onCompleted?: () => void;
}

// Actions disponibles en bulk avec leur config
const BULK_ACTIONS: {
  id: string;
  label: string;
  description: string;
  paramsUI?: "service" | "package" | "script";
  destructive?: boolean;
  confirmText?: string;
}[] = [
  { id: "system.update", label: "Mise à jour système", description: "apt upgrade complet" },
  { id: "system.update_security", label: "Mises à jour sécu uniquement", description: "apt upgrade -s" },
  { id: "system.reboot", label: "Redémarrer", description: "systemctl reboot (60s avant retour)", destructive: true, confirmText: "REBOOT" },
  { id: "agent.upgrade", label: "Mettre à jour l'agent Nexus", description: "Self-upgrade + restart" },
  { id: "system.service_restart", label: "Redémarrer un service", description: "systemctl restart", paramsUI: "service" },
  { id: "system.service_start", label: "Démarrer un service", description: "systemctl start", paramsUI: "service" },
  { id: "system.service_stop", label: "Arrêter un service", description: "systemctl stop", paramsUI: "service" },
  { id: "package.install", label: "Installer un paquet", description: "apt install", paramsUI: "package" },
  { id: "package.remove", label: "Supprimer un paquet", description: "apt remove", paramsUI: "package", destructive: true },
  { id: "package.hold", label: "Bloquer un paquet (hold)", description: "apt-mark hold", paramsUI: "package" },
  { id: "package.unhold", label: "Débloquer un paquet", description: "apt-mark unhold", paramsUI: "package" },
];

export default function BulkActionDialog({ machines, onClose, onCompleted }: Props) {
  const [actionId, setActionId] = useState<string>("");
  const [paramValue, setParamValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<{ total: number; success: number; failed: number; skipped: number } | null>(null);
  const [error, setError] = useState("");

  const action = BULK_ACTIONS.find((a) => a.id === actionId);

  const onlineMachines = machines.filter((m) => m.status === "ONLINE");
  const nonAgent = machines.filter((m) => m.type !== "AGENT");

  const handleRun = async () => {
    if (!action) return;

    if (action.confirmText && confirmInput !== action.confirmText) {
      setError(`Tapez "${action.confirmText}" pour confirmer`);
      return;
    }

    setRunning(true);
    setError("");
    try {
      const params: Record<string, unknown> = {};
      if (action.paramsUI === "service") {
        if (!paramValue) throw new Error("Service requis");
        params.service = paramValue;
      } else if (action.paramsUI === "package") {
        if (!paramValue) throw new Error("Paquet requis");
        params.name = paramValue;
      }

      const res = await api.bulkDispatch({
        action_id: actionId,
        params,
        machineIds: machines.map((m) => m.id),
        mode: "sync",
        timeout: 60_000,
      });
      setResults(res.results);
      setSummary(res.summary);
      if (onCompleted) onCompleted();
    } catch (err: any) {
      setError(err?.message || "Erreur");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={running ? undefined : onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl overflow-hidden max-h-[90vh] flex flex-col"
        style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--nx-border)" }}>
          <div>
            <h2 className="text-sm font-semibold">Action groupée</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
              {machines.length} machine{machines.length > 1 ? "s" : ""} sélectionnée{machines.length > 1 ? "s" : ""}
              {onlineMachines.length !== machines.length && ` · ${onlineMachines.length} en ligne`}
            </p>
          </div>
          <button onClick={onClose} disabled={running} className="p-1 rounded hover:bg-muted disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {results === null && !running && (
            <>
              {nonAgent.length > 0 && (
                <div className="rounded-lg p-3 text-xs flex items-start gap-2" style={{ background: "var(--nx-warning-subtle)", color: "var(--nx-warning)" }}>
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    {nonAgent.length} machine{nonAgent.length > 1 ? "s" : ""} de type PROBE : les actions de mutation seront refusées.
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium mb-1.5">Action à exécuter</label>
                <select
                  value={actionId}
                  onChange={(e) => { setActionId(e.target.value); setParamValue(""); setError(""); }}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">— Choisir une action —</option>
                  {BULK_ACTIONS.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
                {action && (
                  <p className="text-[11px] mt-1" style={{ color: "var(--nx-text-weak)" }}>
                    {action.description}
                    {action.destructive && <span className="ml-2 font-semibold" style={{ color: "var(--nx-danger)" }}>⚠ Destructif</span>}
                  </p>
                )}
              </div>

              {action?.paramsUI === "service" && (
                <div>
                  <label className="block text-xs font-medium mb-1.5">Nom du service (sans .service)</label>
                  <input
                    type="text"
                    value={paramValue}
                    onChange={(e) => setParamValue(e.target.value)}
                    placeholder="nginx, postgresql, cron…"
                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm font-mono"
                  />
                </div>
              )}

              {action?.paramsUI === "package" && (
                <div>
                  <label className="block text-xs font-medium mb-1.5">Nom du paquet APT</label>
                  <input
                    type="text"
                    value={paramValue}
                    onChange={(e) => setParamValue(e.target.value)}
                    placeholder="htop, nginx, curl…"
                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm font-mono"
                  />
                </div>
              )}

              {action?.confirmText && (
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--nx-danger)" }}>
                    Tapez <code className="font-mono">{action.confirmText}</code> pour confirmer
                  </label>
                  <input
                    type="text"
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm font-mono"
                  />
                </div>
              )}

              <div className="rounded-lg p-3 text-xs" style={{ background: "var(--nx-bg-elevated)" }}>
                <div className="font-medium mb-1">Machines ciblées :</div>
                <div className="flex flex-wrap gap-1">
                  {machines.slice(0, 20).map((m) => (
                    <span key={m.id} className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{
                      background: m.status === "ONLINE" ? "var(--nx-success-subtle)" : "var(--nx-bg-base)",
                      color: m.status === "ONLINE" ? "var(--nx-success)" : "var(--nx-text-weak)",
                    }}>
                      {m.name}
                    </span>
                  ))}
                  {machines.length > 20 && (
                    <span className="text-[10px]" style={{ color: "var(--nx-text-weak)" }}>
                      +{machines.length - 20} autres
                    </span>
                  )}
                </div>
              </div>

              {error && (
                <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
                  {error}
                </div>
              )}
            </>
          )}

          {running && (
            <div className="py-12 text-center">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
              <div className="text-sm font-medium">Exécution en cours...</div>
              <div className="text-xs mt-1" style={{ color: "var(--nx-text-weak)" }}>
                Dispatch sur {machines.length} machines, batchs de 10 en parallèle
              </div>
            </div>
          )}

          {results !== null && summary && (
            <>
              <div className="grid grid-cols-4 gap-2 text-center">
                <StatCard label="Total" value={summary.total} />
                <StatCard label="Succès" value={summary.success} color="var(--nx-success)" />
                <StatCard label="Échec" value={summary.failed} color="var(--nx-danger)" />
                <StatCard label="Skippé" value={summary.skipped} color="var(--nx-text-weak)" />
              </div>

              <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-elevated)" }}>
                <div className="max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0" style={{ background: "var(--nx-bg-surface)" }}>
                      <tr style={{ color: "var(--nx-text-weak)" }}>
                        <th className="text-left px-3 py-2">Machine</th>
                        <th className="text-left px-3 py-2">Statut</th>
                        <th className="text-left px-3 py-2">Détail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r) => (
                        <tr key={r.machineId} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                          <td className="px-3 py-1.5 font-mono">{r.machineName}</td>
                          <td className="px-3 py-1.5">
                            {r.skipped ? (
                              <span style={{ color: "var(--nx-text-weak)" }}>— skippé</span>
                            ) : r.success ? (
                              <span className="inline-flex items-center gap-1" style={{ color: "var(--nx-success)" }}>
                                <Check className="w-3 h-3" /> OK
                              </span>
                            ) : (
                              <span style={{ color: "var(--nx-danger)" }}>✗ Échec</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 truncate max-w-md" style={{ color: "var(--nx-text-weak)" }}>
                            {r.error || (r.data ? "exécuté" : "—")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 flex justify-end gap-2" style={{ borderTop: "1px solid var(--nx-border)" }}>
          {results === null ? (
            <>
              <button
                onClick={onClose}
                disabled={running}
                className="rounded-lg px-3 py-1.5 text-xs font-medium"
                style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
              >
                Annuler
              </button>
              <button
                onClick={() => { setConfirming(true); handleRun(); }}
                disabled={running || !action}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                style={{ background: action?.destructive ? "var(--nx-danger)" : "var(--nx-primary)", color: "var(--nx-bg-base)" }}
              >
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {action?.destructive ? "Exécuter (destructif)" : "Exécuter"}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-xs font-medium"
              style={{ background: "var(--nx-primary)", color: "var(--nx-bg-base)" }}
            >
              Fermer
            </button>
          )}
          {confirming && <span className="hidden" />}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: "var(--nx-bg-elevated)" }}>
      <div className="text-xl font-bold tabular-nums" style={{ color: color || "var(--nx-text)" }}>
        {value}
      </div>
      <div className="text-[10px] uppercase mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
        {label}
      </div>
    </div>
  );
}
