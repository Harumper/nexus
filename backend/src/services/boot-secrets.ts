// CONTROL-PLANE-005 — boot-time validation of signing/auth secrets.
//
// Presence is not enough: a short/weak JWT_SECRET or ECDSA_MASTER_SECRET is
// brute-forceable offline, letting an attacker forge arbitrary tokens (incl.
// role:"ADMIN"). Length alone is not enough EITHER: a placeholder copied from the
// docs (e.g. "changeme_changeme_changeme_changeme") clears 32 chars yet is guessable
// a priori. We reject known placeholders / trivially-low-entropy values so a
// "long enough" default fails LOUDLY at boot instead of shipping silently — same
// principle as the mandatory-wss:// guard: a default that breaks security in silence
// is worse than a noisy failure.
//
// Lives in its own module (not index.ts) so it can be unit-tested without triggering
// the server boot side effect (index.ts calls main() at import time).

const MIN_SECRET_LEN = 32;

// Normalized (lowercase, alphanumerics only) placeholder tokens. A secret made up
// solely of these — even repeated/padded with punctuation to reach 32 chars — is rejected.
const WEAK_SECRET_TOKENS = [
  "changeme",
  "changethis",
  "secret",
  "password",
  "passwd",
  "default",
  "example",
  "placeholder",
  "yoursecret",
  "yoursecrethere",
  "nexussecret",
];

// Returns a human-readable weakness reason, or null if the value is acceptable.
// `undefined` → null (the caller decides whether the var is required).
export function secretWeakness(val: string | undefined): string | null {
  if (val === undefined) return null;
  const trimmed = val.trim();
  if (trimmed.length === 0) return "empty or whitespace-only";
  if (trimmed.length < MIN_SECRET_LEN) return `too short (${trimmed.length} chars, minimum ${MIN_SECRET_LEN})`;
  const norm = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm.length > 0 && /^(.)\1+$/.test(norm)) return "single repeated character (no entropy)";
  if (WEAK_SECRET_TOKENS.includes(norm)) return "a known placeholder value";
  // Strip every placeholder token; if nothing of substance remains, the secret was
  // built only from placeholders ("changeme_changeme_..." → "").
  let residue = norm;
  for (const t of WEAK_SECRET_TOKENS) residue = residue.split(t).join("");
  if (residue.length === 0) return "composed only of placeholder words";
  return null;
}

// Required secret (JWT_SECRET / ECDSA_MASTER_SECRET): must be present AND strong.
export function requireStrongSecret(key: string): void {
  if (process.env[key] === undefined) {
    throw new Error(`${key} environment variable is required. Set it before starting the server.`);
  }
  const weakness = secretWeakness(process.env[key]);
  if (weakness) {
    throw new Error(
      `${key} is weak: ${weakness}. Generate a strong one with e.g. \`openssl rand -hex 32\`.`,
    );
  }
}

// Optional secret (METRICS_TOKEN): absence is valid (falls back to network-scoping),
// but if it IS set it must not be a weak/placeholder value.
export function requireStrongSecretIfSet(key: string): void {
  if (process.env[key] === undefined) return;
  const weakness = secretWeakness(process.env[key]);
  if (weakness) {
    throw new Error(
      `${key} is set but weak: ${weakness}. Unset it (to rely on network-scoping) or use \`openssl rand -hex 32\`.`,
    );
  }
}
