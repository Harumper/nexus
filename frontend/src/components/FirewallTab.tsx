import { useState, useEffect, useCallback } from "react";
import { Shield, ShieldOff, Plus, Trash2, Check, X, RefreshCw, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useConfirm } from "./ui";

interface FirewallTabProps {
  machineId: string;
}

interface ParsedRule {
  number: number;
  action: string; // ALLOW, DENY, REJECT, LIMIT
  from: string;
  to: string;
  raw: string;
}

// Parse ufw status numbered output
function parseRules(raw: string): ParsedRule[] {
  const lines = raw.split("\n");
  const rules: ParsedRule[] = [];
  for (const line of lines) {
    // Format: "[ 1] 80/tcp                     ALLOW IN    Anywhere"
    const m = line.match(/^\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|OUT))?\s+(.+)$/);
    if (m) {
      rules.push({
        number: parseInt(m[1], 10),
        action: m[3],
        to: m[2].trim(),
        from: m[4].trim(),
        raw: line.trim(),
      });
    }
  }
  return rules;
}

interface PendingChange {
  requestId: string;
  expiresAt: Date;
  description: string;
}

export default function FirewallTab({ machineId }: FirewallTabProps) {
  const { t } = useTranslation(["firewall", "common"]);
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<ParsedRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newRule, setNewRule] = useState({ action: "allow", rule: "" });
  const { confirm, ConfirmDialogElement } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.firewallStatus(machineId);
      const data = res?.data;
      setEnabled(data?.enabled || false);
      setRules(parseRules(data?.raw || ""));
      // Si un pending existe cote agent, le reprendre cote UI
      if (data?.pending && data.pending.length > 0) {
        const p = data.pending[0];
        setPending({
          requestId: p.request_id,
          expiresAt: new Date(Date.now() + (p.expires_in_seconds || 0) * 1000),
          description: t("pendingDescription"),
        });
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      // Quand le WS est coupé mais que la machine reste ONLINE pendant la grâce
      // anti-flapping (~90s), le dispatcher renvoie ce message brut. On le
      // traduit en quelque chose d'actionnable pour l'utilisateur.
      setError(
        /agent is not connected/i.test(msg)
          ? t("agentReconnecting")
          : msg
      );
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => { load(); }, [load]);

  // Countdown timer pour le pending
  useEffect(() => {
    if (!pending) { setCountdown(0); return; }
    const update = () => {
      const remain = Math.max(0, Math.floor((pending.expiresAt.getTime() - Date.now()) / 1000));
      setCountdown(remain);
      if (remain === 0) {
        // Timer expire — re-fetch l'etat (la revert est deja faite cote agent)
        setTimeout(load, 1000);
        setPending(null);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [pending, load]);

  const applyAction = async (fn: () => Promise<any>, description: string) => {
    try {
      const res = await fn();
      const reqId = res?.data?.request_id;
      const expires = res?.data?.watchdog_expires_at;
      if (reqId) {
        setPending({
          requestId: reqId,
          expiresAt: expires ? new Date(expires) : new Date(Date.now() + 60_000),
          description,
        });
      }
      await load();
    } catch (err) {
      toast.error(t("toastError", { message: getErrorMessage(err) }));
    }
  };

  const handleConfirm = async () => {
    if (!pending) return;
    try {
      await api.firewallConfirm(machineId, pending.requestId);
      setPending(null);
      await load();
    } catch (err) {
      toast.error(t("toastConfirmError", { message: getErrorMessage(err) }));
    }
  };

  const handleAdd = async () => {
    if (!newRule.rule.trim()) return;
    const fn = newRule.action === "allow"
      ? () => api.firewallAllow(machineId, newRule.rule.trim())
      : () => api.firewallDeny(machineId, newRule.rule.trim());
    await applyAction(fn, `${newRule.action} ${newRule.rule.trim()}`);
    setAdding(false);
    setNewRule({ action: "allow", rule: "" });
  };

  const handleRemove = async (n: number, rule: string) => {
    if (!(await confirm({
      title: t("confirmRemoveTitle", { n }),
      description: rule,
      confirmLabel: t("common:actions.delete"),
      variant: "danger",
    }))) return;
    await applyAction(() => api.firewallRuleRemove(machineId, n), t("descRemoveRule", { n }));
  };

  return (
    <div className="space-y-4">
      {/* Watchdog banner */}
      {pending && countdown > 0 && (
        <div className="rounded-lg border-2 p-4 flex items-center justify-between"
          style={{ borderColor: "var(--nx-warning)", background: "var(--nx-warning-subtle)" }}>
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5" style={{ color: "var(--nx-warning)" }} />
            <div>
              <div className="font-semibold text-sm" style={{ color: "var(--nx-warning)" }}>
                {t("confirmRequired", { description: pending.description })}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
                <Trans i18nKey="watchdogCountdown" t={t} values={{ count: countdown }} components={[<span key="0" className="font-bold tabular-nums" />]} />
              </div>
            </div>
          </div>
          <button
            onClick={handleConfirm}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-medium transition-colors"
          >
            <Check className="w-4 h-4" /> {t("common:actions.confirm")}
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {enabled ? (
              <Shield className="w-5 h-5" style={{ color: "var(--nx-success)" }} />
            ) : (
              <ShieldOff className="w-5 h-5" style={{ color: "var(--nx-text-weak)" }} />
            )}
            <span className="text-sm font-medium">
              {enabled ? t("enabled") : t("disabled")}
            </span>
          </div>
          {!pending && enabled && (
            <button
              onClick={() => applyAction(() => api.firewallDisable(machineId), t("descDisable"))}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t("common:actions.disable")}
            </button>
          )}
          {!pending && !enabled && (
            <button
              onClick={() => applyAction(() => api.firewallEnable(machineId), t("descEnable"))}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t("common:actions.enable")}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> {t("common:actions.refresh")}
          </button>
          {!pending && (
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs hover:bg-primary/90"
            >
              <Plus className="w-3.5 h-3.5" /> {t("addRule")}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Add rule dialog inline */}
      {adding && (
        <div className="rounded-lg border border-border p-4 space-y-3" style={{ background: "var(--nx-bg-surface)" }}>
          <div className="flex items-center gap-2">
            <select
              value={newRule.action}
              onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}
              className="rounded border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="allow">{t("actionAllow")}</option>
              <option value="deny">{t("actionDeny")}</option>
            </select>
            <input
              type="text"
              value={newRule.rule}
              onChange={(e) => setNewRule({ ...newRule, rule: e.target.value })}
              placeholder={t("rulePlaceholder")}
              className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm font-mono"
            />
            <button
              onClick={handleAdd}
              disabled={!newRule.rule.trim()}
              className="inline-flex items-center gap-2 rounded bg-primary text-primary-foreground px-3 py-2 text-sm disabled:opacity-50"
            >
              {t("common:actions.apply")}
            </button>
            <button
              onClick={() => { setAdding(false); setNewRule({ action: "allow", rule: "" }); }}
              className="p-2 rounded hover:bg-muted"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            <Trans i18nKey="syntaxHint" t={t} components={[<code key="0" />, <code key="1" />, <code key="2" />, <code key="3" />]} />
          </p>
        </div>
      )}

      {/* Rules table */}
      <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
        <table className="w-full text-sm">
          <thead style={{ background: "var(--nx-bg-elevated)" }}>
            <tr className="text-xs uppercase" style={{ color: "var(--nx-text-weak)" }}>
              <th className="px-4 py-2 text-left w-12">#</th>
              <th className="px-4 py-2 text-left">{t("headers.rule")}</th>
              <th className="px-4 py-2 text-left">{t("headers.action")}</th>
              <th className="px-4 py-2 text-left">{t("headers.from")}</th>
              <th className="px-4 py-2 text-right w-20"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center">
                <Loader2 className="w-5 h-5 animate-spin inline" />
              </td></tr>
            ) : rules.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm" style={{ color: "var(--nx-text-weak)" }}>
                {t("noRules")} {enabled ? t("noRulesEnabled") : t("noRulesDisabled")}
              </td></tr>
            ) : (
              rules.map((r) => (
                <tr key={r.number} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{r.number}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.to}</td>
                  <td className="px-4 py-2">
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                      style={{
                        background: r.action === "ALLOW" ? "var(--nx-success-subtle)" : "var(--nx-danger-subtle)",
                        color: r.action === "ALLOW" ? "var(--nx-success)" : "var(--nx-danger)",
                      }}>
                      {r.action}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs">{r.from}</td>
                  <td className="px-4 py-2 text-right">
                    {!pending && (
                      <button
                        onClick={() => handleRemove(r.number, r.raw)}
                        className="p-1.5 rounded hover:bg-muted"
                        style={{ color: "var(--nx-danger)" }}
                        title={t("common:actions.delete")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="watchdogFooter" t={t} components={[<b key="0" />]} />
      </p>
      {ConfirmDialogElement}
    </div>
  );
}
