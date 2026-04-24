import { useState, useEffect } from "react";
import { Container, Save, Check, RefreshCw, Zap, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../services/api";

export default function NautilusIntegrationCard() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("http://localhost:26020/metrics");
  const [token, setToken] = useState("");
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    api.getNautilusConfig().then((c) => {
      setEnabled(c.enabled);
      setUrl(c.url);
      setTokenConfigured(c.tokenConfigured);
      // Ouvrir "Avancé" automatiquement si un token est déjà configuré
      if (c.tokenConfigured) setShowAdvanced(true);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const payload: any = { enabled, url };
      // Only send token if user touched it (avoid overwriting with empty)
      if (touched) {
        payload.token = token.length > 0 ? token : null;
      }
      const res = await api.updateNautilusConfig(payload);
      setEnabled(res.enabled);
      setUrl(res.url);
      setTokenConfigured(res.tokenConfigured);
      setToken("");
      setTouched(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      alert("Erreur : " + (err?.message || "save failed"));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testNautilus();
      if (r.success) {
        setTestResult({
          ok: true,
          msg: `${r.activeServers}/${r.servers} serveurs actifs · ${r.containers} containers · scrape en ${r.durationMs}ms`,
        });
      } else {
        setTestResult({ ok: false, msg: r.error || "Erreur" });
      }
    } catch (err: any) {
      setTestResult({ ok: false, msg: err?.message || "Erreur" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-5">
        <Container className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Intégration Nautilus (Docker)</h2>
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Active un onglet <strong>Containers</strong> dans le menu qui lit les métriques
        Prometheus exposées par Nautilus. Lecture seule — les actions Docker restent dans
        Nautilus.
      </p>

      <div className="space-y-4">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-xs font-medium">Activer l'intégration Nautilus</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Désactivé par défaut. Activer affichera l'onglet Containers dans le menu.
            </p>
          </div>
        </label>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            URL de l'endpoint /metrics
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:26020/metrics"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Nautilus sur la même machine : <code>http://localhost:26020/metrics</code>. Sinon utilisez
            l'URL publique ou l'IP du serveur.
          </p>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAdvanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Options avancées {tokenConfigured && !showAdvanced && <span className="text-[10px]">(token configuré)</span>}
          </button>

          {showAdvanced && (
            <div className="mt-3 pl-4" style={{ borderLeft: "2px solid var(--nx-border)" }}>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                Token d'authentification
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => { setToken(e.target.value); setTouched(true); }}
                placeholder={tokenConfigured ? "•••••••• (configuré)" : "Uniquement si Nautilus est exposé publiquement"}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Inutile si Nautilus tourne en local (non exposé sur internet). Correspond à
                <code className="mx-1">PROMETHEUS_SCRAPE_TOKEN</code>
                dans le <code>.env</code> de Nautilus.
                {tokenConfigured && " Laissez vide pour conserver le token actuel."}
              </p>
            </div>
          )}
        </div>

        {testResult && (
          <div
            className="rounded-lg px-3 py-2 text-xs"
            style={{
              background: testResult.ok ? "var(--nx-success-subtle)" : "var(--nx-danger-subtle)",
              color: testResult.ok ? "var(--nx-success)" : "var(--nx-danger)",
            }}
          >
            {testResult.ok ? "✓ " : "✗ "}{testResult.msg}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? "Enregistré" : "Enregistrer"}
          </button>
          <button
            onClick={test}
            disabled={testing || !enabled}
            title={!enabled ? "Activez d'abord l'intégration" : ""}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Tester la connexion
          </button>
        </div>
      </div>
    </section>
  );
}
