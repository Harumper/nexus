import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Play, Square, RotateCcw, FileText, Loader2, Search } from "lucide-react";
import { api } from "../services/api";

interface SystemdUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

interface ServicesTabProps {
  machineId: string;
  onViewLogs?: (service: string) => void;
}

type ActionKind = "start" | "stop" | "restart";

export default function ServicesTab({ machineId, onViewLogs }: ServicesTabProps) {
  const [services, setServices] = useState<SystemdUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "active" | "inactive" | "failed">("all");
  const [actingOn, setActingOn] = useState<{ service: string; action: ActionKind } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listServices(machineId);
      const list = (res?.data?.services || []) as SystemdUnit[];
      // Ne garder que les .service
      const filtered = list.filter(u => (u.unit || "").endsWith(".service"));
      setServices(filtered);
    } catch (err: any) {
      setError(err?.message || "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => { load(); }, [load]);

  const handleAction = async (service: string, action: ActionKind) => {
    const verb = action === "start" ? "Démarrer" : action === "stop" ? "Arrêter" : "Redémarrer";
    if (!confirm(`${verb} ${service} ?`)) return;
    setActingOn({ service, action });
    try {
      await api.serviceAction(machineId, service, action);
      await load();
    } catch (err: any) {
      alert(`Erreur : ${err?.message || "action échouée"}`);
    } finally {
      setActingOn(null);
    }
  };

  const filtered = services.filter(s => {
    if (search && !s.unit.toLowerCase().includes(search.toLowerCase()) &&
        !(s.description || "").toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    if (stateFilter !== "all") {
      if (stateFilter === "failed" && s.active !== "failed") return false;
      if (stateFilter === "active" && s.active !== "active") return false;
      if (stateFilter === "inactive" && s.active !== "inactive") return false;
    }
    return true;
  });

  const stateColor = (active: string) => {
    switch (active) {
      case "active": return "var(--nx-success)";
      case "failed": return "var(--nx-danger)";
      case "inactive": return "var(--nx-text-weak)";
      default: return "var(--nx-warning)";
    }
  };

  return (
    <div className="space-y-4">
      {/* Header + filtres */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--nx-text-weak)" }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un service..."
            className="w-full rounded-lg border border-input bg-background pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as any)}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">Tous</option>
          <option value="active">Actifs</option>
          <option value="inactive">Inactifs</option>
          <option value="failed">En échec</option>
        </select>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Rafraîchir
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="flex gap-4 text-xs">
        <span style={{ color: "var(--nx-text-weak)" }}>
          Total : {services.length}
        </span>
        <span style={{ color: "var(--nx-success)" }}>
          Actifs : {services.filter(s => s.active === "active").length}
        </span>
        <span style={{ color: "var(--nx-danger)" }}>
          Échec : {services.filter(s => s.active === "failed").length}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
        <table className="w-full text-sm">
          <thead style={{ background: "var(--nx-bg-elevated)" }}>
            <tr className="text-xs uppercase" style={{ color: "var(--nx-text-weak)" }}>
              <th className="px-4 py-2 text-left">Service</th>
              <th className="px-4 py-2 text-left">État</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm" style={{ color: "var(--nx-text-weak)" }}>
                  Aucun service trouvé.
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr key={s.unit} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                  <td className="px-4 py-2 font-mono text-xs">{s.unit}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full" style={{ background: stateColor(s.active) }} />
                      {s.active} / {s.sub}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs truncate max-w-[300px]" style={{ color: "var(--nx-text-weak)" }}>
                    {s.description}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1 justify-end">
                      {onViewLogs && (
                        <button
                          onClick={() => onViewLogs(s.unit)}
                          className="p-1.5 rounded hover:bg-muted transition-colors"
                          title="Voir les logs"
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {s.active !== "active" && (
                        <button
                          onClick={() => handleAction(s.unit, "start")}
                          disabled={actingOn?.service === s.unit}
                          className="p-1.5 rounded hover:bg-muted transition-colors"
                          title="Démarrer"
                          style={{ color: "var(--nx-success)" }}
                        >
                          {actingOn?.service === s.unit && actingOn.action === "start" ?
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                            <Play className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {s.active === "active" && (
                        <>
                          <button
                            onClick={() => handleAction(s.unit, "restart")}
                            disabled={actingOn?.service === s.unit}
                            className="p-1.5 rounded hover:bg-muted transition-colors"
                            title="Redémarrer"
                            style={{ color: "var(--nx-info)" }}
                          >
                            {actingOn?.service === s.unit && actingOn.action === "restart" ?
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                              <RotateCcw className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={() => handleAction(s.unit, "stop")}
                            disabled={actingOn?.service === s.unit}
                            className="p-1.5 rounded hover:bg-muted transition-colors"
                            title="Arrêter"
                            style={{ color: "var(--nx-warning)" }}
                          >
                            {actingOn?.service === s.unit && actingOn.action === "stop" ?
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                              <Square className="w-3.5 h-3.5" />}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
