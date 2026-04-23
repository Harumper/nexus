import { Link, useNavigate } from "react-router-dom";
import { Server, Cpu, MemoryStick, HardDrive, Clock, Radio, AlertTriangle, Trash2, ShieldOff, MoreVertical, RefreshCw } from "lucide-react";
import { useState } from "react";
import { statusColor, statusLabel, timeAgo } from "../lib/utils";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import type { Machine, Metric } from "../types";

interface MachineCardProps {
  machine: Machine;
  latestMetric?: Metric | null;
  onDeleted?: () => void;
}

export default function MachineCard({ machine, latestMetric, onDeleted }: MachineCardProps) {
  const navigate = useNavigate();
  const status = statusColor(machine.status);
  const isOnline = machine.status === "ONLINE";
  const isPending = machine.status === "ENROLLMENT_PENDING";
  const isProbe = machine.type === "PROBE";
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Supprimer la machine "${machine.name}" ?`)) return;
    setActionLoading(true);
    try {
      await api.deleteMachine(machine.id);
      onDeleted?.();
    } catch {
      alert("Erreur lors de la suppression");
    } finally {
      setActionLoading(false);
      setMenuOpen(false);
    }
  };

  const handleRevoke = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Révoquer la machine "${machine.name}" ?`)) return;
    setActionLoading(true);
    try {
      await api.revokeMachine(machine.id, "Revoked from machine list");
      onDeleted?.();
    } catch {
      alert("Erreur lors de la révocation");
    } finally {
      setActionLoading(false);
      setMenuOpen(false);
    }
  };

  return (
    <div
      className="rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5 group relative"
      style={{
        background: "var(--nx-bg-surface)",
        border: "1px solid var(--nx-border)",
        boxShadow: isOnline ? "var(--nx-shadow-glow-success)" : "var(--nx-shadow-sm)",
      }}
    >
      {/* Context menu (hors Link pour eviter que les clicks soient captures par la navigation) */}
      {isAdmin && (
        <div className="absolute top-3 right-3 z-20">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            className="p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: "var(--nx-text-weak)" }}
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-8 z-40 rounded-lg py-1 min-w-[160px]"
                style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", boxShadow: "var(--nx-shadow-lg)" }}>
                {isPending && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); navigate(`/machines/${machine.id}/enroll`); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors hover:bg-[var(--nx-bg-hover)]"
                    style={{ color: "var(--nx-info)" }}
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Régénérer l'installation
                  </button>
                )}
                {machine.status !== "REVOKED" && (
                  <button type="button" onClick={handleRevoke} disabled={actionLoading}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors hover:bg-[var(--nx-bg-hover)]"
                    style={{ color: "var(--nx-warning)" }}>
                    <ShieldOff className="w-3.5 h-3.5" /> Révoquer
                  </button>
                )}
                <button type="button" onClick={handleDelete} disabled={actionLoading}
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors hover:bg-[var(--nx-bg-hover)]"
                  style={{ color: "var(--nx-danger)" }}>
                  <Trash2 className="w-3.5 h-3.5" /> Supprimer
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Zone cliquable (Link) — englobe tout sauf le menu */}
      <Link to={`/machines/${machine.id}`} className="absolute inset-0 rounded-xl z-0" aria-label={machine.name} />

      <div className="relative pointer-events-none">

      {/* Header */}
      <div className="flex items-start justify-between mb-3 pr-6">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{ background: "var(--nx-bg-elevated)" }}
          >
            {isProbe ? (
              <Radio className="w-5 h-5" style={{ color: "var(--nx-info)" }} />
            ) : (
              <Server className="w-5 h-5" style={{ color: "var(--nx-text-weak)" }} />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{machine.name}</h3>
              {isProbe && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase"
                  style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}>
                  Probe
                </span>
              )}
              {machine.rebootRequired && (
                <span title="Reboot requis">
                  <AlertTriangle className="w-3.5 h-3.5" style={{ color: "var(--nx-warning)" }} />
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {machine.hostname || machine.ipAddress || "Non configuré"}
            </p>
          </div>
        </div>

        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
          <span className={`w-2 h-2 rounded-full ${status.dot} ${isOnline ? "animate-pulse" : ""}`} />
          {statusLabel(machine.status)}
        </div>
      </div>

      {/* OS */}
      {machine.os && (
        <div className="text-xs text-muted-foreground mb-3">
          {machine.os} {machine.osVersion} {machine.arch ? `(${machine.arch})` : ""}
        </div>
      )}

      {/* Metrics */}
      {latestMetric && isOnline ? (
        <div className="grid grid-cols-3 gap-3">
          <Gauge label="CPU" value={latestMetric.cpuPercent} icon={Cpu} />
          <Gauge label="RAM" value={latestMetric.memoryPercent} icon={MemoryStick} />
          <Gauge label="Disk" value={latestMetric.disks?.[0]?.percent ?? 0} icon={HardDrive} />
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="w-3.5 h-3.5" />
          {machine.lastHeartbeat ? `Dernier signal : ${timeAgo(machine.lastHeartbeat)}` : "Aucun signal reçu"}
        </div>
      )}

      {/* Tags */}
      {machine.tags && machine.tags.length > 0 && (
        <div className="flex gap-1.5 mt-3 flex-wrap">
          {machine.tags.map((mt) => (
            <span
              key={mt.tag.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
              style={{ backgroundColor: `${mt.tag.color}18`, color: mt.tag.color }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: mt.tag.color }} />
              {mt.tag.name}
            </span>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

/** Mini circular gauge for machine cards */
function Gauge({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Cpu }) {
  const pct = Math.min(value, 100);
  const color = pct > 90 ? "var(--nx-danger)" : pct > 70 ? "var(--nx-warning)" : "var(--nx-success)";
  // SVG circle gauge
  const r = 18;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-11 h-11">
        <svg className="w-11 h-11 -rotate-90" viewBox="0 0 44 44">
          <circle cx="22" cy="22" r={r} fill="none" stroke="var(--nx-bg-elevated)" strokeWidth="4" />
          <circle
            cx="22" cy="22" r={r} fill="none"
            stroke={color} strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <Icon className="w-3 h-3" style={{ color: "var(--nx-text-weak)" }} />
        </div>
      </div>
      <div className="text-center">
        <div className="text-xs font-semibold tabular-nums" style={{ color }}>{pct.toFixed(0)}%</div>
        <div className="text-[9px] uppercase" style={{ color: "var(--nx-text-weak)" }}>{label}</div>
      </div>
    </div>
  );
}
