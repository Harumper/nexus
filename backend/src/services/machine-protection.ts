// Additional protections for critical machines (Machine.isCritical flag).
// Blocks actions that could make the machine inaccessible.

// Services whose stop would break Nexus or critical production.
const CRITICAL_SERVICES = new Set([
  "docker",
  "docker.service",
  "containerd",
  "containerd.service",
  "nginx",
  "nginx.service",
  "traefik",
  "traefik.service",
  "postgresql",
  "postgresql.service",
  "ssh",
  "sshd",
  "ssh.service",
  "sshd.service",
  "keycloak",
  "keycloak.service",
]);

// Packages whose removal would break the machine or Nexus.
const CRITICAL_PACKAGES = new Set([
  "docker-ce",
  "docker-ce-cli",
  "docker.io",
  "containerd.io",
  "containerd",
  "nginx",
  "nginx-full",
  "nginx-core",
  "postgresql",
  "postgresql-client",
  "openssh-server",
  "openssh-client",
  "systemd",
  "sudo",
  "apt",
]);

// Actions always blocked on a critical machine.
const ALWAYS_BLOCKED = new Set([
  "system.reboot",
]);

export interface ProtectionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Checks whether an action can be executed on a critical machine.
 * If the machine is not critical, all actions are allowed.
 */
export function checkCriticalProtection(
  isCritical: boolean,
  actionId: string,
  params?: Record<string, unknown>
): ProtectionCheckResult {
  if (!isCritical) return { allowed: true };

  if (ALWAYS_BLOCKED.has(actionId)) {
    return {
      allowed: false,
      reason: `Action '${actionId}' is blocked on critical machines. Toggle isCritical=false if really needed.`,
    };
  }

  // service_stop / service_restart on a critical service
  if (actionId === "system.service_stop" || actionId === "system.service_restart") {
    const service = typeof params?.service === "string" ? params.service : "";
    const normalized = service.replace(/\.service$/, "");
    if (CRITICAL_SERVICES.has(service) || CRITICAL_SERVICES.has(normalized) || CRITICAL_SERVICES.has(normalized + ".service")) {
      return {
        allowed: false,
        reason: `Service '${service}' is critical on this machine. Use a non-critical machine or toggle isCritical=false.`,
      };
    }
  }

  // package.remove on a critical package
  if (actionId === "package.remove") {
    const name = typeof params?.name === "string" ? params.name : "";
    if (CRITICAL_PACKAGES.has(name)) {
      return {
        allowed: false,
        reason: `Package '${name}' is critical on this machine. Cannot be removed while isCritical=true.`,
      };
    }
  }

  return { allowed: true };
}
