import { useState, useEffect, useCallback } from "react";
import {
  Puzzle,
  Power,
  PowerOff,
  Trash2,
  Settings,
  Container,
  HardDrive,
  Archive,
} from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { timeAgo } from "../lib/utils";

interface Module {
  id: string;
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
  capability: string;
  actions: string[];
  config: any;
  installedAt: string;
}

const MODULE_ICONS: Record<string, typeof Puzzle> = {
  nautilus: Container,
  zfs: HardDrive,
  backup: Archive,
};

const MODULE_COLORS: Record<string, string> = {
  nautilus: "text-blue-400",
  zfs: "text-amber-400",
  backup: "text-emerald-400",
};

export default function Modules() {
  const { user } = useAuth();
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchModules = useCallback(async () => {
    try {
      const res = await fetch("/api/modules", {
        headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
      });
      setModules(await res.json());
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModules();
  }, [fetchModules]);

  const toggleModule = async (name: string, enable: boolean) => {
    await fetch(`/api/modules/${name}/${enable ? "enable" : "disable"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
    });
    fetchModules();
  };

  const deleteModule = async (name: string) => {
    if (!confirm(`Supprimer le module "${name}" ?`)) return;
    await fetch(`/api/modules/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionStorage.getItem("nexus_token")}` },
    });
    fetchModules();
  };

  const isAdmin = user?.role === "ADMIN";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Modules</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Extensions pour étendre les capabilities de Nexus
        </p>
      </div>

      {modules.length === 0 ? (
        <div className="text-center py-20">
          <Puzzle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">
            Aucun module installé
          </h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Les modules sont des binaires Go séparés qui communiquent avec l'agent
            via Unix socket. Déployez un module sur une machine et il apparaîtra ici.
          </p>
          <div className="mt-6 rounded-xl border border-border bg-card p-6 max-w-lg mx-auto text-left">
            <h4 className="text-sm font-semibold text-foreground mb-3">
              Modules disponibles
            </h4>
            <div className="space-y-3">
              <AvailableModule
                name="Nautilus"
                description="Gestion Docker : containers, images, stacks compose"
                icon={Container}
                color="text-blue-400"
              />
              <AvailableModule
                name="ZFS"
                description="Gestion ZFS : pools, datasets, snapshots"
                icon={HardDrive}
                color="text-amber-400"
              />
              <AvailableModule
                name="Backup"
                description="Sauvegardes planifiées et points de restauration"
                icon={Archive}
                color="text-emerald-400"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {modules.map((module) => {
            const Icon = MODULE_ICONS[module.name] || Puzzle;
            const color = MODULE_COLORS[module.name] || "text-primary";

            return (
              <div
                key={module.id}
                className="rounded-xl border border-border bg-card p-5"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                      <Icon className={`w-5 h-5 ${color}`} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">
                          {module.name}
                        </h3>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          v{module.version}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {module.description}
                      </p>
                    </div>
                  </div>

                  <div
                    className={`w-2 h-2 rounded-full mt-2 ${module.enabled ? "bg-emerald-400" : "bg-zinc-500"}`}
                  />
                </div>

                {/* Capability & Actions */}
                <div className="mb-4">
                  <div className="text-xs text-muted-foreground mb-1.5">
                    Capability : <span className="text-foreground font-medium">{module.capability}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {module.actions.map((action) => (
                      <span
                        key={action}
                        className="px-2 py-0.5 rounded text-[10px] font-mono bg-muted text-muted-foreground"
                      >
                        {action}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="text-xs text-muted-foreground mb-4">
                  Installé {timeAgo(module.installedAt)}
                </div>

                {/* Actions */}
                {isAdmin && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => toggleModule(module.name, !module.enabled)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        module.enabled
                          ? "border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                          : "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                      }`}
                    >
                      {module.enabled ? (
                        <>
                          <PowerOff className="w-3.5 h-3.5" />
                          Désactiver
                        </>
                      ) : (
                        <>
                          <Power className="w-3.5 h-3.5" />
                          Activer
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => deleteModule(module.name)}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AvailableModule({
  name,
  description,
  icon: Icon,
  color,
}: {
  name: string;
  description: string;
  icon: typeof Puzzle;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/50">
      <Icon className={`w-5 h-5 ${color} shrink-0`} />
      <div>
        <span className="text-sm font-medium text-foreground">{name}</span>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
