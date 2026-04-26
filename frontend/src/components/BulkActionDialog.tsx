import { useState } from "react";
import { Play, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import type { Machine } from "../types";
import { Dialog, Button, Input } from "./ui";
import { getErrorMessage } from "../services/errors";

interface Props {
  machines: Machine[];
  onClose: () => void;
  onCompleted?: () => void;
}

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
  const [confirmInput, setConfirmInput] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<{ total: number; success: number; failed: number; skipped: number } | null>(null);

  const action = BULK_ACTIONS.find((a) => a.id === actionId);
  const onlineMachines = machines.filter((m) => m.status === "ONLINE");
  const nonAgent = machines.filter((m) => m.type !== "AGENT");
  const critical = machines.filter((m) => m.isCritical);

  const handleRun = async () => {
    if (!action) return;
    if (action.confirmText && confirmInput !== action.confirmText) {
      toast.error(`Tapez "${action.confirmText}" pour confirmer`);
      return;
    }

    setRunning(true);
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
      if (res.summary.failed === 0) {
        toast.success(`${res.summary.success}/${res.summary.total} machines OK`);
      } else {
        toast.error(`${res.summary.failed} échec(s) sur ${res.summary.total}`);
      }
      if (onCompleted) onCompleted();
    } catch (err) {
      toast.error(getErrorMessage(err, "Erreur"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open
      onClose={running ? () => {} : onClose}
      size="lg"
      title={
        <span>
          Action groupée
          <span className="block text-xs font-normal text-muted-foreground mt-0.5">
            {machines.length} machine{machines.length > 1 ? "s" : ""}
            {onlineMachines.length !== machines.length && ` · ${onlineMachines.length} en ligne`}
          </span>
        </span>
      }
      footer={
        results === null ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose} disabled={running}>
              Annuler
            </Button>
            <Button
              variant={action?.destructive ? "danger" : "primary"}
              size="sm"
              onClick={handleRun}
              disabled={!action}
              loading={running}
              icon={<Play />}
            >
              {action?.destructive ? "Exécuter (destructif)" : "Exécuter"}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={onClose}>
            Fermer
          </Button>
        )
      }
    >
      {results === null && !running && (
        <div className="space-y-4">
          {nonAgent.length > 0 && (
            <div className="rounded-lg p-3 text-xs flex items-start gap-2 bg-warning-subtle text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                {nonAgent.length} machine{nonAgent.length > 1 ? "s" : ""} de type PROBE :
                les actions de mutation seront refusées.
              </div>
            </div>
          )}

          {critical.length > 0 && (
            <div className="rounded-lg p-3 text-xs flex items-start gap-2 bg-warning-subtle text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong>
                  {critical.length} machine{critical.length > 1 ? "s" : ""} critique
                  {critical.length > 1 ? "s" : ""}
                </strong>{" "}
                ({critical.map((m) => m.name).join(", ")}) : reboot, stop de services
                critiques (docker, nginx, ssh…) et suppression de paquets critiques seront
                refusés.
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1.5">Action à exécuter</label>
            <select
              value={actionId}
              onChange={(e) => {
                setActionId(e.target.value);
                setParamValue("");
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">— Choisir une action —</option>
              {BULK_ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            {action && (
              <p className="text-[11px] mt-1 text-muted-foreground">
                {action.description}
                {action.destructive && (
                  <span className="ml-2 font-semibold text-destructive">⚠ Destructif</span>
                )}
              </p>
            )}
          </div>

          {action?.paramsUI === "service" && (
            <div>
              <label className="block text-xs font-medium mb-1.5">
                Nom du service (sans .service)
              </label>
              <Input
                value={paramValue}
                onChange={(e) => setParamValue(e.target.value)}
                placeholder="nginx, postgresql, cron…"
                className="font-mono"
              />
            </div>
          )}

          {action?.paramsUI === "package" && (
            <div>
              <label className="block text-xs font-medium mb-1.5">Nom du paquet APT</label>
              <Input
                value={paramValue}
                onChange={(e) => setParamValue(e.target.value)}
                placeholder="htop, nginx, curl…"
                className="font-mono"
              />
            </div>
          )}

          {action?.confirmText && (
            <div>
              <label className="block text-xs font-medium mb-1.5 text-destructive">
                Tapez <code className="font-mono">{action.confirmText}</code> pour confirmer
              </label>
              <Input
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                className="font-mono"
              />
            </div>
          )}

          <div className="rounded-lg p-3 text-xs bg-elevated">
            <div className="font-medium mb-1">Machines ciblées :</div>
            <div className="flex flex-wrap gap-1">
              {machines.slice(0, 20).map((m) => (
                <span
                  key={m.id}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    m.status === "ONLINE"
                      ? "bg-success-subtle text-success"
                      : "bg-background text-muted-foreground"
                  }`}
                >
                  {m.name}
                </span>
              ))}
              {machines.length > 20 && (
                <span className="text-[10px] text-muted-foreground">
                  +{machines.length - 20} autres
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {running && (
        <div className="py-12 text-center">
          <div className="inline-block w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3 motion-reduce:animate-none" />
          <div className="text-sm font-medium">Exécution en cours...</div>
          <div className="text-xs mt-1 text-muted-foreground">
            Dispatch sur {machines.length} machines, batchs de 10 en parallèle
          </div>
        </div>
      )}

      {results !== null && summary && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2 text-center">
            <StatCard label="Total" value={summary.total} />
            <StatCard label="Succès" value={summary.success} tone="success" />
            <StatCard label="Échec" value={summary.failed} tone="danger" />
            <StatCard label="Skippé" value={summary.skipped} />
          </div>

          <div className="rounded-xl border border-border overflow-hidden bg-elevated">
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground">
                    <th className="text-left px-3 py-2">Machine</th>
                    <th className="text-left px-3 py-2">Statut</th>
                    <th className="text-left px-3 py-2">Détail</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.machineId} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono">{r.machineName}</td>
                      <td className="px-3 py-1.5">
                        {r.skipped ? (
                          <span className="text-muted-foreground">— skippé</span>
                        ) : r.success ? (
                          <span className="inline-flex items-center gap-1 text-success">
                            <Check className="w-3 h-3" /> OK
                          </span>
                        ) : (
                          <span className="text-destructive">✗ Échec</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 truncate max-w-md text-muted-foreground">
                        {r.error || (r.data ? "exécuté" : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  const colorClass =
    tone === "success" ? "text-success" : tone === "danger" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-lg p-3 bg-elevated">
      <div className={`text-xl font-bold tabular-nums ${colorClass}`}>{value}</div>
      <div className="text-[10px] uppercase mt-0.5 text-muted-foreground">{label}</div>
    </div>
  );
}
