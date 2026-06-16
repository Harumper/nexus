import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { broadcastToDashboard } from "../websocket/dashboard.js";

// Suivi en mémoire des self-upgrades d'agent. Pas de persistance : un upgrade
// est une opération courte (download → install → restart → reconnect) ; si le
// backend redémarre pendant, l'agent finira par se reconnecter et le heartbeat
// rafraîchira l'état "à jour" de toute façon.

const AGENT_BINARY_PATH =
  process.env.NEXUS_AGENT_BINARY_PATH || "/app/agent/nexus-agent";

// Fenêtre max pour qu'un agent se reconnecte avec le nouveau binaire avant de
// déclarer l'upgrade en échec (download + restart systemd + 1er heartbeat).
const UPGRADE_TIMEOUT_MS = parseInt(
  process.env.AGENT_UPGRADE_TIMEOUT_MS || "180000",
  10
);

// SHA256 du binaire servi par le backend (la "cible"). Calculé une fois.
let serverBinarySha: string | null = null;

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
  if (serverBinarySha) return serverBinarySha;
  if (!existsSync(AGENT_BINARY_PATH)) return null;
  try {
    serverBinarySha = await computeSHA256(AGENT_BINARY_PATH);
    return serverBinarySha;
  } catch {
    return null;
  }
}

// Dernier SHA rapporté par chaque agent via heartbeat (pour "MAJ dispo ?").
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
 * Marque une machine comme "en cours d'upgrade" vers le binaire courant du
 * serveur. Arme un timeout : si l'agent ne se reconnecte pas avec le bon SHA
 * dans la fenêtre, on diffuse un échec (timeout).
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
          "L'agent ne s'est pas reconnecté avec la nouvelle version dans le délai imparti.",
      },
    });
  }, UPGRADE_TIMEOUT_MS);
  // Évite que le timer empêche un arrêt propre du process Node.
  if (typeof timer.unref === "function") timer.unref();

  pending.set(machineId, {
    targetSha,
    startedAt: Date.now(),
    previousVersion,
    timer,
  });
}

/**
 * Appelé à chaque heartbeat. Mémorise le SHA courant de l'agent et, si un
 * upgrade est en cours et que l'agent tourne désormais le binaire cible,
 * diffuse le succès.
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
  // Sinon : l'agent s'est reconnecté mais pas (encore) sur le binaire cible
  // — soit le restart n'a pas encore eu lieu, soit l'ancien binaire est
  // revenu (échec). On laisse le timeout trancher.
}
