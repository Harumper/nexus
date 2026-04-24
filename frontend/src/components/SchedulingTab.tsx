import { useState, useEffect, useMemo } from "react";
import { Clock, CalendarClock, RefreshCw, Loader2, Power, PowerOff } from "lucide-react";
import { api } from "../services/api";

interface Props {
  machineId: string;
  canMutate: boolean;
}

export default function SchedulingTab({ machineId, canMutate }: Props) {
  const [cronJobs, setCronJobs] = useState<any[]>([]);
  const [timers, setTimers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [tab, setTab] = useState<"timers" | "cron">("timers");

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
    } catch (err: any) {
      setError(err?.message || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [machineId]);

  const toggle = async (name: string, enabled: boolean) => {
    if (!canMutate) return;
    const verb = enabled ? "disable" : "enable";
    if (!confirm(`${verb === "enable" ? "Activer" : "Désactiver"} le timer ${name} ?`)) return;
    setActing(name);
    try {
      if (verb === "enable") await api.timerEnable(machineId, name);
      else await api.timerDisable(machineId, name);
      await load();
    } catch (err: any) {
      alert("Erreur: " + (err?.message || "action failed"));
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
            Timers ({timers.length})
          </TabBtn>
          <TabBtn active={tab === "cron"} onClick={() => setTab("cron")} icon={Clock}>
            Cron ({cronJobs.length})
          </TabBtn>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Rafraîchir
        </button>
      </div>

      {error && (
        <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          {error}
        </div>
      )}

      {tab === "timers" && (
        sortedTimers.length === 0 ? (
          <Empty label="Aucun timer détecté" />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
            <table className="w-full text-xs">
              <thead style={{ background: "var(--nx-bg-elevated)" }}>
                <tr className="text-left" style={{ color: "var(--nx-text-weak)" }}>
                  <Th>Unit</Th>
                  <Th>Prochain</Th>
                  <Th>Dernier</Th>
                  <Th>Active</Th>
                  <Th>Enabled</Th>
                  {canMutate && <Th />}
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
                      {canMutate && (
                        <Td>
                          <button
                            onClick={() => toggle(unit, enabled)}
                            disabled={acting === unit}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px]"
                            style={{ border: `1px solid ${enabled ? "var(--nx-warning)" : "var(--nx-success)"}`, color: enabled ? "var(--nx-warning)" : "var(--nx-success)" }}
                          >
                            {acting === unit ? <Loader2 className="w-3 h-3 animate-spin" /> : enabled ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                            {enabled ? "Disable" : "Enable"}
                          </button>
                        </Td>
                      )}
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
          <Empty label="Aucun cron job système détecté" />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
            <table className="w-full text-xs">
              <thead style={{ background: "var(--nx-bg-elevated)" }}>
                <tr className="text-left" style={{ color: "var(--nx-text-weak)" }}>
                  <Th>Source</Th>
                  <Th>User</Th>
                  <Th>Schedule</Th>
                  <Th>Command</Th>
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
