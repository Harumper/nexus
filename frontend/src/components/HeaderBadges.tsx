import { Bell, XCircle, Download, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MachineAttentionData } from "../hooks/useMachineAttention";

interface Props {
  data: MachineAttentionData;
  onTabChange?: (tab: string) => void;
  onShowFailedServices?: () => void;
}

/**
 * Petits badges affichés sous le nom de la machine dans le header.
 * Visible en permanence — montre l'état critique au glance avant que
 * l'utilisateur n'ait besoin de scroller vers AttentionPanel.
 *
 * "The bad news at the top" — pattern Datadog/Cockpit.
 */
export default function HeaderBadges({ data, onTabChange, onShowFailedServices }: Props) {
  const { t } = useTranslation();
  const { updatesCount, securityUpdates } = data;
  // Garde-fou null : un agent injoignable peut remonter null au lieu de [].
  const alerts = data.alerts ?? [];
  const failedServices = data.failedServices ?? [];
  const certs = data.certs ?? [];
  const expiringCerts = certs.filter((c) => c.days_remaining < 30);
  const minDays = expiringCerts.length > 0
    ? Math.min(...expiringCerts.map((c) => c.days_remaining))
    : null;

  // Si rien de critique, on ne rend rien (le header reste propre)
  if (alerts.length === 0 && failedServices.length === 0 && updatesCount === 0 && expiringCerts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      {alerts.length > 0 && (
        <Badge
          icon={<Bell className="w-3 h-3" />}
          color="var(--nx-danger)"
          bg="var(--nx-danger-subtle)"
          href="/alerts"
        >
          {t("badges.alerts", { count: alerts.length })}
        </Badge>
      )}
      {failedServices.length > 0 && (
        <Badge
          icon={<XCircle className="w-3 h-3" />}
          color="var(--nx-danger)"
          bg="var(--nx-danger-subtle)"
          onClick={() => (onShowFailedServices ?? (() => onTabChange?.("services")))()}
        >
          {t("badges.failedServices", { count: failedServices.length })}
        </Badge>
      )}
      {updatesCount > 0 && (
        <Badge
          icon={<Download className="w-3 h-3" />}
          color={securityUpdates > 0 ? "var(--nx-warning)" : "var(--nx-info)"}
          bg={securityUpdates > 0 ? "var(--nx-warning-subtle)" : "var(--nx-info-subtle)"}
          onClick={() => onTabChange?.("updates")}
        >
          {t("badges.updates", { count: updatesCount })}
          {securityUpdates > 0 && t("badges.securitySuffix", { count: securityUpdates })}
        </Badge>
      )}
      {expiringCerts.length > 0 && minDays !== null && (
        <Badge
          icon={<Lock className="w-3 h-3" />}
          color={minDays < 7 ? "var(--nx-danger)" : "var(--nx-warning)"}
          bg={minDays < 7 ? "var(--nx-danger-subtle)" : "var(--nx-warning-subtle)"}
        >
          {t("badges.certExpiring", { days: minDays })}
        </Badge>
      )}
    </div>
  );
}

function Badge({
  icon,
  color,
  bg,
  href,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  color: string;
  bg: string;
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const className = "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold transition-opacity hover:opacity-80";
  const style = { background: bg, color };

  if (href) {
    return (
      <a href={href} className={className} style={style} onClick={(e) => { e.preventDefault(); window.location.href = href; }}>
        {icon}
        {children}
      </a>
    );
  }
  if (onClick) {
    return <button onClick={onClick} className={className} style={style}>{icon}{children}</button>;
  }
  return <span className={className} style={style}>{icon}{children}</span>;
}
