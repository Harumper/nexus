import { useState, useEffect } from "react";
import { Container, Save, Check, Zap, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import { Card, CardHeader, CardTitle, Button, Input } from "./ui";
import { getErrorMessage } from "../services/errors";

export default function NautilusIntegrationCard() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("http://localhost:26020/metrics");
  const [token, setToken] = useState("");
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    api
      .getNautilusConfig()
      .then((c) => {
        setEnabled(c.enabled);
        setUrl(c.url);
        setTokenConfigured(c.tokenConfigured);
        if (c.tokenConfigured) setShowAdvanced(true);
      })
      .catch((err) => console.warn("[Nautilus] config fetch failed:", err));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const payload: any = { enabled, url };
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
      toast.success("Configuration Nautilus enregistrée");
    } catch (err) {
      toast.error("Erreur : " + (getErrorMessage(err, "save failed")));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testNautilus();
      if (r.success) {
        toast.success(
          `${r.activeServers}/${r.servers} serveurs actifs · ${r.containers} containers · scrape en ${r.durationMs}ms`,
          { duration: 5000 }
        );
      } else {
        toast.error(r.error || "Connexion impossible");
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Erreur de connexion"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card padding="lg" className="space-y-4">
      <CardHeader>
        <Container className="w-4 h-4 text-primary" />
        <CardTitle className="normal-case tracking-normal text-sm">
          Intégration Nautilus (Docker)
        </CardTitle>
      </CardHeader>

      <p className="text-xs text-muted-foreground">
        Active un onglet <strong>Containers</strong> dans le menu qui lit les métriques
        Prometheus exposées par Nautilus. Lecture seule — les actions Docker restent dans
        Nautilus.
      </p>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 accent-primary"
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
        <Input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://localhost:26020/metrics"
          className="font-mono"
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          Nautilus sur la même machine :{" "}
          <code>http://localhost:26020/metrics</code>. Sinon utilisez l'URL publique ou
          l'IP du serveur.
        </p>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          {showAdvanced ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          Options avancées
          {tokenConfigured && !showAdvanced && (
            <span className="text-[10px]">(token configuré)</span>
          )}
        </button>

        {showAdvanced && (
          <div className="mt-3 pl-4 border-l-2 border-border">
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Token d'authentification
            </label>
            <Input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setTouched(true);
              }}
              placeholder={
                tokenConfigured
                  ? "•••••••• (configuré)"
                  : "Uniquement si Nautilus est exposé publiquement"
              }
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Inutile si Nautilus tourne en local (non exposé sur internet). Correspond à{" "}
              <code className="mx-1">PROMETHEUS_SCRAPE_TOKEN</code>
              dans le <code>.env</code> de Nautilus.
              {tokenConfigured && " Laissez vide pour conserver le token actuel."}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          onClick={save}
          loading={saving}
          icon={saved ? <Check /> : <Save />}
        >
          {saved ? "Enregistré" : "Enregistrer"}
        </Button>
        <Button
          variant="outline"
          size="md"
          onClick={test}
          disabled={!enabled}
          loading={testing}
          icon={<Zap />}
          title={!enabled ? "Activez d'abord l'intégration" : ""}
        >
          Tester la connexion
        </Button>
      </div>
    </Card>
  );
}
