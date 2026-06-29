import { useState, useEffect } from "react";
import { Container, Save, Check, Zap, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { Card, CardHeader, CardTitle, Button, Input } from "./ui";
import { getErrorMessage } from "../services/errors";

export default function NautilusIntegrationCard() {
  const { t } = useTranslation(["settings", "common"]);
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
      toast.success(t("nautilus.toast.saved"));
    } catch (err) {
      toast.error(t("nautilus.toast.saveError", { message: getErrorMessage(err, "save failed") }));
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
          t("nautilus.toast.testSuccess", {
            active: r.activeServers,
            total: r.servers,
            containers: r.containers,
            ms: r.durationMs,
          }),
          { duration: 5000 }
        );
      } else {
        toast.error(r.error || t("nautilus.toast.connectionFailed"));
      }
    } catch (err) {
      toast.error(getErrorMessage(err, t("nautilus.toast.connectionError")));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card padding="lg" className="space-y-4">
      <CardHeader>
        <Container className="w-4 h-4 text-primary" />
        <CardTitle className="normal-case tracking-normal text-sm">
          {t("nautilus.title")}
        </CardTitle>
      </CardHeader>

      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="nautilus.description" t={t} components={{ strong: <strong /> }} />
      </p>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 accent-primary"
        />
        <div className="flex-1">
          <div className="text-xs font-medium">{t("nautilus.enableLabel")}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {t("nautilus.enableHint")}
          </p>
        </div>
      </label>

      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
          {t("nautilus.urlLabel")}
        </label>
        <Input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://localhost:26020/metrics"
          className="font-mono"
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          <Trans i18nKey="nautilus.urlHint" t={t} components={{ code: <code /> }} />
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
          {t("nautilus.advancedOptions")}
          {tokenConfigured && !showAdvanced && (
            <span className="text-[10px]">{t("nautilus.tokenConfiguredBadge")}</span>
          )}
        </button>

        {showAdvanced && (
          <div className="mt-3 pl-4 border-l-2 border-border">
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              {t("nautilus.tokenLabel")}
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
                  ? t("nautilus.tokenPlaceholderConfigured")
                  : t("nautilus.tokenPlaceholderUnset")
              }
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              <Trans i18nKey="nautilus.tokenHint" t={t} components={[<code key="0" className="mx-1" />, <code key="1" />]} />
              {tokenConfigured && ` ${t("nautilus.tokenHintKeep")}`}
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
          {saved ? t("saved") : t("common:actions.save")}
        </Button>
        <Button
          variant="outline"
          size="md"
          onClick={test}
          disabled={!enabled}
          loading={testing}
          icon={<Zap />}
          title={!enabled ? t("nautilus.testDisabledTitle") : ""}
        >
          {t("nautilus.testButton")}
        </Button>
      </div>
    </Card>
  );
}
