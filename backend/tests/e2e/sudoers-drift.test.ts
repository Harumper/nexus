import { describe, it, expect, beforeAll } from "vitest";
import {
  initSudoersVersion,
  getExpectedSudoersHash,
  isSudoersOutdated,
} from "../../src/services/sudoers-version.js";

// Regression guard for the sudoers drift detection that powers the
// "Redeploy required" badge. A quoted heredoc delimiter (<< 'SUDOERS') once
// made the extraction regex never match → the expected hash was always "" →
// isSudoersOutdated() always false → the badge NEVER fired (silent for months,
// since no test asserted the hash was non-empty). These tests fail loudly if
// the regex stops matching the real install-agent.sh again.

describe("sudoers drift detection (install-agent.sh heredoc extraction)", () => {
  beforeAll(() => {
    initSudoersVersion();
  });

  it("extracts a NON-EMPTY sha256 from the real install-agent.sh", () => {
    const h = getExpectedSudoersHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/); // real 64-hex hash, not the "" fallback
  });

  it("flags a mismatching agent hash as outdated", () => {
    expect(isSudoersOutdated("deadbeef")).toBe(true);
  });

  it("does NOT flag an agent that matches the expected hash", () => {
    expect(isSudoersOutdated(getExpectedSudoersHash())).toBe(false);
  });

  it("cannot detect when the agent sent no hash (fail-safe: not outdated)", () => {
    expect(isSudoersOutdated(null)).toBe(false);
    expect(isSudoersOutdated(undefined)).toBe(false);
    expect(isSudoersOutdated("")).toBe(false);
  });
});
