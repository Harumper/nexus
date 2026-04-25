import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Chemin vers scripts/install-agent.sh.
// En dev : cwd = backend/, le repo root est a ../
// En prod (Docker) : on bind-mount le repo dans /app
function findInstallScript(): string | null {
  const candidates = [
    resolve(process.cwd(), "../scripts/install-agent.sh"),
    resolve(process.cwd(), "scripts/install-agent.sh"),
    "/app/scripts/install-agent.sh",
  ];
  for (const p of candidates) {
    try {
      readFileSync(p, "utf-8");
      return p;
    } catch {}
  }
  return null;
}

/**
 * Extrait le bloc sudoers de install-agent.sh (entre `cat > "$SUDOERS_TEMP"
 * << SUDOERS` et la ligne `SUDOERS` de fin) et retourne son SHA256.
 *
 * Ce hash est compare avec celui envoye par l'agent dans son heartbeat
 * pour detecter quand l'agent doit etre reinstalle (nouvelles regles
 * sudoers ajoutees au script depuis l'install initial).
 */
function computeExpectedSudoersHash(): string {
  const path = findInstallScript();
  if (!path) {
    console.warn("[Sudoers] install-agent.sh introuvable, drift detection desactivee");
    return "";
  }

  const content = readFileSync(path, "utf-8");

  // Cherche le heredoc : cat > "$SUDOERS_TEMP" << SUDOERS ... SUDOERS
  const match = content.match(/cat\s*>\s*"\$SUDOERS_TEMP"\s*<<\s*SUDOERS\s*\n([\s\S]*?)\nSUDOERS\b/);
  if (!match) {
    console.warn("[Sudoers] heredoc SUDOERS introuvable dans install-agent.sh");
    return "";
  }

  const sudoersContent = match[1];

  // L'agent calcule le hash sur ce que `cat /etc/sudoers.d/nexus-agent`
  // retourne, c'est-a-dire le contenu du fichier installe (avec un trailing
  // newline si le heredoc en a un). On ajoute "\n" pour matcher.
  const normalized = sudoersContent + "\n";

  return createHash("sha256").update(normalized).digest("hex");
}

let cachedHash = "";

/**
 * Calcule le hash au demarrage du backend et le cache.
 * Si install-agent.sh est modifie (nouveau deploiement avec nouvelles regles),
 * un restart du backend mettra a jour le hash de reference.
 */
export function initSudoersVersion(): void {
  cachedHash = computeExpectedSudoersHash();
  if (cachedHash) {
    console.log(`[Sudoers] Expected hash: ${cachedHash.slice(0, 16)}...`);
  }
}

export function getExpectedSudoersHash(): string {
  return cachedHash;
}

/**
 * Compare le hash recu de l'agent avec la reference. Retourne true si
 * differents (= sudoers obsoletes, agent a reinstaller).
 *
 * Si le hash de reference est vide (script introuvable) ou si l'agent
 * n'a pas envoye de hash, retourne false (pas de detection possible).
 */
export function isSudoersOutdated(agentHash: string | null | undefined): boolean {
  if (!cachedHash || !agentHash) return false;
  return agentHash !== cachedHash;
}
