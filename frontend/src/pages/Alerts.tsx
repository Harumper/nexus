import { useState, useEffect, useCallback } from "react";
import {
  Bell,
  Plus,
  AlertTriangle,
  CheckCircle2,
  Eye,
  Trash2,
  Zap,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useWebSocket } from "../hooks/useWebSocket";
import { timeAgo } from "../lib/utils";
import type { WSDashboardMessage } from "../types";
import AlertChannelEditor, { type NotificationChannel } from "../components/AlertChannelEditor";
import { Button, Dialog, ConfirmDialog, PageLoader } from "../components/ui";

interface AlertRule {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  severity: "INFO" | "WARNING" | "CRITICAL";
  conditionType: string;
  threshold: number | null;
  targetPattern: string | null;
  durationSeconds: number;
  machineIds: string[];
  cooldownSeconds: number;
  firingCount: number;
  channels: NotificationChannel[] | null;
  createdAt: string;
}

interface AlertState {
  id: string;
  ruleId: string;
  machineId: string;
  status: "FIRING" | "RESOLVED" | "ACKNOWLEDGED";
  firedAt: string;
  resolvedAt: string | null;
  acknowledgedBy: string | null;
  details: any;
  rule: { name: string; severity: string; conditionType: string };
  machine: { id: string; name: string; hostname?: string };
}

const SEVERITY_STYLES = {
  INFO: { bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/20" },
  WARNING: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20" },
  CRITICAL: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20" },
};

const CONDITION_LABELS: Record<string, string> = {
  CPU_ABOVE: "CPU supérieur à",
  MEMORY_ABOVE: "Mémoire supérieure à",
  DISK_ABOVE: "Disque supérieur à",
  MACHINE_OFFLINE: "Machine hors ligne depuis",
  LOAD_ABOVE: "Load average supérieur à",
  SERVICE_FAILED: "Service systemd en échec",
  TIMER_FAILED: "Timer systemd en échec",
  CRON_FAILED: "Cron job en échec",
  UPDATES_AVAILABLE: "Mises à jour disponibles",
  CERT_EXPIRING: "Certificat SSL expirant dans",
};

// Unite du threshold selon conditionType
function thresholdUnit(conditionType: string): string {
  switch (conditionType) {
    case "MACHINE_OFFLINE": return "secondes";
    case "CERT_EXPIRING": return "jours";
    case "UPDATES_AVAILABLE": return "updates";
    case "SERVICE_FAILED":
    case "TIMER_FAILED":
    case "CRON_FAILED":
      return ""; // Pas de threshold, juste filtre optionnel
    default:
      return "%";
  }
}

function needsThreshold(conditionType: string): boolean {
  return !["SERVICE_FAILED", "TIMER_FAILED", "CRON_FAILED"].includes(conditionType);
}

function needsTargetPattern(conditionType: string): boolean {
  return ["SERVICE_FAILED", "TIMER_FAILED", "CRON_FAILED"].includes(conditionType);
}

export default function Alerts() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"active" | "rules" | "history">("active");
  const [activeAlerts, setActiveAlerts] = useState<AlertState[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [history, setHistory] = useState<AlertState[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateRule, setShowCreateRule] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [alertsRes, rulesRes] = await Promise.all([
        fetch("/api/alerts/active", {
          headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
        }),
        fetch("/api/alerts/rules", {
          headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
        }),
      ]);
      setActiveAlerts(await alertsRes.json());
      setRules(await rulesRes.json());
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts/history?limit=100", {
        headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
      });
      const data = await res.json();
      setHistory(data.alerts);
    } catch {}
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (tab === "history") fetchHistory();
  }, [tab, fetchHistory]);

  // WS temps réel
  const handleWsMessage = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.type === "alert.fired") {
        setActiveAlerts((prev) => [msg.data, ...prev]);
      }
      if (msg.type === "alert.resolved") {
        setActiveAlerts((prev) => prev.filter((a) => a.id !== msg.data?.id));
      }
      if (msg.type === "alert.acknowledged") {
        setActiveAlerts((prev) =>
          prev.map((a) =>
            a.id === msg.data?.id
              ? { ...a, status: "ACKNOWLEDGED" as const, acknowledgedBy: msg.data.acknowledgedBy }
              : a
          )
        );
      }
    },
    []
  );
  useWebSocket({ onMessage: handleWsMessage });

  const acknowledgeAlert = async (id: string) => {
    await fetch(`/api/alerts/${id}/acknowledge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
    });
    fetchData();
  };

  const resolveAlert = async (id: string) => {
    await fetch(`/api/alerts/${id}/resolve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
    });
    fetchData();
  };

  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const performDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/alerts/rules/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
      });
      if (!res.ok) throw new Error("Échec de la suppression");
      toast.success("Règle supprimée");
      fetchData();
    } catch (err: any) {
      toast.error(err?.message || "Erreur");
    }
  };

  const toggleRule = async (id: string, enabled: boolean) => {
    await fetch(`/api/alerts/rules/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}`,
      },
      body: JSON.stringify({ enabled }),
    });
    fetchData();
  };

  const [testingRule, setTestingRule] = useState<string | null>(null);

  const testRule = async (id: string, name: string) => {
    setTestingRule(id);
    try {
      const r = await api.testAlertRule(id);
      const failed = r.results.filter((res) => !res.success);
      if (failed.length === 0) {
        toast.success(`Test "${name}" : ${r.ok}/${r.total} canaux OK`, { duration: 4000 });
      } else {
        toast.error(
          `Test "${name}" : ${r.ok}/${r.total} OK · ${failed.length} échec(s)`,
          {
            description: failed.map((f) => `${f.type}: ${f.error}`).join(" · "),
            duration: 8000,
          }
        );
      }
    } catch (err: any) {
      toast.error("Erreur test : " + (err?.message || "unknown"));
    } finally {
      setTestingRule(null);
    }
  };

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Alertes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {activeAlerts.filter((a) => a.status === "FIRING").length} alerte{activeAlerts.filter((a) => a.status === "FIRING").length > 1 ? "s" : ""} active{activeAlerts.filter((a) => a.status === "FIRING").length > 1 ? "s" : ""}
          </p>
        </div>
        {user?.role === "ADMIN" && (
          <button
            onClick={() => setShowCreateRule(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Nouvelle règle
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-border p-1 mb-6 w-fit">
        {(["active", "rules", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === t
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "active" && `Actives (${activeAlerts.length})`}
            {t === "rules" && `Règles (${rules.length})`}
            {t === "history" && "Historique"}
          </button>
        ))}
      </div>

      {/* Active alerts */}
      {tab === "active" && (
        <div className="space-y-3">
          {activeAlerts.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-emerald-400" />
              <p>Aucune alerte active</p>
            </div>
          ) : (
            activeAlerts.map((alert) => {
              const sev = SEVERITY_STYLES[alert.rule.severity as keyof typeof SEVERITY_STYLES] || SEVERITY_STYLES.WARNING;
              return (
                <div
                  key={alert.id}
                  className={`rounded-xl border ${sev.border} ${sev.bg} p-4`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className={`w-5 h-5 mt-0.5 ${sev.text}`} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">
                            {alert.rule.name}
                          </span>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${sev.bg} ${sev.text}`}>
                            {alert.rule.severity}
                          </span>
                          {alert.status === "ACKNOWLEDGED" && (
                            <span className="text-xs text-muted-foreground">
                              (acquitté par {alert.acknowledgedBy})
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          Machine : <span className="text-foreground">{alert.machine.name}</span>
                          {alert.details?.value != null && (
                            <> — Valeur : <span className="text-foreground">{Number(alert.details.value).toFixed(1)}%</span>
                              {alert.details.threshold != null && (
                                <> (seuil : {alert.details.threshold}%)</>
                              )}
                            </>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Déclenchée {timeAgo(alert.firedAt)}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {alert.status === "FIRING" && (
                        <button
                          onClick={() => acknowledgeAlert(alert.id)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => resolveAlert(alert.id)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                      >
                        Résoudre
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Rules */}
      {tab === "rules" && (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="rounded-xl border border-border bg-card p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-2 h-2 rounded-full ${rule.enabled ? "bg-emerald-400" : "bg-zinc-500"}`}
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{rule.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${SEVERITY_STYLES[rule.severity]?.bg} ${SEVERITY_STYLES[rule.severity]?.text}`}>
                      {rule.severity}
                    </span>
                    {rule.firingCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">
                        {rule.firingCount} active{rule.firingCount > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {CONDITION_LABELS[rule.conditionType] || rule.conditionType}
                    {needsThreshold(rule.conditionType) && rule.threshold != null && ` ${rule.threshold} ${thresholdUnit(rule.conditionType)}`}
                    {rule.targetPattern && ` "${rule.targetPattern}"`}
                    {rule.machineIds.length > 0 && ` · ${rule.machineIds.length} machine(s)`}
                    {rule.machineIds.length === 0 && " · Toutes les machines"}
                  </p>
                  {Array.isArray(rule.channels) && rule.channels.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {rule.channels.map((c, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded uppercase font-mono" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}>
                          {c.type}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {user?.role === "ADMIN" && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testRule(rule.id, rule.name)}
                    loading={testingRule === rule.id}
                    icon={<Zap />}
                    title="Envoyer un événement de test sur tous les canaux configurés"
                  >
                    Tester
                  </Button>
                  <Button
                    size="sm"
                    variant={rule.enabled ? "outline" : "outline"}
                    onClick={() => toggleRule(rule.id, !rule.enabled)}
                    className={
                      rule.enabled
                        ? "!border-warning !text-warning hover:!bg-warning-subtle"
                        : "!border-success !text-success hover:!bg-success-subtle"
                    }
                  >
                    {rule.enabled ? "Désactiver" : "Activer"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPendingDelete({ id: rule.id, name: rule.name })}
                    icon={<Trash2 />}
                    aria-label="Supprimer la règle"
                    className="!text-muted-foreground hover:!text-destructive"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* History */}
      {tab === "history" && (
        <div className="space-y-2">
          {history.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              Aucun historique
            </div>
          ) : (
            history.map((alert) => (
              <div
                key={alert.id}
                className="rounded-lg border border-border bg-card px-4 py-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                    alert.status === "RESOLVED" ? "bg-emerald-500/10 text-emerald-400" :
                    alert.status === "FIRING" ? "bg-red-500/10 text-red-400" :
                    "bg-amber-500/10 text-amber-400"
                  }`}>
                    {alert.status === "RESOLVED" ? "Résolu" : alert.status === "FIRING" ? "Actif" : "Acquitté"}
                  </span>
                  <span className="text-sm text-foreground">{alert.rule.name}</span>
                  <span className="text-xs text-muted-foreground">{alert.machine.name}</span>
                </div>
                <span className="text-xs text-muted-foreground">{timeAgo(alert.firedAt)}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Create Rule Dialog */}
      {showCreateRule && (
        <CreateRuleDialog
          onClose={() => setShowCreateRule(false)}
          onCreated={() => {
            setShowCreateRule(false);
            fetchData();
          }}
        />
      )}

      {/* Confirm delete */}
      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await performDelete(pendingDelete.id);
        }}
        title="Supprimer cette règle d'alerte ?"
        description={
          pendingDelete && (
            <>
              La règle <strong>{pendingDelete.name}</strong> sera supprimée définitivement.
              L'historique des alertes déclenchées par cette règle sera conservé.
            </>
          )
        }
        confirmLabel="Supprimer"
        variant="danger"
      />
    </div>
  );
}

function CreateRuleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    conditionType: "CPU_ABOVE",
    threshold: 90,
    targetPattern: "",
    severity: "WARNING",
    durationSeconds: 0,
    cooldownSeconds: 300,
  });
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      // Nettoyer le payload selon le type de condition
      const payload: any = { ...form };
      if (!needsThreshold(form.conditionType)) {
        delete payload.threshold;
      }
      if (!needsTargetPattern(form.conditionType)) {
        delete payload.targetPattern;
      } else if (!payload.targetPattern) {
        delete payload.targetPattern;
      }
      if (channels.length > 0) {
        payload.channels = channels;
      }
      const res = await fetch("/api/alerts/rules", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed");
      }
      onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-card border border-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Nouvelle règle d'alerte</h2>
          <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">{error}</div>}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Nom</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="CPU critique" required />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Condition</label>
            <select value={form.conditionType} onChange={(e) => setForm({ ...form, conditionType: e.target.value })} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
              <optgroup label="Métriques">
                <option value="CPU_ABOVE">CPU supérieur à</option>
                <option value="MEMORY_ABOVE">Mémoire supérieure à</option>
                <option value="DISK_ABOVE">Disque supérieur à</option>
                <option value="LOAD_ABOVE">Load average supérieur à</option>
              </optgroup>
              <optgroup label="Connexion">
                <option value="MACHINE_OFFLINE">Machine hors ligne depuis</option>
              </optgroup>
              <optgroup label="Santé système">
                <option value="SERVICE_FAILED">Service systemd en échec</option>
                <option value="TIMER_FAILED">Timer systemd en échec</option>
                <option value="UPDATES_AVAILABLE">Mises à jour disponibles</option>
                <option value="CERT_EXPIRING">Certificat SSL expirant dans</option>
              </optgroup>
            </select>
          </div>

          {needsThreshold(form.conditionType) && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Seuil ({thresholdUnit(form.conditionType)})
              </label>
              <input type="number" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" min={0} />
            </div>
          )}

          {needsTargetPattern(form.conditionType) && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Filtre (optionnel)
              </label>
              <input
                type="text"
                value={form.targetPattern}
                onChange={(e) => setForm({ ...form, targetPattern: e.target.value })}
                placeholder={form.conditionType === "SERVICE_FAILED" ? "nginx, postgresql (laissez vide pour tous)" : "pattern"}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Substring matching. Vide = n'importe quel service en échec déclenche.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Sévérité</label>
            <div className="flex gap-2">
              {(["INFO", "WARNING", "CRITICAL"] as const).map((s) => (
                <button key={s} type="button" onClick={() => setForm({ ...form, severity: s })} className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${form.severity === s ? `${SEVERITY_STYLES[s].bg} ${SEVERITY_STYLES[s].border} ${SEVERITY_STYLES[s].text}` : "border-border text-muted-foreground"}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Canaux de notification</label>
            <p className="text-[11px] text-muted-foreground mb-2">
              Discord, Slack, Microsoft Teams, Email ou Webhook personnalisé. Aucun = pas de notification (visible uniquement dans l'UI/dashboard).
            </p>
            <AlertChannelEditor value={channels} onChange={setChannels} />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors">Annuler</button>
            <button type="submit" disabled={loading || !form.name} className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors">{loading ? "Création..." : "Créer"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
