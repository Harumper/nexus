import { prisma } from "./database.js";
import { evaluateHardeningAlerts } from "./alert-engine.js";

// Raw data returned by the security.audit agent action.
export interface AuditData {
  hardening_index?: number;
  warning_count?: number;
  suggestion_count?: number;
  lynis_version?: string;
  fail2ban_active?: boolean;
  auto_updates_active?: boolean;
  ssh_hardened?: boolean;
  firewall_active?: boolean;
  [k: string]: unknown;
}

// Persists a history point (summary) from an audit result, then (re)evaluates
// the posture alerts for the machine. Called when the agent returns its
// security.audit response (asynchronous dispatch).
export async function recordSecurityScan(machineId: string, data: AuditData): Promise<void> {
  await prisma.securityScan.create({
    data: {
      machineId,
      hardeningIndex: typeof data.hardening_index === "number" ? data.hardening_index : -1,
      warningCount: Number(data.warning_count) || 0,
      suggestionCount: Number(data.suggestion_count) || 0,
      lynisVersion: data.lynis_version || null,
      fail2banActive: !!data.fail2ban_active,
      autoUpdatesActive: !!data.auto_updates_active,
      sshHardened: !!data.ssh_hardened,
      firewallActive: !!data.firewall_active,
    },
  });

  // The score just measured may cross an alert threshold.
  await evaluateHardeningAlerts(machineId);
}
