import { existsSync, readFileSync } from "node:fs";
import { prisma } from "./database.js";
import { generateBootstrapToken } from "./bootstrap.js";
import { dispatchAction } from "./action-dispatcher.js";
import { getAgentBackendUrl } from "./agent-bootstrap.js";
import {
  getServerBinarySHA256,
  beginUpgrade,
} from "./agent-upgrade-tracker.js";

const AGENT_BINARY_PATH =
  process.env.NEXUS_AGENT_BINARY_PATH || "/app/agent/nexus-agent";

// Signature minisign détachée, produite hors-ligne par l'opérateur et publiée
// par le pipeline de release À CÔTÉ du binaire. Le backend la RELAIE seulement :
// il ne peut pas la forger (la clé privée vit hors du backend). L'agent la
// vérifie contre sa clé publique locale (/etc/nexus/release.pub) avant install.
const AGENT_SIGNATURE_PATH =
  process.env.NEXUS_AGENT_SIGNATURE_PATH || `${AGENT_BINARY_PATH}.minisig`;

export async function dispatchAgentUpgrade(
  machineId: string,
  userId?: string
): Promise<{ success: boolean; requestId?: string; error?: string; currentVersion?: string }> {
  // Verifier que la machine existe et est online
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { id: true, status: true, agentVersion: true },
  });
  if (!machine) return { success: false, error: "Machine not found" };
  if (machine.status !== "ONLINE") {
    return { success: false, error: `Machine is not online (status=${machine.status})` };
  }

  // Verifier que le binaire est disponible cote serveur
  if (!existsSync(AGENT_BINARY_PATH)) {
    return { success: false, error: "Agent binary not available on server" };
  }

  // La signature détachée DOIT être présente : l'agent refusera tout binaire non
  // signé (fail-closed). On échoue tôt ici avec un message clair plutôt que de
  // dispatcher un upgrade que l'agent rejettera.
  if (!existsSync(AGENT_SIGNATURE_PATH)) {
    return {
      success: false,
      error:
        "Agent release signature (.minisig) not available on server — refusing to dispatch an unsigned upgrade",
    };
  }
  const signature = readFileSync(AGENT_SIGNATURE_PATH, "utf8");

  // Construire l'URL de download
  let backendUrl: string;
  try {
    backendUrl = getAgentBackendUrl();
  } catch {
    return { success: false, error: "AGENT_BACKEND_URL not configured" };
  }

  // Generer un token single-use pour l'agent
  const { rawToken } = await generateBootstrapToken(machineId, "install");

  // Calculer le SHA256 du binaire servi (cible) pour verification cote agent
  // ET pour detecter la fin de l'upgrade (reconnexion avec ce SHA).
  const sha256 = await getServerBinarySHA256();

  // Dispatch l'action vers l'agent
  const result = await dispatchAction(
    machineId,
    {
      action_id: "agent.upgrade",
      params: {
        download_url: `${backendUrl}/api/agents/download`,
        token: rawToken,
        sha256: sha256 || undefined,
        signature,
      },
    },
    userId
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Armer le suivi : succes = l'agent se reconnecte en rapportant ce SHA.
  if (sha256) {
    beginUpgrade(machineId, sha256, machine.agentVersion || undefined);
  }

  return {
    success: true,
    requestId: result.requestId,
    currentVersion: machine.agentVersion || "unknown",
  };
}
