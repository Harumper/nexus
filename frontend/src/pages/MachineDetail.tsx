import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft, Server, Shield, Trash2, ShieldOff, RefreshCw,
  Cpu, MemoryStick, HardDrive, Clock, Globe, Terminal,
  Activity, Network, ListTree, Download,
  RotateCcw, ArrowUpCircle, Cog, Power, FolderOpen, ScrollText,
} from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useWebSocket } from "../hooks/useWebSocket";
import {
  statusColor, statusKey,
} from "../lib/utils";
import { formatBytes, formatUptime, timeAgo, formatDate } from "../lib/format";
import MetricsChart from "../components/MetricsChart";
import UpdatePanel from "../components/UpdatePanel";
import ProcessList from "../components/ProcessList";
import ServicesTab from "../components/ServicesTab";
import LogsDrawer from "../components/LogsDrawer";
import FirewallTab from "../components/FirewallTab";
import PackagesTab from "../components/PackagesTab";
import StorageTab from "../components/StorageTab";
import SchedulingTab from "../components/SchedulingTab";
import UsersTab from "../components/UsersTab";
import FilesTab from "../components/FilesTab";
import SecurityTab from "../components/SecurityTab";
import LogShippingTab from "../components/LogShippingTab";
import NetworkConfigTab from "../components/NetworkConfigTab";
import SshConnectDialog from "../components/SshConnectDialog";
import AgentUpgradeDialog from "../components/AgentUpgradeDialog";
import AttentionPanel from "../components/AttentionPanel";
import HeaderBadges from "../components/HeaderBadges";
import { useMachineAttention } from "../hooks/useMachineAttention";
import { useConfirm, PageLoader, Tooltip } from "../components/ui";
import { toast } from "sonner";
import type { Machine, Metric, WSDashboardMessage } from "../types";
import { getErrorMessage } from "../services/errors";

type Tab = "overview" | "metrics" | "updates" | "processes" | "network" | "netplan" | "services" | "firewall" | "packages" | "storage" | "scheduling" | "users" | "files" | "security" | "logs";

// Header action button: icon only (the label lives in the Tooltip).
const ICON_BTN =
  "inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

export default function MachineDetail() {
  const { t } = useTranslation(["machineDetail", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, authConfig } = useAuth();
  const [machine, setMachine] = useState<Machine | null>(null);
  const [latestMetric, setLatestMetric] = useState<Metric | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [lastSubtab, setLastSubtab] = useState<Record<string, Tab>>({});
  const [logsService, setLogsService] = useState<string | null>(null);
  const [showSshDialog, setShowSshDialog] = useState(false);
  const [showAgentUpgrade, setShowAgentUpgrade] = useState(false);
  const [agentUpdateAvailable, setAgentUpdateAvailable] = useState(false);
  // null = undetermined (target or current SHA unknown) → we don't block the update.
  const [agentUpToDate, setAgentUpToDate] = useState<boolean | null>(null);
  // "One-shot" request to filter Services on the "failed" state — emitted by
  // HeaderBadges / AttentionPanel when the user clicks the "failed services"
  // badge. Consumed by ServicesTab on receipt.
  const [pendingServiceFilter, setPendingServiceFilter] = useState<"failed" | null>(null);
  const showFailedServices = useCallback(() => {
    setPendingServiceFilter("failed");
    setActiveTab("services");
  }, []);
  const consumePendingServiceFilter = useCallback(() => setPendingServiceFilter(null), []);
  const { confirm, ConfirmDialogElement } = useConfirm();
  // Load the critical signals (alerts/services/updates/certs) once here,
  // shared between HeaderBadges (under the name) and AttentionPanel
  // (in the Overview) via prop drilling — avoids the double fetch.
  const attention = useMachineAttention(
    id ?? "",
    Boolean(id && machine?.status === "ONLINE")
  );

  // Load machine data
  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getMachine(id),
      api.getLatestMetrics(id).catch(() => null),
    ])
      .then(([m, metric]) => { setMachine(m); setLatestMetric(metric); })
      .catch(() => navigate("/machines"))
      .finally(() => setLoading(false));
  }, [id, navigate]);

  // Auto-refresh metrics every 15s
  useEffect(() => {
    if (!id || !machine || machine.status !== "ONLINE") return;
    const interval = setInterval(() => {
      api.getLatestMetrics(id).then(setLatestMetric).catch((err) => console.warn("[MachineDetail] latest metrics failed:", err));
    }, 15_000);
    return () => clearInterval(interval);
  }, [id, machine]);

  // Agent version status → "update available" badge. Refreshed when the
  // upgrade modal opens (onSuccess) and on mount when the machine is an
  // online agent.
  const refreshAgentStatus = useCallback(() => {
    if (!id || machine?.status !== "ONLINE") {
      setAgentUpdateAvailable(false);
      setAgentUpToDate(null);
      return;
    }
    api
      .agentStatus(id)
      .then((s) => {
        setAgentUpdateAvailable(s.updateAvailable);
        setAgentUpToDate(s.upToDate);
      })
      .catch(() => {
        setAgentUpdateAvailable(false);
        setAgentUpToDate(null);
      });
  }, [id, machine?.status]);

  useEffect(() => {
    refreshAgentStatus();
  }, [refreshAgentStatus]);

  // WebSocket for real-time metric updates
  const handleWsMessage = useCallback(
    (msg: WSDashboardMessage) => {
      if (msg.type === "machine.metrics" && msg.machine_id === id && msg.data) {
        const d = msg.data;
        setLatestMetric({
          id: "",
          cpuPercent: d.cpuPercent ?? d.cpu_percent ?? 0,
          memoryUsed: d.memoryUsed ?? d.memory_used ?? 0,
          memoryTotal: d.memoryTotal ?? d.memory_total ?? 0,
          memoryPercent: d.memoryPercent ?? d.memory_percent ?? 0,
          disks: d.disks ?? [],
          network: d.network ?? null,
          loadAvg1: d.loadAvg1 ?? d.load_avg_1 ?? null,
          loadAvg5: d.loadAvg5 ?? d.load_avg_5 ?? null,
          loadAvg15: d.loadAvg15 ?? d.load_avg_15 ?? null,
          uptime: d.uptime ?? null,
          timestamp: d.timestamp ?? new Date().toISOString(),
        });
      }
    },
    [id]
  );
  useWebSocket({ onMessage: handleWsMessage });

  const handleRevoke = async () => {
    if (!id) return;
    if (
      !(await confirm({
        title: t("confirm.revokeTitle"),
        description: t("confirm.revokeDesc"),
        confirmLabel: t("common:actions.revoke"),
        variant: "warning",
      }))
    )
      return;
    try {
      await api.revokeMachine(id, "Revoked from UI");
      setMachine(await api.getMachine(id));
      toast.success(t("toast.revoked"));
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (
      !(await confirm({
        title: t("confirm.deleteTitle"),
        description: t("confirm.deleteDesc"),
        confirmLabel: t("common:actions.delete"),
        variant: "danger",
      }))
    )
      return;
    try {
      await api.deleteMachine(id);
      toast.success(t("toast.deleted"));
      navigate("/machines");
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
    }
  };

  // The agent update now goes through a tracking modal (AgentUpgradeDialog)
  // that stays open until reconnection on the new version.

  const handleReboot = async () => {
    if (!id) return;
    if (
      !(await confirm({
        title: t("confirm.rebootTitle"),
        description: t("confirm.rebootDesc"),
        confirmWord: "REBOOT",
        confirmLabel: t("common:actions.reboot"),
        variant: "danger",
      }))
    )
      return;
    try {
      await api.rebootMachine(id);
      toast.success(t("toast.rebootTriggered"));
    } catch (err) {
      toast.error(getErrorMessage(err, t("toast.rebootError")));
    }
  };


  if (loading || !machine) {
    return <PageLoader />;
  }

  const status = statusColor(machine.status);
  const isAdmin = user?.role === "ADMIN";
  const isOnline = machine.status === "ONLINE";
  // SSH key / sudo management: enabled by backend flag AND ADMIN-only.
  // Cosmetic — the real check is applied in dispatchAction() on the backend.
  const canManagePrivileges =
    isAdmin && authConfig?.features?.userPrivilegeMgmt === true;

  // `key` = stable group identifier (subtab memory, language-independent);
  // the displayed label comes from t(`groups.${key}`). The tab labels/tooltips
  // come from t(`tabs.${id}.label|tooltip`).
  const tabGroups: {
    key: string;
    tabs: { id: Tab; icon: typeof Activity; show: boolean }[];
  }[] = [
    {
      key: "",
      tabs: [
        { id: "overview", icon: Activity, show: true },
      ],
    },
    {
      key: "monitoring",
      tabs: [
        { id: "metrics", icon: Cpu, show: isOnline },
        { id: "processes", icon: ListTree, show: isOnline },
        { id: "storage", icon: HardDrive, show: isOnline },
        { id: "logs", icon: ScrollText, show: isOnline },
      ],
    },
    {
      key: "system",
      tabs: [
        { id: "services", icon: Cog, show: isOnline },
        { id: "scheduling", icon: Clock, show: isOnline },
        { id: "users", icon: Server, show: isOnline },
        { id: "files", icon: FolderOpen, show: isOnline },
      ],
    },
    {
      key: "network",
      tabs: [
        { id: "network", icon: Network, show: isOnline },
        { id: "netplan", icon: Globe, show: isOnline },
        { id: "firewall", icon: Shield, show: isOnline },
      ],
    },
    {
      key: "software",
      tabs: [
        { id: "updates", icon: Download, show: isOnline },
        { id: "packages", icon: Download, show: isOnline },
      ],
    },
    {
      key: "security",
      tabs: [
        { id: "security", icon: Shield, show: isOnline },
      ],
    },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Back */}
      <Link to="/machines" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> {t("common:nav.machines")}
      </Link>

      {/* ── Header ─────────────────────────────── */}
      <div className="rounded-xl p-5 mb-4" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: "var(--nx-bg-elevated)" }}>
              <Server className="w-7 h-7" style={{ color: "var(--nx-text-weak)" }} />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-bold text-foreground">{machine.name}</h1>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
                  <span className={`w-2 h-2 rounded-full ${status.dot} ${isOnline ? "animate-pulse" : ""}`} />
                  {t(`common:status.${statusKey(machine.status)}`)}
                </span>
                {/* Agent reconnecting: DB status still ONLINE (90s grace) but
                    WS down. Clearly distinguished from "truly online" to prevent
                    the user from triggering an action that would fail with "Agent
                    is not connected". */}
                {isOnline && machine.isConnected === false && (
                  <span
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{ background: "var(--nx-warning-subtle)", color: "var(--nx-warning)" }}
                    title={t("reconnectingTitle")}
                  >
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--nx-warning)" }} />
                    {t("reconnecting")}
                  </span>
                )}
                {machine.isCritical && (
                  <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase inline-flex items-center gap-1"
                    style={{ background: "var(--nx-warning-subtle)", color: "var(--nx-warning)" }}
                    title={t("criticalBadgeTitle")}
                  >
                    {t("criticalBadge")}
                  </span>
                )}
                {machine.sudoersOutdated && (
                  <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase inline-flex items-center gap-1 bg-warning-subtle text-warning"
                    title={t("sudoersBadgeTitle")}
                  >
                    {t("sudoersBadge")}
                  </span>
                )}
                {machine.rebootRequired && <span title={t("rebootRequiredTitle")}><RotateCcw className="w-4 h-4" style={{ color: "var(--nx-warning)" }} /></span>}
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: "var(--nx-text-weak)" }}>
                {machine.hostname && <span>{machine.hostname}</span>}
                {machine.ipAddress && <span>· {machine.ipAddress}</span>}
                {machine.os && <span>· {machine.os} {machine.osVersion}</span>}
                {machine.arch && <span>· {machine.arch}</span>}
              </div>
              {/* Critical badges — visible right in the header, clickable to the relevant tab */}
              <HeaderBadges
                data={attention}
                onTabChange={(t) => setActiveTab(t as Tab)}
                onShowFailedServices={showFailedServices}
              />
            </div>
          </div>

          {isAdmin && (
            <div className="flex items-center gap-1.5 shrink-0">
              <Tooltip content={t("actions.reloadTooltip")}>
                <button
                  onClick={async () => {
                    if (!id) return;
                    attention.reload();
                    try {
                      const [m, lm] = await Promise.all([
                        api.getMachine(id),
                        api.getLatestMetrics(id).catch(() => null),
                      ]);
                      setMachine(m);
                      if (lm) setLatestMetric(lm);
                    } catch (err) {
                      console.warn("[MachineDetail] refresh failed:", err);
                    }
                  }}
                  aria-label={t("actions.reload")}
                  disabled={attention.loading}
                  className={ICON_BTN}
                  style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
                >
                  <RefreshCw className={`w-4 h-4 ${attention.loading ? "animate-spin" : ""}`} />
                </button>
              </Tooltip>

              {machine.ipAddress && (
                <Tooltip content={t("actions.sshTooltip")}>
                  <button
                    onClick={() => setShowSshDialog(true)}
                    aria-label={t("actions.ssh")}
                    className={ICON_BTN}
                    style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text)" }}
                  >
                    <Terminal className="w-4 h-4" />
                  </button>
                </Tooltip>
              )}

              {isOnline && (
                <Tooltip
                  content={
                    agentUpToDate === true
                      ? t("actions.agentUpToDate")
                      : agentUpdateAvailable
                      ? t("actions.agentUpdateAvailable")
                      : t("actions.agentUpdate")
                  }
                >
                  <button
                    onClick={() => {
                      if (agentUpToDate !== true) setShowAgentUpgrade(true);
                    }}
                    aria-disabled={agentUpToDate === true}
                    aria-label={t("actions.agentUpdate")}
                    className={`relative ${ICON_BTN} ${agentUpToDate === true ? "opacity-50 cursor-default" : ""}`}
                    style={{
                      border: `1px solid ${
                        agentUpToDate === true
                          ? "var(--nx-border)"
                          : agentUpdateAvailable
                          ? "var(--nx-warning)"
                          : "var(--nx-info)"
                      }`,
                      color:
                        agentUpToDate === true
                          ? "var(--nx-text-weak)"
                          : agentUpdateAvailable
                          ? "var(--nx-warning)"
                          : "var(--nx-info)",
                    }}
                  >
                    <ArrowUpCircle className="w-4 h-4" />
                    {agentUpdateAvailable && (
                      <span
                        className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border"
                        style={{ background: "var(--nx-warning)", borderColor: "var(--nx-bg-surface)" }}
                      />
                    )}
                  </button>
                </Tooltip>
              )}

              {isOnline && !machine.isCritical && (
                <Tooltip content={t("actions.rebootTooltip")}>
                  <button onClick={handleReboot} aria-label={t("actions.reboot")} className={ICON_BTN} style={{ border: "1px solid var(--nx-warning)", color: "var(--nx-warning)" }}>
                    <Power className="w-4 h-4" />
                  </button>
                </Tooltip>
              )}

              {machine.status !== "REVOKED" && (
                <Tooltip content={t("actions.revokeTooltip")}>
                  <button onClick={handleRevoke} aria-label={t("actions.revoke")} className={ICON_BTN} style={{ border: "1px solid var(--nx-warning)", color: "var(--nx-warning)" }}>
                    <ShieldOff className="w-4 h-4" />
                  </button>
                </Tooltip>
              )}

              <Tooltip content={t("actions.reEnrollTooltip")}>
                <button onClick={() => navigate(`/machines/${id}/enroll`)} aria-label={t("actions.reEnroll")} className={ICON_BTN} style={{ border: "1px solid var(--nx-accent)", color: "var(--nx-accent)" }}>
                  <RotateCcw className="w-4 h-4" />
                </button>
              </Tooltip>

              <Tooltip content={t("actions.deleteTooltip")}>
                <button onClick={handleDelete} aria-label={t("actions.delete")} className={ICON_BTN} style={{ border: "1px solid var(--nx-danger)", color: "var(--nx-danger)" }}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </Tooltip>
            </div>
          )}
        </div>

        {/* ── Live gauges (quand online) ──── */}
        {isOnline && latestMetric && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mt-5 pt-5" style={{ borderTop: "1px solid var(--nx-border)" }}>
            <MiniGauge label="CPU" value={latestMetric.cpuPercent} unit="%" icon={Cpu} />
            <MiniGauge label="RAM" value={latestMetric.memoryPercent} unit="%" icon={MemoryStick} subtext={`${formatBytes(latestMetric.memoryUsed)} / ${formatBytes(latestMetric.memoryTotal)}`} />
            {latestMetric.disks?.slice(0, 2).map((d, i) => (
              <MiniGauge key={i} label={d.mountpoint === "/" ? t("gauges.diskRoot") : d.mountpoint} value={d.percent} unit="%" icon={HardDrive} subtext={`${formatBytes(d.used)} / ${formatBytes(d.total)}`} />
            ))}
            <MiniGauge label="Load" value={latestMetric.loadAvg1 ?? 0} unit="" icon={Activity} subtext={`${(latestMetric.loadAvg5 ?? 0).toFixed(2)} / ${(latestMetric.loadAvg15 ?? 0).toFixed(2)}`} max={100} raw />
            <MiniGauge label="Uptime" value={0} unit="" icon={Clock} subtext={latestMetric.uptime ? formatUptime(latestMetric.uptime) : "?"} raw hideBar />
          </div>
        )}
      </div>

      {/* ── Two-row tabs : categories + subtabs ────────────────── */}
      {(() => {
        const activeGroupIdx = tabGroups.findIndex(g => g.tabs.some(t => t.id === activeTab && t.show));
        const activeGroup = activeGroupIdx >= 0 ? tabGroups[activeGroupIdx] : null;
        const activeSubtabs = activeGroup ? activeGroup.tabs.filter(tb => tb.show) : [];
        const showSecondRow = activeGroup && activeGroup.key && activeSubtabs.length >= 2;

        const handleGroupClick = (group: typeof tabGroups[number]) => {
          const visible = group.tabs.filter(tb => tb.show);
          if (visible.length === 0) return;
          // If the group already contains activeTab, don't change anything
          if (visible.some(tb => tb.id === activeTab)) return;
          // Otherwise: restore the last visited subtab if still visible, or the first
          const remembered = group.key ? lastSubtab[group.key] : undefined;
          const restore = remembered && visible.some(tb => tb.id === remembered) ? remembered : visible[0].id;
          setActiveTab(restore);
        };

        // Update the memory when switching tabs
        const selectSubtab = (group: typeof tabGroups[number], tabId: Tab) => {
          setActiveTab(tabId);
          if (group.key) {
            setLastSubtab(prev => ({ ...prev, [group.key]: tabId }));
          }
        };

        return (
          <div className="mb-4 rounded-lg" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
            {/* Row 1 : categories */}
            <div className="flex flex-wrap items-center gap-1 p-1">
              {tabGroups.map((group, gi) => {
                const visibleTabs = group.tabs.filter(tb => tb.show);
                if (visibleTabs.length === 0) return null;
                const isActive = gi === activeGroupIdx;

                // Group without a key (Overview) = direct button for the single subtab
                if (!group.key && visibleTabs.length === 1) {
                  const onlyTab = visibleTabs[0];
                  return (
                    <button
                      key={onlyTab.id}
                      onClick={() => setActiveTab(onlyTab.id)}
                      title={t(`tabs.${onlyTab.id}.tooltip`)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-all"
                      style={{
                        background: activeTab === onlyTab.id ? "var(--nx-primary-subtle)" : "transparent",
                        color: activeTab === onlyTab.id ? "var(--nx-primary)" : "var(--nx-text-weak)",
                      }}
                    >
                      <onlyTab.icon className="w-3.5 h-3.5" />
                      {t(`tabs.${onlyTab.id}.label`)}
                    </button>
                  );
                }

                return (
                  <button
                    key={group.key}
                    onClick={() => handleGroupClick(group)}
                    className="px-4 py-2 rounded-md text-xs font-medium transition-all"
                    style={{
                      background: isActive ? "var(--nx-primary-subtle)" : "transparent",
                      color: isActive ? "var(--nx-primary)" : "var(--nx-text-weak)",
                    }}
                  >
                    {t(`groups.${group.key}`)}
                  </button>
                );
              })}
            </div>

            {/* Row 2 : subtabs of the active group */}
            {showSecondRow && (
              <div
                className="flex flex-wrap items-center gap-1 px-3 py-2"
                style={{ borderTop: "1px solid var(--nx-border)", background: "var(--nx-bg-base)" }}
              >
                {activeSubtabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => selectSubtab(activeGroup!, tab.id)}
                    title={t(`tabs.${tab.id}.tooltip`)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all"
                    style={{
                      background: activeTab === tab.id ? "var(--nx-bg-surface)" : "transparent",
                      color: activeTab === tab.id ? "var(--nx-text)" : "var(--nx-text-weak)",
                      border: activeTab === tab.id ? "1px solid var(--nx-border)" : "1px solid transparent",
                    }}
                  >
                    <tab.icon className="w-3.5 h-3.5" />
                    {t(`tabs.${tab.id}.label`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Tab Content ────────────────────────── */}
      <div className="space-y-4">
        {activeTab === "overview" && (
          <OverviewTab
            machine={machine}
            latestMetric={latestMetric}
            isAdmin={isAdmin}
            attention={attention}
            onTabChange={(t) => setActiveTab(t as Tab)}
            onShowFailedServices={showFailedServices}
            onUpdated={async () => {
              if (!id) return;
              const m = await api.getMachine(id);
              setMachine(m);
            }}
          />
        )}

        {activeTab === "metrics" && isOnline && (
          <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
            <h2 className="text-sm font-semibold text-foreground mb-4">{t("metricsHistory")}</h2>
            <MetricsChart machineId={machine.id} />
          </div>
        )}

        {activeTab === "packages" && isOnline && (
          <PackagesTab machineId={machine.id} />
        )}

        {activeTab === "updates" && isOnline && (
          <UpdatePanel machineId={machine.id} machineName={machine.name} />
        )}

        {activeTab === "processes" && isOnline && (
          <ProcessList machineId={machine.id} />
        )}

        {activeTab === "services" && isOnline && (
          <ServicesTab
            machineId={machine.id}
            onViewLogs={setLogsService}
            pendingFilter={pendingServiceFilter}
            onPendingFilterConsumed={consumePendingServiceFilter}
          />
        )}

        {activeTab === "firewall" && isOnline && (
          <FirewallTab machineId={machine.id} />
        )}

        {activeTab === "storage" && isOnline && (
          <StorageTab machineId={machine.id} />
        )}

        {activeTab === "scheduling" && isOnline && (
          <SchedulingTab machineId={machine.id} />
        )}

        {activeTab === "users" && isOnline && (
          <UsersTab
            machineId={machine.id}
            canManagePrivileges={canManagePrivileges}
          />
        )}

        {activeTab === "files" && isOnline && (
          <FilesTab machine={machine} />
        )}

        {activeTab === "security" && isOnline && (
          <SecurityTab machineId={machine.id} />
        )}

        {activeTab === "logs" && isOnline && (
          <LogShippingTab machineId={machine.id} />
        )}

        {activeTab === "netplan" && isOnline && (
          <NetworkConfigTab machineId={machine.id} />
        )}

        {activeTab === "network" && isOnline && (
          <NetworkTab latestMetric={latestMetric} />
        )}
      </div>

      {logsService && (
        <LogsDrawer
          machineId={machine.id}
          service={logsService}
          onClose={() => setLogsService(null)}
        />
      )}

      {showSshDialog && machine.ipAddress && (
        <SshConnectDialog
          ipAddress={machine.ipAddress}
          defaultUser={machine.sshUser}
          onClose={() => setShowSshDialog(false)}
        />
      )}

      {showAgentUpgrade && (
        <AgentUpgradeDialog
          machineId={machine.id}
          machineName={machine.name}
          ipAddress={machine.ipAddress}
          sshUser={machine.sshUser}
          onClose={() => setShowAgentUpgrade(false)}
          onSuccess={refreshAgentStatus}
        />
      )}

      {ConfirmDialogElement}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Overview Tab — hierarchical redesign:
   1. Attention required (alerts/services/updates/certs) — top priority
   2. Live storage (useful visual)
   3. Compact inventory (static, at the bottom)
   ══════════════════════════════════════════════ */
function OverviewTab({ machine, latestMetric, isAdmin, onUpdated, onTabChange, onShowFailedServices, attention }: {
  machine: Machine;
  latestMetric: Metric | null;
  isAdmin: boolean;
  onUpdated: () => void | Promise<void>;
  onTabChange?: (tab: string) => void;
  onShowFailedServices?: () => void;
  attention: ReturnType<typeof useMachineAttention>;
}) {
  const { t } = useTranslation("machineDetail");
  const isOnlineAgent = machine.status === "ONLINE";

  return (
    <div className="space-y-4">
      {/* 1. Attention required — data loaded once at the parent level */}
      {isOnlineAgent && (
        <AttentionPanel data={attention} onTabChange={onTabChange} onShowFailedServices={onShowFailedServices} />
      )}

      {/* 2. Live storage — useful visual to spot a disk filling up */}
      {latestMetric && latestMetric.disks && latestMetric.disks.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>{t("overview.storage")}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {latestMetric.disks.map((disk, i) => (
              <div key={i} className="rounded-lg p-3" style={{ background: "var(--nx-bg-elevated)" }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-foreground font-mono">{disk.mountpoint}</span>
                  <span className="text-xs font-semibold tabular-nums" style={{ color: disk.percent > 90 ? "var(--nx-danger)" : disk.percent > 70 ? "var(--nx-warning)" : "var(--nx-success)" }}>
                    {disk.percent.toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 rounded-full overflow-hidden mb-1.5" style={{ background: "var(--nx-bg-base)" }}>
                  <div className="h-full rounded-full transition-all duration-500" style={{
                    width: `${Math.min(disk.percent, 100)}%`,
                    background: disk.percent > 90 ? "var(--nx-danger)" : disk.percent > 70 ? "var(--nx-warning)" : "var(--nx-success)",
                  }} />
                </div>
                <div className="text-[10px]" style={{ color: "var(--nx-text-weak)" }}>
                  {formatBytes(disk.used)} / {formatBytes(disk.total)} — {t("overview.diskFree", { free: formatBytes(disk.free) })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Compact inventory — static info at the bottom */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>{t("overview.system")}</h3>
          <div className="space-y-2.5">
            <InfoRow label={t("overview.info.os")} value={`${machine.os || "?"} ${machine.osVersion || ""}`} />
            <InfoRow label={t("overview.info.architecture")} value={machine.arch || "?"} />
            <InfoRow label={t("overview.info.hostname")} value={machine.hostname || "?"} />
            <InfoRow label={t("overview.info.agent")} value={machine.agentVersion || "?"} />
            <InfoRow label={t("overview.info.uptime")} value={latestMetric?.uptime ? formatUptime(latestMetric.uptime) : "?"} />
          </div>
        </div>

        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>{t("overview.network")}</h3>
          <div className="space-y-2.5">
            <InfoRow label={t("overview.info.ip")} value={machine.ipAddress || "?"} />
            <InfoRow label={t("overview.info.lastSignal")} value={timeAgo(machine.lastHeartbeat)} />
            <InfoRow label={t("overview.info.enrolledAt")} value={machine.enrolledAt ? formatDate(machine.enrolledAt) : t("overview.notEnrolled")} />
            <InfoRow label={t("overview.info.createdAt")} value={formatDate(machine.createdAt)} />
          </div>
        </div>

        {isAdmin && (
          <EditableSettings machine={machine} onUpdated={onUpdated} />
        )}
      </div>

      {/* Tags if present */}
      {machine.tags && machine.tags.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>{t("overview.tags")}</h3>
          <div className="flex flex-wrap gap-2">
            {machine.tags.map((mt: any) => (
              <span key={mt.tag?.id || mt.id} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{ backgroundColor: `${(mt.tag?.color || mt.color)}18`, color: mt.tag?.color || mt.color }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: mt.tag?.color || mt.color }} />
                {mt.tag?.name || mt.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Network Tab
   ══════════════════════════════════════════════ */
function NetworkTab({ latestMetric }: { latestMetric: Metric | null }) {
  const { t } = useTranslation("machineDetail");
  const netInterfaces = (latestMetric?.network as any[]) || [];

  if (netInterfaces.length === 0) {
    return (
      <div className="rounded-xl p-8 text-center" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
        <Network className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--nx-text-weak)" }} />
        <p className="text-sm text-muted-foreground">{t("networkTab.empty")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
      <h3 className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--nx-text-weak)" }}>{t("networkTab.title")}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {netInterfaces.map((iface: any) => (
          <div key={iface.name} className="rounded-lg p-4" style={{ background: "var(--nx-bg-elevated)" }}>
            <div className="flex items-center gap-2 mb-3">
              <Network className="w-4 h-4" style={{ color: "var(--nx-info)" }} />
              <span className="text-sm font-semibold text-foreground font-mono">{iface.name}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] uppercase mb-1" style={{ color: "var(--nx-text-weak)" }}>{t("networkTab.received")}</div>
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {((iface.rx_bytes_per_sec || 0) / 1024).toFixed(1)} <span className="text-xs font-normal" style={{ color: "var(--nx-text-weak)" }}>KB/s</span>
                </div>
                <div className="text-[10px] tabular-nums" style={{ color: "var(--nx-text-weak)" }}>
                  {t("networkTab.total")} {formatBytes(iface.rx_bytes || 0)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase mb-1" style={{ color: "var(--nx-text-weak)" }}>{t("networkTab.sent")}</div>
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {((iface.tx_bytes_per_sec || 0) / 1024).toFixed(1)} <span className="text-xs font-normal" style={{ color: "var(--nx-text-weak)" }}>KB/s</span>
                </div>
                <div className="text-[10px] tabular-nums" style={{ color: "var(--nx-text-weak)" }}>
                  {t("networkTab.total")} {formatBytes(iface.tx_bytes || 0)}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   Subcomponents
   ══════════════════════════════════════════════ */
function EditableSettings({ machine, onUpdated }: { machine: Machine; onUpdated: () => void | Promise<void> }) {
  const { t } = useTranslation(["machineDetail", "common"]);
  const [name, setName] = useState(machine.name);
  const [sshUser, setSshUser] = useState(machine.sshUser || "");
  const [isCritical, setIsCritical] = useState(machine.isCritical);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(machine.name);
    setSshUser(machine.sshUser || "");
    setIsCritical(machine.isCritical);
  }, [machine.name, machine.sshUser, machine.isCritical]);

  const isDirty = name !== machine.name
    || (sshUser || null) !== (machine.sshUser || null)
    || isCritical !== machine.isCritical;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.updateMachine(machine.id, {
        name: name.trim(),
        sshUser: sshUser.trim() || null,
        isCritical,
      });
      await onUpdated();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(getErrorMessage(err, t("common:errors.generic")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
      <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>
        {t("settings.title")}
      </h3>
      <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--nx-text-weak)" }}>
            {t("settings.nameLabel")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-input bg-background px-3 py-1.5 text-xs font-mono"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--nx-text-weak)" }}>
            {t("settings.sshUserLabel")}
          </label>
          <input
            type="text"
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            placeholder={t("settings.sshUserPlaceholder")}
            className="w-full rounded border border-input bg-background px-3 py-1.5 text-xs font-mono"
          />
          <p className="text-[10px] mt-1" style={{ color: "var(--nx-text-weak)" }}>
            {t("settings.sshUserHint")}
          </p>
        </div>

        <label className="flex items-start gap-2 cursor-pointer py-2 px-2 rounded"
          style={{ background: isCritical ? "var(--nx-warning-subtle)" : "var(--nx-bg-elevated)" }}
        >
          <input
            type="checkbox"
            checked={isCritical}
            onChange={(e) => setIsCritical(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-xs font-semibold" style={{ color: isCritical ? "var(--nx-warning)" : "var(--nx-text)" }}>
              {t("settings.criticalLabel")}
            </div>
            <p className="text-[10px] mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
              <Trans i18nKey="settings.criticalHint" t={t} components={[<code key="0" />, <code key="1" />, <code key="2" />]} />
            </p>
          </div>
        </label>

        {error && (
          <div className="rounded px-2 py-1.5 text-[10px]" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
            {error}
          </div>
        )}

        <button
          onClick={save}
          disabled={!isDirty || saving || !name.trim()}
          className="w-full rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50 transition-colors"
          style={{
            background: saved ? "var(--nx-success)" : "var(--nx-primary)",
            color: "var(--nx-bg-base)",
          }}
        >
          {saving ? t("settings.saving") : saved ? t("settings.saved") : t("settings.save")}
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs" style={{ color: "var(--nx-text-weak)" }}>{label}</span>
      <span className="text-xs font-medium text-foreground">{value}</span>
    </div>
  );
}

function MiniGauge({ label, value, unit, icon: Icon, subtext, max = 100, raw, hideBar }: {
  label: string; value: number; unit: string; icon: typeof Cpu;
  subtext?: string; max?: number; raw?: boolean; hideBar?: boolean;
}) {
  const pct = raw ? 0 : Math.min(value, max);
  const color = raw ? "var(--nx-text)" : pct > 90 ? "var(--nx-danger)" : pct > 70 ? "var(--nx-warning)" : "var(--nx-success)";

  return (
    <div className="rounded-lg p-3 flex flex-col" style={{ background: "var(--nx-bg-elevated)" }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="w-3 h-3" style={{ color: "var(--nx-text-weak)" }} />
        <span className="text-[10px] uppercase" style={{ color: "var(--nx-text-weak)" }}>{label}</span>
      </div>
      <div className="text-lg font-bold tabular-nums leading-none" style={{ color }}>
        {raw ? (value || subtext || "—") : `${value.toFixed(1)}${unit}`}
      </div>
      {subtext && <div className="text-[10px] mt-1" style={{ color: "var(--nx-text-weak)" }}>{subtext}</div>}
      {!hideBar && !raw && (
        <div className="mt-auto pt-2">
          <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--nx-bg-base)" }}>
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
          </div>
        </div>
      )}
    </div>
  );
}
