import { useTranslation } from "react-i18next";

// One consolidated "agent maintenance" badge — a single box that surfaces both
// the binary-update state and the sudoers-drift (redeploy) state, instead of two
// separate floating badges. Redeploy takes precedence: re-running
// install-agent.sh refreshes the binary AND the sudoers, so when sudoers drifted
// the box is amber and the action is a redeploy (a plain auto-upgrade would not
// be enough). Renders nothing when the agent needs no maintenance.
export default function AgentMaintenanceBadge({
  sudoersOutdated,
  updateAvailable,
  size = "md",
}: {
  sudoersOutdated?: boolean;
  updateAvailable?: boolean;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation("common");
  if (!sudoersOutdated && !updateAvailable) return null;

  const both = !!sudoersOutdated && !!updateAvailable;
  const amber = !!sudoersOutdated; // redeploy drives the styling (it covers the update too)
  const short = size === "sm";

  const label = both
    ? t(short ? "agentMaint.bothShort" : "agentMaint.both")
    : sudoersOutdated
      ? t(short ? "agentMaint.redeployShort" : "agentMaint.redeploy")
      : t(short ? "agentMaint.updateShort" : "agentMaint.update");

  const title = both
    ? t("agentMaint.bothTitle")
    : sudoersOutdated
      ? t("agentMaint.redeployTitle")
      : t("agentMaint.updateTitle");

  return (
    <span
      className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase inline-flex items-center gap-1 ${
        amber ? "bg-warning-subtle text-warning" : "bg-info-subtle text-info"
      }`}
      title={title}
    >
      {label}
    </span>
  );
}
