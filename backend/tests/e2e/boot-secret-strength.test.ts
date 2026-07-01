import { describe, it, expect } from "vitest";
import { secretWeakness } from "../../src/services/boot-secrets.js";

// NEXUS-CONTROL-PLANE-005 (extension) — the boot guard must not settle for
// the 32-character threshold: a placeholder copied from the docs
// ("changeme_changeme_changeme_changeme") clears 32 chars but stays guessable.
// These tests exercise the REAL validation logic (secretWeakness, the one called by
// requireStrongSecret / requireStrongSecretIfSet in main()), not a copy.
//
// RED→GREEN: on the old guard (length only), all the "placeholder ≥32" cases
// passed (secretWeakness would have returned null) — the assertions below failed.

describe("CONTROL-PLANE-005 — secretWeakness", () => {
  // --- WEAK values: must return a reason (truthy) ---

  it("rejects an empty / whitespace value (empty after trim)", () => {
    expect(secretWeakness("")).toBeTruthy();
    expect(secretWeakness("        ")).toBeTruthy();
  });

  it("rejects a too-short value (< 32)", () => {
    expect(secretWeakness("short-secret")).toBeTruthy();
    expect(secretWeakness("a".repeat(31))).toBeTruthy();
  });

  it("rejects a known exact placeholder", () => {
    for (const v of ["changeme", "secret", "password", "default", "example"]) {
      expect(secretWeakness(v), `expected weak: ${v}`).toBeTruthy();
    }
  });

  it("rejects a placeholder repeated/padded to reach 32 chars (THE footgun)", () => {
    // ≥ 32 characters, so the old length-only guard let it through.
    expect("changeme_changeme_changeme_changeme".length).toBeGreaterThanOrEqual(32);
    expect(secretWeakness("changeme_changeme_changeme_changeme")).toBeTruthy();
    expect(secretWeakness("CHANGEME-CHANGEME-CHANGEME-CHANGEME")).toBeTruthy(); // case-insensitive
    expect(secretWeakness("password.password.password.password")).toBeTruthy();
  });

  it("rejects a single repeated character (zero entropy)", () => {
    expect(secretWeakness("a".repeat(40))).toBeTruthy();
    expect(secretWeakness("0".repeat(64))).toBeTruthy();
  });

  // --- STRONG values: must return null ---

  it("accepts a strong random secret (openssl rand -hex 32 style)", () => {
    expect(secretWeakness("9f1c4e7a2b8d0f63a5e1c9d47b6028fa3c2e1d0b9a8f7e6d5c4b3a2918007f6e5")).toBeNull();
    expect(secretWeakness("k7Qz2mVx9pLrT4wB6nYc1sHd8jFg3aEu")).toBeNull(); // 32 mixed chars
  });

  it("treats undefined as acceptable (the caller decides if the var is required)", () => {
    expect(secretWeakness(undefined)).toBeNull();
  });

  it("does not clobber a strong secret that happens to contain a substring (non-empty residue)", () => {
    // contains "secret" but keeps entropy around it → non-empty residue → accepted.
    expect(secretWeakness("secret_9f1c4e7a2b8d0f63a5e1c9d47b6028fa")).toBeNull();
  });
});
