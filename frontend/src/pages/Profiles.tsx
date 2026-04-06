import { useState, useEffect, useCallback } from "react";
import {
  Zap,
  Plus,
  Trash2,
  Edit2,
  Play,
  Clock,
  Terminal,
  Package,
  RefreshCw,
  X,
} from "lucide-react";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { timeAgo } from "../lib/utils";
import type { Profile, ProfileExecution } from "../types";

const TYPE_STYLES: Record<
  Profile["type"],
  { bg: string; text: string; label: string }
> = {
  UPGRADE: { bg: "bg-blue-500/10", text: "text-blue-400", label: "Upgrade" },
  REBOOT: { bg: "bg-amber-500/10", text: "text-amber-400", label: "Reboot" },
  SCRIPT: { bg: "bg-purple-500/10", text: "text-purple-400", label: "Script" },
  PACKAGE: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    label: "Package",
  },
};

const EXEC_STATUS_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  PENDING: { bg: "bg-zinc-500/10", text: "text-zinc-400", label: "En attente" },
  RUNNING: { bg: "bg-blue-500/10", text: "text-blue-400", label: "En cours" },
  COMPLETED: { bg: "bg-emerald-500/10", text: "text-emerald-400", label: "Terminé" },
  FAILED: { bg: "bg-red-500/10", text: "text-red-400", label: "Échoué" },
  SKIPPED: { bg: "bg-amber-500/10", text: "text-amber-400", label: "Ignoré" },
};

const TYPE_ICONS: Record<Profile["type"], typeof Zap> = {
  UPGRADE: RefreshCw,
  REBOOT: RefreshCw,
  SCRIPT: Terminal,
  PACKAGE: Package,
};

const DAYS_LABELS = [
  { key: "lun", label: "Lun" },
  { key: "mar", label: "Mar" },
  { key: "mer", label: "Mer" },
  { key: "jeu", label: "Jeu" },
  { key: "ven", label: "Ven" },
  { key: "sam", label: "Sam" },
  { key: "dim", label: "Dim" },
];

export default function Profiles() {
  const { user } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [executeProfile, setExecuteProfile] = useState<Profile | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<ProfileExecution[]>([]);
  const [loadingExecs, setLoadingExecs] = useState(false);

  const fetchProfiles = useCallback(async () => {
    try {
      const data = await api.getProfiles();
      setProfiles(data);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const handleDelete = async (id: string) => {
    if (!confirm("Supprimer ce profil ?")) return;
    try {
      await api.deleteProfile(id);
      fetchProfiles();
    } catch {}
  };

  const handleToggle = async (profile: Profile) => {
    try {
      await api.updateProfile(profile.id, { enabled: !profile.enabled });
      fetchProfiles();
    } catch {}
  };

  const handleExecute = async (profile: Profile) => {
    setExecutingId(profile.id);
    try {
      const result = await api.executeProfile(profile.id);
      alert(`Profil exécuté sur ${result.executed} machine(s).`);
      fetchProfiles();
    } catch (err: any) {
      alert(`Erreur : ${err.message}`);
    } finally {
      setExecutingId(null);
      setExecuteProfile(null);
    }
  };

  const handleExpand = async (profileId: string) => {
    if (expandedId === profileId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(profileId);
    setLoadingExecs(true);
    try {
      const data = await api.getProfileExecutions(profileId);
      setExecutions(data.executions);
    } catch {
      setExecutions([]);
    } finally {
      setLoadingExecs(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Profils</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {profiles.length} profil{profiles.length > 1 ? "s" : ""}
          </p>
        </div>
        {user?.role === "ADMIN" && (
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Créer un profil
          </button>
        )}
      </div>

      {/* Profiles list */}
      {profiles.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Zap className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p>Aucun profil créé</p>
        </div>
      ) : (
        <div className="space-y-3">
          {profiles.map((profile) => {
            const typeStyle = TYPE_STYLES[profile.type];
            const TypeIcon = TYPE_ICONS[profile.type];
            const isExpanded = expandedId === profile.id;

            return (
              <div key={profile.id}>
                <div
                  className="rounded-xl border border-border bg-card p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => handleExpand(profile.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-lg ${typeStyle.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}
                      >
                        <TypeIcon className={`w-4 h-4 ${typeStyle.text}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-foreground">
                            {profile.name}
                          </span>
                          <span
                            className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${typeStyle.bg} ${typeStyle.text}`}
                          >
                            {typeStyle.label}
                          </span>
                          <span
                            className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                              profile.enabled
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-zinc-500/10 text-zinc-400"
                            }`}
                          >
                            {profile.enabled ? "Actif" : "Inactif"}
                          </span>
                        </div>
                        {profile.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">
                            {profile.description}
                          </p>
                        )}
                        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                          {profile.tagFilters.length > 0 && (
                            <div className="flex items-center gap-1 flex-wrap">
                              {profile.tagFilters.map((tag) => (
                                <span
                                  key={tag}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {profile._count?.executions ?? 0} exécution
                            {(profile._count?.executions ?? 0) > 1 ? "s" : ""}
                          </span>
                          {profile.lastExecution && (
                            <span className="text-xs text-muted-foreground">
                              Dernière : {timeAgo(profile.lastExecution)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {user?.role === "ADMIN" && (
                      <div
                        className="flex items-center gap-1 flex-shrink-0 ml-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => handleToggle(profile)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            profile.enabled
                              ? "text-emerald-400 hover:bg-emerald-500/10"
                              : "text-zinc-400 hover:bg-zinc-500/10"
                          }`}
                          title={
                            profile.enabled ? "Désactiver" : "Activer"
                          }
                        >
                          <Zap className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingProfile(profile)}
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          title="Modifier"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setExecuteProfile(profile)}
                          disabled={executingId === profile.id}
                          className="p-1.5 rounded-lg text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
                          title="Exécuter maintenant"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(profile.id)}
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title="Supprimer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Expanded execution history */}
                {isExpanded && (
                  <div className="ml-4 mt-1 rounded-lg border border-border bg-card/50 overflow-hidden">
                    <div className="px-4 py-2 border-b border-border bg-muted/30">
                      <span className="text-xs font-medium text-foreground">
                        Historique des exécutions
                      </span>
                    </div>
                    {loadingExecs ? (
                      <div className="flex items-center justify-center py-6">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
                      </div>
                    ) : executions.length === 0 ? (
                      <div className="text-center py-6 text-xs text-muted-foreground">
                        Aucune exécution
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {executions.map((exec) => {
                          const st =
                            EXEC_STATUS_STYLES[exec.status] ||
                            EXEC_STATUS_STYLES.PENDING;
                          return (
                            <div
                              key={exec.id}
                              className="px-4 py-2.5 flex items-center justify-between text-xs"
                            >
                              <div className="flex items-center gap-3">
                                <span
                                  className={`px-2 py-0.5 rounded font-medium ${st.bg} ${st.text}`}
                                >
                                  {st.label}
                                </span>
                                <span className="text-foreground">
                                  {exec.machine?.name || exec.machineId}
                                </span>
                              </div>
                              <div className="flex items-center gap-4 text-muted-foreground">
                                <span>{timeAgo(exec.startedAt)}</span>
                                {exec.completedAt && (
                                  <span>
                                    Terminé {timeAgo(exec.completedAt)}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <ProfileDialog
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            fetchProfiles();
          }}
        />
      )}

      {/* Edit Dialog */}
      {editingProfile && (
        <ProfileDialog
          profile={editingProfile}
          onClose={() => setEditingProfile(null)}
          onSaved={() => {
            setEditingProfile(null);
            fetchProfiles();
          }}
        />
      )}

      {/* Execute Confirmation Dialog */}
      {executeProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setExecuteProfile(null)}
          />
          <div className="relative w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl p-6">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              Exécuter le profil
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              Exécuter le profil{" "}
              <span className="text-foreground font-medium">
                {executeProfile.name}
              </span>{" "}
              sur les machines correspondantes ?
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setExecuteProfile(null)}
                className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={() => handleExecute(executeProfile)}
                disabled={executingId === executeProfile.id}
                className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-2"
              >
                <Play className="w-4 h-4" />
                {executingId === executeProfile.id
                  ? "Exécution..."
                  : "Exécuter"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Profile Create/Edit Dialog ─────────────────────────────────────────

function ProfileDialog({
  profile,
  onClose,
  onSaved,
}: {
  profile?: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!profile;

  const [name, setName] = useState(profile?.name ?? "");
  const [type, setType] = useState<Profile["type"]>(profile?.type ?? "UPGRADE");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [tagFilters, setTagFilters] = useState(
    profile?.tagFilters?.join(", ") ?? ""
  );
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Config state per type
  const [upgradeSecurityOnly, setUpgradeSecurityOnly] = useState(
    profile?.type === "UPGRADE" ? profile.config?.securityOnly ?? false : false
  );
  const [upgradeDeliveryWindow, setUpgradeDeliveryWindow] = useState<string>(
    profile?.type === "UPGRADE"
      ? String(profile.config?.deliveryWindowMinutes ?? "")
      : ""
  );

  const [rebootDays, setRebootDays] = useState<string[]>(
    profile?.type === "REBOOT" ? profile.config?.days ?? [] : []
  );
  const [rebootTime, setRebootTime] = useState(
    profile?.type === "REBOOT" ? profile.config?.time ?? "" : ""
  );
  const [rebootRandomWindow, setRebootRandomWindow] = useState<string>(
    profile?.type === "REBOOT"
      ? String(profile.config?.randomWindowMinutes ?? "")
      : ""
  );

  const [scriptContent, setScriptContent] = useState(
    profile?.type === "SCRIPT" ? profile.config?.script ?? "" : ""
  );
  const [scriptTimeout, setScriptTimeout] = useState<string>(
    profile?.type === "SCRIPT"
      ? String(profile.config?.timeoutSeconds ?? "")
      : ""
  );

  const [packageNames, setPackageNames] = useState(
    profile?.type === "PACKAGE"
      ? (profile.config?.packages ?? []).join("\n")
      : ""
  );
  const [packageAction, setPackageAction] = useState<"install" | "remove">(
    profile?.type === "PACKAGE" ? profile.config?.action ?? "install" : "install"
  );

  const buildConfig = () => {
    switch (type) {
      case "UPGRADE":
        return {
          securityOnly: upgradeSecurityOnly,
          ...(upgradeDeliveryWindow
            ? { deliveryWindowMinutes: Number(upgradeDeliveryWindow) }
            : {}),
        };
      case "REBOOT":
        return {
          ...(rebootDays.length > 0 ? { days: rebootDays } : {}),
          ...(rebootTime ? { time: rebootTime } : {}),
          ...(rebootRandomWindow
            ? { randomWindowMinutes: Number(rebootRandomWindow) }
            : {}),
        };
      case "SCRIPT":
        return {
          script: scriptContent,
          ...(scriptTimeout
            ? { timeoutSeconds: Number(scriptTimeout) }
            : {}),
        };
      case "PACKAGE":
        return {
          packages: packageNames
            .split("\n")
            .map((p: string) => p.trim())
            .filter(Boolean),
          action: packageAction,
        };
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const tags = tagFilters
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      if (isEdit) {
        await api.updateProfile(profile.id, {
          name,
          type,
          description: description || null,
          config: buildConfig(),
          enabled,
          tagFilters: tags,
        });
      } else {
        await api.createProfile({
          name,
          type,
          description: description || undefined,
          config: buildConfig(),
          tagFilters: tags,
        });
      }
      onSaved();
    } catch (err: any) {
      setError(err.message || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  const toggleDay = (day: string) => {
    setRebootDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit ? "Modifier le profil" : "Créer un profil"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Nom
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Mise à jour sécurité..."
              required
            />
          </div>

          {/* Type selector */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Type
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(
                ["UPGRADE", "REBOOT", "SCRIPT", "PACKAGE"] as Profile["type"][]
              ).map((t) => {
                const style = TYPE_STYLES[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      type === t
                        ? `${style.bg} ${style.text} border-current`
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {style.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              rows={2}
              placeholder="Description optionnelle..."
            />
          </div>

          {/* Tag Filters */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Filtres de tags (séparés par des virgules)
            </label>
            <input
              type="text"
              value={tagFilters}
              onChange={(e) => setTagFilters(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="production, staging..."
            />
          </div>

          {/* Type-specific config */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Configuration {TYPE_STYLES[type].label}
            </span>

            {type === "UPGRADE" && (
              <>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={upgradeSecurityOnly}
                    onChange={(e) => setUpgradeSecurityOnly(e.target.checked)}
                    className="rounded border-input"
                  />
                  <span className="text-sm text-foreground">
                    Mises à jour de sécurité uniquement
                  </span>
                </label>
                <div>
                  <label className="block text-sm text-foreground mb-1">
                    Fenêtre de livraison (minutes)
                  </label>
                  <input
                    type="number"
                    value={upgradeDeliveryWindow}
                    onChange={(e) => setUpgradeDeliveryWindow(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="60"
                    min={0}
                  />
                </div>
              </>
            )}

            {type === "REBOOT" && (
              <>
                <div>
                  <label className="block text-sm text-foreground mb-1.5">
                    Jours
                  </label>
                  <div className="flex gap-1.5 flex-wrap">
                    {DAYS_LABELS.map((d) => (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() => toggleDay(d.key)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                          rebootDays.includes(d.key)
                            ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-foreground mb-1">
                    Heure
                  </label>
                  <input
                    type="time"
                    value={rebootTime}
                    onChange={(e) => setRebootTime(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-sm text-foreground mb-1">
                    Fenêtre aléatoire (minutes)
                  </label>
                  <input
                    type="number"
                    value={rebootRandomWindow}
                    onChange={(e) => setRebootRandomWindow(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="30"
                    min={0}
                  />
                </div>
              </>
            )}

            {type === "SCRIPT" && (
              <>
                <div>
                  <label className="block text-sm text-foreground mb-1">
                    Script
                  </label>
                  <textarea
                    value={scriptContent}
                    onChange={(e) => setScriptContent(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                    rows={6}
                    placeholder="#!/bin/bash&#10;echo 'Hello'"
                    required={type === "SCRIPT"}
                  />
                </div>
                <div>
                  <label className="block text-sm text-foreground mb-1">
                    Timeout (secondes)
                  </label>
                  <input
                    type="number"
                    value={scriptTimeout}
                    onChange={(e) => setScriptTimeout(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="300"
                    min={0}
                  />
                </div>
              </>
            )}

            {type === "PACKAGE" && (
              <>
                <div>
                  <label className="block text-sm text-foreground mb-1">
                    Paquets (un par ligne)
                  </label>
                  <textarea
                    value={packageNames}
                    onChange={(e) => setPackageNames(e.target.value)}
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                    rows={4}
                    placeholder={"nginx\ncurl\nhtop"}
                    required={type === "PACKAGE"}
                  />
                </div>
                <div>
                  <label className="block text-sm text-foreground mb-1.5">
                    Action
                  </label>
                  <div className="flex gap-2">
                    {(["install", "remove"] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setPackageAction(a)}
                        className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          packageAction === a
                            ? a === "install"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                              : "bg-red-500/10 text-red-400 border-red-500/30"
                            : "border-border text-muted-foreground"
                        }`}
                      >
                        {a === "install" ? "Installer" : "Supprimer"}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={loading || !name}
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading
                ? isEdit
                  ? "Modification..."
                  : "Création..."
                : isEdit
                  ? "Modifier"
                  : "Créer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
