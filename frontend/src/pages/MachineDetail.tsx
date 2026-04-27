import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft, Server, Shield, Trash2, ShieldOff, RefreshCw,
  Cpu, MemoryStick, HardDrive, Clock, Globe, Terminal,
  Activity, Network, ListTree, Download, Radio, AlertTriangle,
  RotateCcw, ArrowUpCircle, Cog, Power,
} from "lucide-react";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useWebSocket } from "../hooks/useWebSocket";
import {
  statusColor, statusLabel, formatBytes, formatUptime, timeAgo,
} from "../lib/utils";
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
import NetworkConfigTab from "../components/NetworkConfigTab";
import SshConnectDialog from "../components/SshConnectDialog";
import AttentionPanel from "../components/AttentionPanel";
import { useConfirm, PageLoader } from "../components/ui";
import { toast } from "sonner";
import type { Machine, Metric, WSDashboardMessage } from "../types";
import { getErrorMessage } from "../services/errors";

type Tab = "overview" | "metrics" | "updates" | "processes" | "network" | "netplan" | "services" | "firewall" | "packages" | "storage" | "scheduling" | "users";

export default function MachineDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [machine, setMachine] = useState<Machine | null>(null);
  const [latestMetric, setLatestMetric] = useState<Metric | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [lastSubtab, setLastSubtab] = useState<Record<string, Tab>>({});
  const [logsService, setLogsService] = useState<string | null>(null);
  const [showSshDialog, setShowSshDialog] = useState(false);
  const { confirm, ConfirmDialogElement } = useConfirm();

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
        title: "Révoquer cette machine ?",
        description: "L'agent sera déconnecté immédiatement et ne pourra plus communiquer avec Nexus tant qu'il n'est pas ré-enrôlé.",
        confirmLabel: "Révoquer",
        variant: "warning",
      }))
    )
      return;
    try {
      await api.revokeMachine(id, "Revoked from UI");
      setMachine(await api.getMachine(id));
      toast.success("Machine révoquée");
    } catch (err) {
      toast.error(getErrorMessage(err, "Erreur"));
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (
      !(await confirm({
        title: "Supprimer définitivement cette machine ?",
        description: "Cette action est irréversible. Toutes les métriques et l'historique d'audit liés à cette machine seront supprimés.",
        confirmLabel: "Supprimer",
        variant: "danger",
      }))
    )
      return;
    try {
      await api.deleteMachine(id);
      toast.success("Machine supprimée");
      navigate("/machines");
    } catch (err) {
      toast.error(getErrorMessage(err, "Erreur"));
    }
  };

  const handleUpgradeAgent = async () => {
    if (!id) return;
    if (
      !(await confirm({
        title: "Mettre à jour l'agent ?",
        description:
          "L'agent va télécharger la dernière version et se redémarrer automatiquement (~5s d'interruption).",
        confirmLabel: "Mettre à jour",
        variant: "primary",
      }))
    )
      return;
    try {
      const res = await api.upgradeAgent(id);
      toast.success(res.message || "Mise à jour déclenchée");
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec de la mise à jour"));
    }
  };

  const handleReboot = async () => {
    if (!id) return;
    if (
      !(await confirm({
        title: "Redémarrer la machine ?",
        description:
          "La machine sera coupée puis reviendra en environ 60s. Confirmez en tapant REBOOT.",
        confirmWord: "REBOOT",
        confirmLabel: "Redémarrer",
        variant: "danger",
      }))
    )
      return;
    try {
      await api.rebootMachine(id);
      toast.success("Redémarrage déclenché. Retour dans ~60s.");
    } catch (err) {
      toast.error(getErrorMessage(err, "Échec du redémarrage"));
    }
  };


  if (loading || !machine) {
    return <PageLoader />;
  }

  const status = statusColor(machine.status);
  const isAdmin = user?.role === "ADMIN";
  const isOnline = machine.status === "ONLINE";
  const isProbe = machine.type === "PROBE";
  const isAgent = machine.type === "AGENT";

  const tabGroups: {
    label: string;
    tabs: { id: Tab; label: string; icon: typeof Activity; show: boolean }[];
  }[] = [
    {
      label: "",
      tabs: [
        { id: "overview", label: "Vue d'ensemble", icon: Activity, show: true },
      ],
    },
    {
      label: "Monitoring",
      tabs: [
        { id: "metrics", label: "Métriques", icon: Cpu, show: isOnline },
        { id: "processes", label: "Processus", icon: ListTree, show: isOnline },
        { id: "storage", label: "Stockage", icon: HardDrive, show: isOnline },
      ],
    },
    {
      label: "Système",
      tabs: [
        { id: "services", label: "Services", icon: Cog, show: isOnline && isAgent },
        { id: "scheduling", label: "Tâches", icon: Clock, show: isOnline },
        { id: "users", label: "Utilisateurs", icon: Server, show: isOnline },
      ],
    },
    {
      label: "Réseau",
      tabs: [
        { id: "network", label: "Interfaces", icon: Network, show: isOnline },
        { id: "netplan", label: "Netplan", icon: Globe, show: isOnline && isAgent },
        { id: "firewall", label: "Pare-feu", icon: Shield, show: isOnline && isAgent },
      ],
    },
    {
      label: "Logiciels",
      tabs: [
        { id: "updates", label: "Mises à jour", icon: Download, show: isOnline && isAgent },
        { id: "packages", label: "Paquets", icon: Download, show: isOnline && isAgent },
      ],
    },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Back */}
      <Link to="/machines" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Machines
      </Link>

      {/* ── Header ─────────────────────────────── */}
      <div className="rounded-xl p-5 mb-4" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: "var(--nx-bg-elevated)" }}>
              {isProbe ? <Radio className="w-7 h-7" style={{ color: "var(--nx-info)" }} />
                : <Server className="w-7 h-7" style={{ color: "var(--nx-text-weak)" }} />}
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-bold text-foreground">{machine.name}</h1>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
                  <span className={`w-2 h-2 rounded-full ${status.dot} ${isOnline ? "animate-pulse" : ""}`} />
                  {statusLabel(machine.status)}
                </span>
                {isProbe && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase" style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>Probe</span>}
                {machine.isCritical && (
                  <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase inline-flex items-center gap-1"
                    style={{ background: "var(--nx-warning-subtle)", color: "var(--nx-warning)" }}
                    title="Machine critique : reboot et stop de services critiques bloqués"
                  >
                    ⚠ Critique
                  </span>
                )}
                {machine.sudoersOutdated && (
                  <span
                    className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase inline-flex items-center gap-1 bg-warning-subtle text-warning"
                    title="Les sudoers de cet agent diffèrent de la version attendue. Ré-installez l'agent avec install-agent.sh pour bénéficier des nouvelles actions."
                  >
                    ⚠ Sudoers obsolètes
                  </span>
                )}
                {machine.rebootRequired && <span title="Reboot requis"><RotateCcw className="w-4 h-4" style={{ color: "var(--nx-warning)" }} /></span>}
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: "var(--nx-text-weak)" }}>
                {machine.hostname && <span>{machine.hostname}</span>}
                {machine.ipAddress && <span>· {machine.ipAddress}</span>}
                {machine.os && <span>· {machine.os} {machine.osVersion}</span>}
                {machine.arch && <span>· {machine.arch}</span>}
              </div>
            </div>
          </div>

          {isAdmin && (
            <div className="flex gap-2">
              {machine.ipAddress && (
                <button
                  onClick={() => setShowSshDialog(true)}
                  title="Connexion SSH : copie la commande + instructions par OS"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                  style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text)" }}
                >
                  <Terminal className="w-3.5 h-3.5" /> SSH
                </button>
              )}
              {isOnline && (
                <button onClick={handleUpgradeAgent} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" style={{ border: "1px solid var(--nx-info)", color: "var(--nx-info)" }}>
                  <ArrowUpCircle className="w-3.5 h-3.5" /> Mettre à jour l'agent
                </button>
              )}
              {isOnline && isAgent && !machine.isCritical && (
                <button onClick={handleReboot} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" style={{ border: "1px solid var(--nx-warning)", color: "var(--nx-warning)" }}>
                  <Power className="w-3.5 h-3.5" /> Redémarrer
                </button>
              )}
              {machine.status !== "REVOKED" && (
                <button onClick={handleRevoke} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" style={{ border: "1px solid var(--nx-warning)", color: "var(--nx-warning)" }}>
                  <ShieldOff className="w-3.5 h-3.5" /> Révoquer
                </button>
              )}
              <button onClick={handleDelete} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" style={{ border: "1px solid var(--nx-danger)", color: "var(--nx-danger)" }}>
                <Trash2 className="w-3.5 h-3.5" /> Supprimer
              </button>
            </div>
          )}
        </div>

        {/* ── Live gauges (quand online) ──── */}
        {isOnline && latestMetric && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mt-5 pt-5" style={{ borderTop: "1px solid var(--nx-border)" }}>
            <MiniGauge label="CPU" value={latestMetric.cpuPercent} unit="%" icon={Cpu} />
            <MiniGauge label="RAM" value={latestMetric.memoryPercent} unit="%" icon={MemoryStick} subtext={`${formatBytes(latestMetric.memoryUsed)} / ${formatBytes(latestMetric.memoryTotal)}`} />
            {latestMetric.disks?.slice(0, 2).map((d, i) => (
              <MiniGauge key={i} label={d.mountpoint === "/" ? "Disque /" : d.mountpoint} value={d.percent} unit="%" icon={HardDrive} subtext={`${formatBytes(d.used)} / ${formatBytes(d.total)}`} />
            ))}
            <MiniGauge label="Load" value={latestMetric.loadAvg1 ?? 0} unit="" icon={Activity} subtext={`${(latestMetric.loadAvg5 ?? 0).toFixed(2)} / ${(latestMetric.loadAvg15 ?? 0).toFixed(2)}`} max={100} raw />
            <MiniGauge label="Uptime" value={0} unit="" icon={Clock} subtext={latestMetric.uptime ? formatUptime(latestMetric.uptime) : "?"} raw hideBar />
          </div>
        )}
      </div>

      {/* ── Two-row tabs : categories + sous-onglets ────────────────── */}
      {(() => {
        const activeGroupIdx = tabGroups.findIndex(g => g.tabs.some(t => t.id === activeTab && t.show));
        const activeGroup = activeGroupIdx >= 0 ? tabGroups[activeGroupIdx] : null;
        const activeSubtabs = activeGroup ? activeGroup.tabs.filter(t => t.show) : [];
        const showSecondRow = activeGroup && activeGroup.label && activeSubtabs.length >= 2;

        const handleGroupClick = (group: typeof tabGroups[number]) => {
          const visible = group.tabs.filter(t => t.show);
          if (visible.length === 0) return;
          // Si le groupe contient deja activeTab, on ne change rien
          if (visible.some(t => t.id === activeTab)) return;
          // Sinon : restaurer le dernier sous-onglet visite si toujours visible, ou premier
          const remembered = group.label ? lastSubtab[group.label] : undefined;
          const restore = remembered && visible.some(t => t.id === remembered) ? remembered : visible[0].id;
          setActiveTab(restore);
        };

        // Mettre a jour la memoire quand on change d'onglet
        const selectSubtab = (group: typeof tabGroups[number], tabId: Tab) => {
          setActiveTab(tabId);
          if (group.label) {
            setLastSubtab(prev => ({ ...prev, [group.label]: tabId }));
          }
        };

        return (
          <div className="mb-4 rounded-lg" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
            {/* Row 1 : categories */}
            <div className="flex flex-wrap items-center gap-1 p-1">
              {tabGroups.map((group, gi) => {
                const visibleTabs = group.tabs.filter(t => t.show);
                if (visibleTabs.length === 0) return null;
                const isActive = gi === activeGroupIdx;

                // Groupe sans label (Vue d'ensemble) = bouton direct du seul sous-onglet
                if (!group.label && visibleTabs.length === 1) {
                  const t = visibleTabs[0];
                  return (
                    <button
                      key={t.id}
                      onClick={() => setActiveTab(t.id)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-all"
                      style={{
                        background: activeTab === t.id ? "var(--nx-primary-subtle)" : "transparent",
                        color: activeTab === t.id ? "var(--nx-primary)" : "var(--nx-text-weak)",
                      }}
                    >
                      <t.icon className="w-3.5 h-3.5" />
                      {t.label}
                    </button>
                  );
                }

                return (
                  <button
                    key={group.label}
                    onClick={() => handleGroupClick(group)}
                    className="px-4 py-2 rounded-md text-xs font-medium transition-all"
                    style={{
                      background: isActive ? "var(--nx-primary-subtle)" : "transparent",
                      color: isActive ? "var(--nx-primary)" : "var(--nx-text-weak)",
                    }}
                  >
                    {group.label}
                  </button>
                );
              })}
            </div>

            {/* Row 2 : sous-onglets du groupe actif */}
            {showSecondRow && (
              <div
                className="flex flex-wrap items-center gap-1 px-3 py-2"
                style={{ borderTop: "1px solid var(--nx-border)", background: "var(--nx-bg-base)" }}
              >
                {activeSubtabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => selectSubtab(activeGroup!, tab.id)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all"
                    style={{
                      background: activeTab === tab.id ? "var(--nx-bg-surface)" : "transparent",
                      color: activeTab === tab.id ? "var(--nx-text)" : "var(--nx-text-weak)",
                      border: activeTab === tab.id ? "1px solid var(--nx-border)" : "1px solid transparent",
                    }}
                  >
                    <tab.icon className="w-3.5 h-3.5" />
                    {tab.label}
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
            onTabChange={(t) => setActiveTab(t as Tab)}
            onUpdated={async () => {
              if (!id) return;
              const m = await api.getMachine(id);
              setMachine(m);
            }}
          />
        )}

        {activeTab === "metrics" && isOnline && (
          <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
            <h2 className="text-sm font-semibold text-foreground mb-4">Historique des métriques</h2>
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
          <ServicesTab machineId={machine.id} onViewLogs={setLogsService} />
        )}

        {activeTab === "firewall" && isOnline && (
          <FirewallTab machineId={machine.id} />
        )}

        {activeTab === "storage" && isOnline && (
          <StorageTab machineId={machine.id} />
        )}

        {activeTab === "scheduling" && isOnline && (
          <SchedulingTab machineId={machine.id} canMutate={isAgent} />
        )}

        {activeTab === "users" && isOnline && (
          <UsersTab machineId={machine.id} canMutate={isAgent} />
        )}

        {activeTab === "netplan" && isOnline && (
          <NetworkConfigTab machineId={machine.id} canMutate={isAgent} />
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

      {ConfirmDialogElement}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Overview Tab — refonte hiérarchisée :
   1. Attention requise (alerts/services/updates/certs) — top priority
   2. Stockage live (visuel utile)
   3. Inventaire compact (statique, en bas)
   ══════════════════════════════════════════════ */
function OverviewTab({ machine, latestMetric, isAdmin, onUpdated, onTabChange }: {
  machine: Machine;
  latestMetric: Metric | null;
  isAdmin: boolean;
  onUpdated: () => void | Promise<void>;
  onTabChange?: (tab: string) => void;
}) {
  const isOnlineAgent = machine.type === "AGENT" && machine.status === "ONLINE";

  return (
    <div className="space-y-4">
      {/* 1. Attention requise — auto-load alerts + services failed + updates + certs */}
      {isOnlineAgent && (
        <AttentionPanel machineId={machine.id} onTabChange={onTabChange} />
      )}

      {/* 2. Stockage live — info visuelle utile pour repérer un disque qui sature */}
      {latestMetric && latestMetric.disks && latestMetric.disks.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>Stockage</h3>
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
                  {formatBytes(disk.used)} / {formatBytes(disk.total)} — {formatBytes(disk.free)} libre
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Inventaire compact — info statique en bas */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>Système</h3>
          <div className="space-y-2.5">
            <InfoRow label="OS" value={`${machine.os || "?"} ${machine.osVersion || ""}`} />
            <InfoRow label="Architecture" value={machine.arch || "?"} />
            <InfoRow label="Hostname" value={machine.hostname || "?"} />
            <InfoRow label="Agent" value={machine.agentVersion || "?"} />
            <InfoRow label="Type" value={machine.type === "PROBE" ? "Probe (monitoring)" : "Agent (complet)"} />
            <InfoRow label="Uptime" value={latestMetric?.uptime ? formatUptime(latestMetric.uptime) : "?"} />
          </div>
        </div>

        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>Réseau</h3>
          <div className="space-y-2.5">
            <InfoRow label="IP" value={machine.ipAddress || "?"} />
            <InfoRow label="Dernier signal" value={timeAgo(machine.lastHeartbeat)} />
            <InfoRow label="Enregistré" value={machine.enrolledAt ? new Date(machine.enrolledAt).toLocaleDateString("fr-FR") : "Non"} />
            <InfoRow label="Créé" value={new Date(machine.createdAt).toLocaleDateString("fr-FR")} />
          </div>
        </div>

        {isAdmin && (
          <EditableSettings machine={machine} onUpdated={onUpdated} />
        )}
      </div>

      {/* Tags si présents */}
      {machine.tags && machine.tags.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>Tags</h3>
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
  const netInterfaces = (latestMetric?.network as any[]) || [];

  if (netInterfaces.length === 0) {
    return (
      <div className="rounded-xl p-8 text-center" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
        <Network className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--nx-text-weak)" }} />
        <p className="text-sm text-muted-foreground">Aucune donnée réseau disponible</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
      <h3 className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--nx-text-weak)" }}>Interfaces réseau</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {netInterfaces.map((iface: any) => (
          <div key={iface.name} className="rounded-lg p-4" style={{ background: "var(--nx-bg-elevated)" }}>
            <div className="flex items-center gap-2 mb-3">
              <Network className="w-4 h-4" style={{ color: "var(--nx-info)" }} />
              <span className="text-sm font-semibold text-foreground font-mono">{iface.name}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] uppercase mb-1" style={{ color: "var(--nx-text-weak)" }}>Reçu</div>
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {((iface.rx_bytes_per_sec || 0) / 1024).toFixed(1)} <span className="text-xs font-normal" style={{ color: "var(--nx-text-weak)" }}>KB/s</span>
                </div>
                <div className="text-[10px] tabular-nums" style={{ color: "var(--nx-text-weak)" }}>
                  Total: {formatBytes(iface.rx_bytes || 0)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase mb-1" style={{ color: "var(--nx-text-weak)" }}>Envoyé</div>
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {((iface.tx_bytes_per_sec || 0) / 1024).toFixed(1)} <span className="text-xs font-normal" style={{ color: "var(--nx-text-weak)" }}>KB/s</span>
                </div>
                <div className="text-[10px] tabular-nums" style={{ color: "var(--nx-text-weak)" }}>
                  Total: {formatBytes(iface.tx_bytes || 0)}
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
      setError(getErrorMessage(err, "Erreur"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
      <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-weak)" }}>
        Paramètres
      </h3>
      <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--nx-text-weak)" }}>
            Nom
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
            Utilisateur SSH
          </label>
          <input
            type="text"
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            placeholder="root, admin, ubuntu…"
            className="w-full rounded border border-input bg-background px-3 py-1.5 text-xs font-mono"
          />
          <p className="text-[10px] mt-1" style={{ color: "var(--nx-text-weak)" }}>
            Pré-rempli dans le bouton SSH. Vide = utilise le user courant du terminal.
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
              ⚠ Machine critique
            </div>
            <p className="text-[10px] mt-0.5" style={{ color: "var(--nx-text-weak)" }}>
              Si activé, bloque <code>reboot</code>, <code>service_stop</code> sur services critiques (docker, nginx, ssh, postgres…) et <code>package.remove</code> sur paquets critiques.
              À activer pour le serveur Nexus lui-même et les machines prod.
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
          {saving ? "Enregistrement..." : saved ? "Enregistré ✓" : "Enregistrer"}
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
