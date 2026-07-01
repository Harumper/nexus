import { existsSync, readFileSync } from "node:fs";
import { prisma } from "./database.js";
import { generateBootstrapToken } from "./bootstrap.js";
import { dispatchAction } from "./action-dispatcher.js";
import { getAgentBackendUrl } from "./agent-bootstrap.js";
import {
  getServerBinarySHA256,
  getServerAgentVersion,
  beginUpgrade,
} from "./agent-upgrade-tracker.js";

const AGENT_BINARY_PATH =
  process.env.NEXUS_AGENT_BINARY_PATH || "/app/agent/nexus-agent";

// Detached minisign signature, produced offline by the operator and published
// by the release pipeline ALONGSIDE the binary. The backend only RELAYS it:
// it cannot forge it (the private key lives outside the backend). The agent
// verifies it against its local public key (/etc/nexus/release.pub) before install.
const AGENT_SIGNATURE_PATH =
  process.env.NEXUS_AGENT_SIGNATURE_PATH || `${AGENT_BINARY_PATH}.minisig`;

export async function dispatchAgentUpgrade(
  machineId: string,
  userId?: string
): Promise<{ success: boolean; requestId?: string; error?: string; currentVersion?: string }> {
  // Verify the machine exists and is online
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { id: true, status: true, agentVersion: true },
  });
  if (!machine) return { success: false, error: "Machine not found" };
  if (machine.status !== "ONLINE") {
    return { success: false, error: `Machine is not online (status=${machine.status})` };
  }

  // Verify the binary is available on the server side
  if (!existsSync(AGENT_BINARY_PATH)) {
    return { success: false, error: "Agent binary not available on server" };
  }

  // The detached signature MUST be present: the agent will refuse any unsigned
  // binary (fail-closed). We fail early here with a clear message rather than
  // dispatching an upgrade the agent will reject.
  if (!existsSync(AGENT_SIGNATURE_PATH)) {
    return {
      success: false,
      error:
        "Agent release signature (.minisig) not available on server — refusing to dispatch an unsigned upgrade",
    };
  }
  const signature = readFileSync(AGENT_SIGNATURE_PATH, "utf8");

  // Build the download URL
  let backendUrl: string;
  try {
    backendUrl = getAgentBackendUrl();
  } catch {
    return { success: false, error: "AGENT_BACKEND_URL not configured" };
  }

  // Generate a single-use token for the agent
  const { rawToken } = await generateBootstrapToken(machineId, "install");

  // Compute the SHA256 of the served (target) binary for agent-side verification
  // AND to detect the end of the upgrade (reconnect with this SHA).
  const sha256 = await getServerBinarySHA256();

  // Dispatch the action to the agent
  const result = await dispatchAction(
    machineId,
    {
      action_id: "agent.upgrade",
      params: {
        download_url: `${backendUrl}/api/agents/download`,
        token: rawToken,
        sha256: sha256 || undefined,
        signature,
        // SELF-UPGRADE-002: target version (anti-rollback floor on the agent side).
        target_version: getServerAgentVersion() || undefined,
      },
    },
    userId
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Arm the tracking: success = the agent reconnects reporting this SHA.
  if (sha256) {
    beginUpgrade(machineId, sha256, machine.agentVersion || undefined);
  }

  return {
    success: true,
    requestId: result.requestId,
    currentVersion: machine.agentVersion || "unknown",
  };
}
