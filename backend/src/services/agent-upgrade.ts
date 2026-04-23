import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "./database.js";
import { generateBootstrapToken } from "./bootstrap.js";
import { dispatchAction } from "./action-dispatcher.js";
import { getAgentBackendUrl } from "./agent-bootstrap.js";

const AGENT_BINARY_PATH =
  process.env.NEXUS_AGENT_BINARY_PATH || "/app/agent/nexus-agent";

// Cache du SHA256 du binaire (calcule une seule fois au demarrage)
let binarySHA256: string | null = null;

function computeSHA256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => res(hash.digest("hex")))
      .on("error", rej);
  });
}

async function getBinarySHA256(): Promise<string | null> {
  if (binarySHA256) return binarySHA256;
  if (!existsSync(AGENT_BINARY_PATH)) return null;
  try {
    binarySHA256 = await computeSHA256(AGENT_BINARY_PATH);
    return binarySHA256;
  } catch {
    return null;
  }
}

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

  // Construire l'URL de download
  let backendUrl: string;
  try {
    backendUrl = getAgentBackendUrl();
  } catch {
    return { success: false, error: "AGENT_BACKEND_URL not configured" };
  }

  // Generer un token single-use pour l'agent
  const { rawToken } = await generateBootstrapToken(machineId, "install");

  // Calculer le SHA256 pour verification cote agent
  const sha256 = await getBinarySHA256();

  // Dispatch l'action vers l'agent
  const result = await dispatchAction(
    machineId,
    {
      action_id: "agent.upgrade",
      params: {
        download_url: `${backendUrl}/api/agents/download`,
        token: rawToken,
        sha256: sha256 || undefined,
      },
    },
    userId
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    requestId: result.requestId,
    currentVersion: machine.agentVersion || "unknown",
  };
}
