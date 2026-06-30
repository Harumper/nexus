import { useState, useEffect, useMemo } from "react";
import { Clock, CalendarClock, RefreshCw, Loader2, Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api } from "../services/api";
import { useConfirm } from "./ui";
import { getErrorMessage } from "../services/errors";

interface Props {
  machineId: string;
}

export default function SchedulingTab({ machineId }: Props) {
  const { t } = useTranslation(["scheduling", "common"]);
  const [cronJobs, setCronJobs] = useState<any[]>([]);
  const [timers, setTimers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [tab, setTab] = useState<"timers" | "cron">("timers");
  const { confirm, ConfirmDialogElement } = useConfirm();

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [cron, t] = await Promise.all([
        api.cronList(machineId).catch(() => null),
        api.timerList(machineId).catch(() => null),
      ]);
      setCronJobs(cron?.data?.jobs || []);
      setTimers(t?.data?.timers || []);
    } catch (err) {
      setError(getErrorMessage(err, t("common:errors.generic")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [machineId]);

  const toggle = async (name: string, enabled: boolean) => {
    const verb = enabled ? "disable" : "enable";
    const label = verb === "enable" ? t("common:actions.enable") : t("common:actions.disable");
    if (!(await confirm({ title: t("confirmToggle", { label, name }), confirmLabel: label, variant: "primary" }))) return;
    setActing(name);
    try {
      if (verb === "enable") await api.timerEnable(machineId, name);
      else await api.timerDisable(machineId, name);
      toast.success(t("toastToggle", { name, label: label.toLowerCase() }));
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.actionFailed")));
    } finally {
      setActing(null);
    }
  };

  const sortedTimers = useMemo(() => {
    return [...timers].sort((a, b) => String(a.unit || "").localeCompare(String(b.unit || "")));
  }, [timers]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg overflow-hidden border border-border" style={{ background: "var(--nx-bg-surface)" }}>
          <TabBtn active={tab === "timers"} onClick={() => setTab("timers")} icon={CalendarClock}>
            {t("tabTimers", { count: timers.length })}
          </TabBtn>
          <TabBtn active={tab === "cron"} onClick={() => setTab("cron")} icon={Clock}>
            {t("tabCron", { count: cronJobs.length })}
          </TabBtn>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t("common:actions.refresh")}
        </button>
      </div>

      {error && (
        <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          {error}
        </div>
      )}

      {tab === "timers" && (
        sortedTimers.length === 0 ? (
          <Empty label={t("noTimers")} />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
            <table className="w-full text-xs">
              <thead style={{ background: "var(--nx-bg-elevated)" }}>
                <tr className="text-left" style={{ color: "var(--nx-text-weak)" }}>
                  <Th>{t("timerHeaders.unit")}</Th>
                  <Th>{t("timerHeaders.next")}</Th>
                  <Th>{t("timerHeaders.last")}</Th>
                  <Th>{t("timerHeaders.active")}</Th>
                  <Th>{t("timerHeaders.enabled")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {sortedTimers.map((t, i) => {
                  const unit = t.unit || "—";
                  const enabled = t.enabled_state === "enabled";
                  return (
                    <tr key={i} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                      <Td className="font-mono">{unit}</Td>
                      <Td style={{ color: "var(--nx-text-weak)" }}>{t.next || "—"}</Td>
                      <Td style={{ color: "var(--nx-text-weak)" }}>{t.last || "—"}</Td>
                      <Td>
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                          background: t.activates ? "var(--nx-success-subtle)" : "var(--nx-bg-elevated)",
                          color: t.activates ? "var(--nx-success)" : "var(--nx-text-weak)",
                        }}>
                          {t.activates || "—"}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-[10px] px-1.5 py-0.5 rounded uppercase" style={{
                          background: enabled ? "var(--nx-success-subtle)" : "var(--nx-bg-elevated)",
                          color: enabled ? "var(--nx-success)" : "var(--nx-text-weak)",
                        }}>
                          {t.enabled_state || "?"}
                        </span>
                      </Td>
                      <Td>
                        <button
                          onClick={() => toggle(unit, enabled)}
                          disabled={acting === unit}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px]"
                          style={{ border: `1px solid ${enabled ? "var(--nx-warning)" : "var(--nx-success)"}`, color: enabled ? "var(--nx-warning)" : "var(--nx-success)" }}
                        >
                          {acting === unit ? <Loader2 className="w-3 h-3 animate-spin" /> : enabled ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                          {enabled ? t("common:actions.disable") : t("common:actions.enable")}
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === "cron" && (
        cronJobs.length === 0 ? (
          <Empty label={t("noCron")} />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
            <table className="w-full text-xs">
              <thead style={{ background: "var(--nx-bg-elevated)" }}>
                <tr className="text-left" style={{ color: "var(--nx-text-weak)" }}>
                  <Th>{t("cronHeaders.source")}</Th>
                  <Th>{t("cronHeaders.user")}</Th>
                  <Th>{t("cronHeaders.schedule")}</Th>
                  <Th>{t("cronHeaders.command")}</Th>
                </tr>
              </thead>
              <tbody>
                {cronJobs.map((j, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                    <Td className="font-mono" style={{ color: "var(--nx-text-weak)" }}>
                      {j.source?.replace(/^\/etc\/cron\.d\//, "") || "—"}
                    </Td>
                    <Td>{j.user}</Td>
                    <Td className="font-mono">{j.schedule}</Td>
                    <Td className="font-mono truncate max-w-xl" title={j.command}>
                      {j.command}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {ConfirmDialogElement}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: any; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium transition-colors"
      style={{
        background: active ? "var(--nx-primary-subtle)" : "transparent",
        color: active ? "var(--nx-primary)" : "var(--nx-text-weak)",
      }}
    >
      <Icon className="w-3.5 h-3.5" />
      {children}
    </button>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-border p-8 text-center text-xs" style={{ background: "var(--nx-bg-surface)", color: "var(--nx-text-weak)" }}>
      {label}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children, className = "", ...rest }: any) {
  return <td className={`px-3 py-2 ${className}`} {...rest}>{children}</td>;
}
