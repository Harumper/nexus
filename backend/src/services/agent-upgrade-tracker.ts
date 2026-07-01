import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { broadcastToDashboard } from "../websocket/dashboard.js";

// In-memory tracking of agent self-upgrades. No persistence: an upgrade
// is a short operation (download → install → restart → reconnect); if the
// backend restarts during it, the agent will eventually reconnect and the
// heartbeat will refresh the "up to date" state anyway.

const AGENT_BINARY_PATH =
  process.env.NEXUS_AGENT_BINARY_PATH || "/app/agent/nexus-agent";

// Max window for an agent to reconnect with the new binary before declaring
// the upgrade failed (download + systemd restart + 1st heartbeat).
const UPGRADE_TIMEOUT_MS = parseInt(
  process.env.AGENT_UPGRADE_TIMEOUT_MS || "180000",
  10
);

// SHA256 of the binary served by the backend (the "target"). Cached BUT
// invalidated if the file changes (mtime/size): otherwise a binary replaced
// in place (deployment without a process restart) left a stale target SHA
// → permanent "update available" while the agent already has the right binary.
let serverBinarySha: string | null = null;
let serverBinaryKey = ""; // mtime+size signature of the hashed file

function computeSHA256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => res(hash.digest("hex")))
      .on("error", rej);
  });
}

export async function getServerBinarySHA256(): Promise<string | null> {
  if (!existsSync(AGENT_BINARY_PATH)) return null;
  try {
    const st = statSync(AGENT_BINARY_PATH);
    const key = `${st.mtimeMs}:${st.size}`;
    if (serverBinarySha && key === serverBinaryKey) return serverBinarySha;
    serverBinarySha = await computeSHA256(AGENT_BINARY_PATH);
    serverBinaryKey = key;
    return serverBinarySha;
  } catch {
    return null;
  }
}

// Mechanism A (auto-upgrade via release volume): the served version is a
// RELEASE CONTENT, published in the volume alongside the binary and its signature
// (VERSION file, NEXUS_AGENT_VERSION_PATH path). Read on every call → a new
// release is taken into account without restarting the backend, and the
// publication CI only needs to write to the release folder (no docker,
// no .env edit). Falls back to the AGENT_VERSION env (dev/local).
const AGENT_VERSION_PATH = process.env.NEXUS_AGENT_VERSION_PATH || "";
export function getServerAgentVersion(): string | null {
  if (AGENT_VERSION_PATH) {
    try {
      const v = readFileSync(AGENT_VERSION_PATH, "utf8").trim();
      if (v) return v;
    } catch {
      // file missing/unreadable = no release published → fall back to the env
    }
  }
  return process.env.AGENT_VERSION || null;
}

// Normalizes a version for the "update available" comparison: simple trim (+
// removal of any "-dirty" suffix from an uncommitted build). We do NOT remove the
// "+agent.<sha>" build metadata: it's precisely what carries the
// "the agent code changed" information (see the CI version job).
export function normalizeAgentVersion(v: string): string {
  return v.trim().replace(/-dirty$/i, "");
}

// Core of the "update available" decision, purely synchronous: the routes
// precompute servedVersion (sync) and targetSha (cache) once, then call it per
// machine in a .map with no I/O. DIRECT comparison of the version served by the
// backend vs the one reported by the agent: different → update available, same →
// up to date. Since the version is computed to move only on an agent change (or a
// tag), a backend/frontend commit triggers no false positive. Falls back to the
// SHA if a version is unknown (old deployment / agent not yet reported).
export function computeAgentUpdateAvailable(
  servedVersion: string | null,
  targetSha: string | null,
  agentVersion?: string | null,
  agentSha256?: string | null
): boolean {
  if (servedVersion && agentVersion) {
    return (
      normalizeAgentVersion(servedVersion) !== normalizeAgentVersion(agentVersion)
    );
  }
  return !!agentSha256 && !!targetSha && agentSha256 !== targetSha;
}

// Convenient async variant for a one-off call (fetches the served version and
// the target SHA itself).
export async function isAgentUpdateAvailable(
  agentVersion?: string | null,
  agentSha256?: string | null
): Promise<boolean> {
  return computeAgentUpdateAvailable(
    getServerAgentVersion(),
    await getServerBinarySHA256(),
    agentVersion,
    agentSha256
  );
}

// Last SHA reported by each agent via heartbeat (for "update available?").
const latestAgentSha = new Map<string, string>();

export function getLatestAgentSha(machineId: string): string | undefined {
  return latestAgentSha.get(machineId);
}

interface PendingUpgrade {
  targetSha: string;
  startedAt: number;
  previousVersion?: string;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingUpgrade>();

export function isUpgradePending(machineId: string): boolean {
  return pending.has(machineId);
}

function clearPending(machineId: string): void {
  const p = pending.get(machineId);
  if (p) clearTimeout(p.timer);
  pending.delete(machineId);
}

/**
 * Marks a machine as "upgrade in progress" toward the server's current binary.
 * Arms a timeout: if the agent doesn't reconnect with the right SHA within the
 * window, we broadcast a failure (timeout).
 */
export function beginUpgrade(
  machineId: string,
  targetSha: string,
  previousVersion?: string
): void {
  clearPending(machineId);
  const timer = setTimeout(() => {
    pending.delete(machineId);
    broadcastToDashboard({
      type: "agent.upgrade.result",
      machine_id: machineId,
      data: {
        success: false,
        reason: "timeout",
        message:
          "The agent did not reconnect with the new version within the allotted time.",
      },
    });
  }, UPGRADE_TIMEOUT_MS);
  // Prevents the timer from blocking a clean shutdown of the Node process.
  if (typeof timer.unref === "function") timer.unref();

  pending.set(machineId, {
    targetSha,
    startedAt: Date.now(),
    previousVersion,
    timer,
  });
}

/**
 * Called on every heartbeat. Memorizes the agent's current SHA and, if an
 * upgrade is in progress and the agent now runs the target binary, broadcasts
 * the success.
 */
export function onAgentHeartbeat(
  machineId: string,
  sha: string | undefined,
  version: string | undefined
): void {
  if (sha) latestAgentSha.set(machineId, sha);

  const p = pending.get(machineId);
  if (!p || !sha) return;

  if (sha === p.targetSha) {
    const durationMs = Date.now() - p.startedAt;
    clearPending(machineId);
    broadcastToDashboard({
      type: "agent.upgrade.result",
      machine_id: machineId,
      data: {
        success: true,
        version: version || null,
        sha256: sha,
        previousVersion: p.previousVersion || null,
        durationMs,
      },
    });
  }
  // Otherwise: the agent reconnected but not (yet) on the target binary
  // — either the restart hasn't happened yet, or the old binary came
  // back (failure). We let the timeout decide.
}
