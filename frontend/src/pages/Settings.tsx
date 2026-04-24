import { useState, useEffect } from "react";
import {
  Settings as SettingsIcon,
  Mail,
  Webhook,
  Heart,
  Clock,
  Save,
  RefreshCw,
  Send,
  Eye,
  EyeOff,
  Check,
} from "lucide-react";
import { api } from "../services/api";
import type { Setting } from "../types";
import NautilusIntegrationCard from "../components/NautilusIntegrationCard";

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

interface HealthThresholds {
  cpu: number;
  memory: number;
  disk: number;
}

interface LifecycleConfig {
  stale_after_days: number;
  archive_after_days: number;
  delete_after_days: number;
}

export default function Settings() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // SMTP
  const [smtp, setSmtp] = useState<SmtpConfig>({
    host: "",
    port: 587,
    user: "",
    password: "",
    from: "",
  });

  // Webhook
  const [webhookSecret, setWebhookSecret] = useState("");

  // Health thresholds
  const [thresholds, setThresholds] = useState<HealthThresholds>({
    cpu: 90,
    memory: 90,
    disk: 90,
  });

  // Lifecycle
  const [lifecycle, setLifecycle] = useState<LifecycleConfig>({
    stale_after_days: 7,
    archive_after_days: 30,
    delete_after_days: 90,
  });

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.getSettings();
      setSettings(data);

      // Populate from settings
      for (const s of data) {
        if (s.key === "smtp") {
          setSmtp({ ...smtp, ...(s.value as SmtpConfig) });
        }
        if (s.key === "webhook_secret") {
          setWebhookSecret(s.value as string);
        }
        if (s.key === "health_thresholds") {
          setThresholds({ ...thresholds, ...(s.value as HealthThresholds) });
        }
        if (s.key === "lifecycle") {
          setLifecycle({ ...lifecycle, ...(s.value as LifecycleConfig) });
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const saveSetting = async (key: string, value: unknown) => {
    setSaving(key);
    try {
      await api.updateSetting(key, value);
      setSaved(key);
      setTimeout(() => setSaved(null), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(null);
    }
  };

  const regenerateWebhook = async () => {
    setSaving("webhook");
    try {
      const result = await api.updateSetting("webhook_secret", "__regenerate__");
      if (result.value) {
        setWebhookSecret(result.value as string);
      }
      setSaved("webhook");
      setTimeout(() => setSaved(null), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(null);
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
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Paramètres</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configuration du système Nexus
        </p>
      </div>

      <div className="space-y-6">
        {/* SMTP Configuration */}
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Mail className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Configuration SMTP
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Hôte SMTP
              </label>
              <input
                type="text"
                value={smtp.host}
                onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
                placeholder="smtp.example.com"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Port
              </label>
              <input
                type="number"
                value={smtp.port}
                onChange={(e) =>
                  setSmtp({ ...smtp, port: parseInt(e.target.value) || 587 })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Utilisateur
              </label>
              <input
                type="text"
                value={smtp.user}
                onChange={(e) => setSmtp({ ...smtp, user: e.target.value })}
                placeholder="user@example.com"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Mot de passe
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={smtp.password}
                  onChange={(e) =>
                    setSmtp({ ...smtp, password: e.target.value })
                  }
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Adresse expéditeur
              </label>
              <input
                type="email"
                value={smtp.from}
                onChange={(e) => setSmtp({ ...smtp, from: e.target.value })}
                placeholder="nexus@example.com"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="flex gap-3 mt-5">
            <button
              onClick={() => saveSetting("smtp", smtp)}
              disabled={saving === "smtp"}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving === "smtp" ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : saved === "smtp" ? (
                <Check className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saved === "smtp" ? "Enregistré" : "Enregistrer"}
            </button>
            <button
              onClick={() => saveSetting("smtp_test", smtp)}
              disabled={saving === "smtp_test"}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {saving === "smtp_test" ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Tester
            </button>
          </div>
        </section>

        {/* Webhook */}
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Webhook className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Webhook</h2>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Secret webhook
            </label>
            <div className="flex gap-3">
              <input
                type="text"
                value={webhookSecret}
                readOnly
                className="flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground font-mono focus:outline-none"
              />
              <button
                onClick={regenerateWebhook}
                disabled={saving === "webhook"}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                {saving === "webhook" ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : saved === "webhook" ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                Régénérer
              </button>
            </div>
          </div>
        </section>

        {/* Health Thresholds */}
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Heart className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Seuils d&apos;alerte
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                CPU (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={thresholds.cpu}
                onChange={(e) =>
                  setThresholds({
                    ...thresholds,
                    cpu: parseInt(e.target.value) || 0,
                  })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Mémoire (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={thresholds.memory}
                onChange={(e) =>
                  setThresholds({
                    ...thresholds,
                    memory: parseInt(e.target.value) || 0,
                  })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Disque (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={thresholds.disk}
                onChange={(e) =>
                  setThresholds({
                    ...thresholds,
                    disk: parseInt(e.target.value) || 0,
                  })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="mt-5">
            <button
              onClick={() => saveSetting("health_thresholds", thresholds)}
              disabled={saving === "health_thresholds"}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving === "health_thresholds" ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : saved === "health_thresholds" ? (
                <Check className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saved === "health_thresholds" ? "Enregistré" : "Enregistrer"}
            </button>
          </div>
        </section>

        {/* Machine Lifecycle */}
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Clock className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Cycle de vie des machines
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Stale après (jours)
              </label>
              <input
                type="number"
                min={1}
                value={lifecycle.stale_after_days}
                onChange={(e) =>
                  setLifecycle({
                    ...lifecycle,
                    stale_after_days: parseInt(e.target.value) || 1,
                  })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Archiver après (jours)
              </label>
              <input
                type="number"
                min={1}
                value={lifecycle.archive_after_days}
                onChange={(e) =>
                  setLifecycle({
                    ...lifecycle,
                    archive_after_days: parseInt(e.target.value) || 1,
                  })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Supprimer après (jours)
              </label>
              <input
                type="number"
                min={1}
                value={lifecycle.delete_after_days}
                onChange={(e) =>
                  setLifecycle({
                    ...lifecycle,
                    delete_after_days: parseInt(e.target.value) || 1,
                  })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="mt-5">
            <button
              onClick={() => saveSetting("lifecycle", lifecycle)}
              disabled={saving === "lifecycle"}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving === "lifecycle" ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : saved === "lifecycle" ? (
                <Check className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saved === "lifecycle" ? "Enregistré" : "Enregistrer"}
            </button>
          </div>
        </section>

        {/* Intégration Nautilus */}
        <NautilusIntegrationCard />
      </div>
    </div>
  );
}
