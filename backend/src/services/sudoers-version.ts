import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Path to scripts/install-agent.sh.
// In dev: cwd = backend/, the repo root is at ../
// In prod (Docker): the repo is bind-mounted into /app
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
 * Extracts the sudoers block from install-agent.sh (between `cat > "$SUDOERS_TEMP"
 * << SUDOERS` and the closing `SUDOERS` line) and returns its SHA256.
 *
 * This hash is compared with the one sent by the agent in its heartbeat to
 * detect when the agent must be reinstalled (new sudoers rules added to the
 * script since the initial install).
 */
function computeExpectedSudoersHash(): string {
  const path = findInstallScript();
  if (!path) {
    console.warn("[Sudoers] install-agent.sh not found, drift detection disabled");
    return "";
  }

  const content = readFileSync(path, "utf-8");

  // Look for the heredoc: cat > "$SUDOERS_TEMP" << 'SUDOERS' ... SUDOERS
  // The opening delimiter is QUOTED (<< 'SUDOERS') on purpose — it disables $/`
  // expansion inside a sudoers file — so the quote is optional in the regex.
  // (Before this was fixed, the regex required an unquoted delimiter, never
  // matched, and drift detection was silently disabled: the "Redeploy required"
  // badge never fired.)
  const match = content.match(/cat\s*>\s*"\$SUDOERS_TEMP"\s*<<\s*'?SUDOERS'?\s*\n([\s\S]*?)\nSUDOERS\b/);
  if (!match) {
    console.warn("[Sudoers] SUDOERS heredoc not found in install-agent.sh");
    return "";
  }

  const sudoersContent = match[1];

  // The agent computes the hash over what `cat /etc/sudoers.d/nexus-agent`
  // returns, i.e. the content of the installed file (with a trailing newline if
  // the heredoc has one). We append "\n" to match.
  const normalized = sudoersContent + "\n";

  return createHash("sha256").update(normalized).digest("hex");
}

let cachedHash = "";

/**
 * Computes the hash at backend startup and caches it.
 * If install-agent.sh is modified (new deployment with new rules), a backend
 * restart will update the reference hash.
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
 * Compares the hash received from the agent with the reference. Returns true if
 * they differ (= outdated sudoers, agent to reinstall).
 *
 * If the reference hash is empty (script not found) or the agent did not send a
 * hash, returns false (no detection possible).
 */
export function isSudoersOutdated(agentHash: string | null | undefined): boolean {
  if (!cachedHash || !agentHash) return false;
  return agentHash !== cachedHash;
}
