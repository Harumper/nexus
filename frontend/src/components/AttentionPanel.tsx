import {
  AlertTriangle, Bell, Download, Lock, RefreshCw, ShieldCheck,
  XCircle, Loader2, ChevronRight,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { MachineAttentionData } from "../hooks/useMachineAttention";

interface Props {
  data: MachineAttentionData;
  onTabChange?: (tab: string) => void;
  onShowFailedServices?: () => void;
}

/**
 * Panneau "Attention requise" : agrège les signaux critiques pour une
 * machine en un seul endroit. Reçoit les données déjà chargées via
 * useMachineAttention (factorisé avec le header pour un seul fetch).
 *
 * - Alerts firing / acknowledged
 * - Services systemd failed
 * - Updates pending (security en évidence)
 * - Certs SSL expirant < 30j
 *
 * Quand tout va bien : message rassurant, pas de bruit.
 */
export default function AttentionPanel({ data, onTabChange, onShowFailedServices }: Props) {
  const { alerts, failedServices, updatesCount, securityUpdates, certs, minCertDays, loading, error, reload } = data;
  const expiringCerts = certs.filter((c) => c.days_remaining < 30);
  const totalIssues = alerts.length + failedServices.length + (updatesCount > 0 ? 1 : 0) + expiringCerts.length;

  return (
    <div className="rounded-xl p-5" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: "var(--nx-text-weak)" }}>
          <AlertTriangle className="w-3 h-3" /> Attention requise
        </h3>
        <button
          onClick={reload}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px]"
          style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
          title="Recharger"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </button>
      </div>

      {error && (
        <div className="rounded px-2 py-1.5 text-[11px] mb-2" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          {error}
        </div>
      )}

      {!loading && totalIssues === 0 && !error && (
        <div className="flex items-center gap-2 text-xs py-2" style={{ color: "var(--nx-success)" }}>
          <ShieldCheck className="w-4 h-4" />
          <span>Tout va bien — aucun signal critique.</span>
        </div>
      )}

      <div className="space-y-2">
        {alerts.map((a) => (
          <Row
            key={a.id}
            icon={<Bell className="w-3.5 h-3.5" />}
            color={a.rule.severity === "CRITICAL" ? "var(--nx-danger)" : "var(--nx-warning)"}
            label={a.rule.name}
            detail={
              a.details?.value !== undefined && a.details?.threshold !== undefined
                ? `${a.details.value.toFixed(1)} (seuil ${a.details.threshold})`
                : a.status === "ACKNOWLEDGED" ? "Acquittée" : "Active"
            }
            href="/alerts"
          />
        ))}

        {failedServices.length > 0 && (
          <Row
            icon={<XCircle className="w-3.5 h-3.5" />}
            color="var(--nx-danger)"
            label={`${failedServices.length} service${failedServices.length > 1 ? "s" : ""} en échec`}
            detail={failedServices.slice(0, 3).map((s) => s.unit).filter(Boolean).join(", ")}
            onClick={() => (onShowFailedServices ?? (() => onTabChange?.("services")))()}
          />
        )}

        {updatesCount > 0 && (
          <Row
            icon={<Download className="w-3.5 h-3.5" />}
            color={securityUpdates > 0 ? "var(--nx-warning)" : "var(--nx-info)"}
            label={`${updatesCount} mise${updatesCount > 1 ? "s" : ""} à jour disponible${updatesCount > 1 ? "s" : ""}`}
            detail={securityUpdates > 0 ? `dont ${securityUpdates} de sécurité` : undefined}
            onClick={() => onTabChange?.("updates")}
          />
        )}

        {expiringCerts.map((c, i) => (
          <Row
            key={`cert-${i}`}
            icon={<Lock className="w-3.5 h-3.5" />}
            color={c.days_remaining < 7 ? "var(--nx-danger)" : "var(--nx-warning)"}
            label={c.subject || c.path}
            detail={`Expire dans ${c.days_remaining}j`}
          />
        ))}

        {!loading && expiringCerts.length === 0 && certs.length > 0 && minCertDays !== null && (
          <div className="text-[11px] flex items-center gap-1.5 pt-1" style={{ color: "var(--nx-text-weak)" }}>
            <Lock className="w-3 h-3" />
            <span>{certs.length} cert{certs.length > 1 ? "s" : ""} OK · prochain renouvellement dans {minCertDays}j</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  icon,
  color,
  label,
  detail,
  href,
  onClick,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  detail?: string;
  href?: string;
  onClick?: () => void;
}) {
  const content = (
    <div className="flex items-start gap-2 py-1.5 text-xs" style={{ borderBottom: "1px solid var(--nx-border)" }}>
      <span className="shrink-0 mt-0.5" style={{ color }}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate" style={{ color: "var(--nx-text)" }}>{label}</div>
        {detail && <div className="text-[10px] truncate" style={{ color: "var(--nx-text-weak)" }}>{detail}</div>}
      </div>
      {(href || onClick) && <ChevronRight className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--nx-text-weak)" }} />}
    </div>
  );
  if (href) return <Link to={href} className="block hover:bg-muted/30 rounded px-1 -mx-1">{content}</Link>;
  if (onClick) return <button onClick={onClick} className="block w-full text-left hover:bg-muted/30 rounded px-1 -mx-1">{content}</button>;
  return <div className="px-1 -mx-1">{content}</div>;
}
