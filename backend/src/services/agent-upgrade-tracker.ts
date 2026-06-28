import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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

// SHA256 du binaire servi par le backend (la "cible"). Mis en cache MAIS
// invalidé si le fichier change (mtime/taille) : sinon un binaire remplacé
// en place (déploiement sans redémarrage du process) laissait un SHA cible
// périmé → "MAJ dispo" permanent alors que l'agent a déjà le bon binaire.
let serverBinarySha: string | null = null;
let serverBinaryKey = ""; // signature mtime+taille du fichier hashé

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

// Mécanisme A (auto-upgrade par volume de release) : la version servie est un
// CONTENU DE RELEASE, publié dans le volume à côté du binaire et de sa signature
// (fichier VERSION, chemin NEXUS_AGENT_VERSION_PATH). Lue à chaque appel → une
// nouvelle release est prise en compte sans redémarrer le backend, et la CI de
// publication n'a besoin que d'écrire dans le dossier de release (aucun docker,
// aucune édition de .env). Fallback sur l'env AGENT_VERSION (dev/local).
const AGENT_VERSION_PATH = process.env.NEXUS_AGENT_VERSION_PATH || "";
export function getServerAgentVersion(): string | null {
  if (AGENT_VERSION_PATH) {
    try {
      const v = readFileSync(AGENT_VERSION_PATH, "utf8").trim();
      if (v) return v;
    } catch {
      // fichier absent/illisible = aucune release publiée → on tombe sur l'env
    }
  }
  return process.env.AGENT_VERSION || null;
}

// Normalise une version pour la comparaison "MAJ dispo" : simple trim (+ retrait
// d'un éventuel suffixe "-dirty" d'un build non commité). On NE retire PAS les
// métadonnées de build "+agent.<sha>" : c'est justement elles qui portent
// l'information "le code de l'agent a changé" (voir job version de la CI).
export function normalizeAgentVersion(v: string): string {
  return v.trim().replace(/-dirty$/i, "");
}

// Cœur de la décision "MAJ dispo", purement synchrone : les routes pré-calculent
// servedVersion (sync) et targetSha (cache) une fois, puis l'appellent par machine
// dans un .map sans I/O. Comparaison DIRECTE de la version servie par le backend
// vs celle reportée par l'agent : différentes → MAJ dispo, identiques → à jour.
// La version étant calculée pour ne bouger que sur un changement agent (ou un
// tag), un commit backend/frontend ne déclenche aucun faux positif. Repli sur le
// SHA si une version est inconnue (vieux déploiement / agent pas encore reporté).
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

// Variante asynchrone pratique pour un appel unitaire (récupère elle-même la
// version servie et le SHA cible).
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
