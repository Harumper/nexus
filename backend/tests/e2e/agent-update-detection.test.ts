import { describe, it, expect } from "vitest";
import {
  normalizeAgentVersion,
  computeAgentUpdateAvailable,
} from "../../src/services/agent-upgrade-tracker.js";

// "Update available" must be based on equality of served version vs agent version.
// The version is computed (CI) to change ONLY on an agent code change
// (build metadata +agent.<sha>) or a tag → a backend/frontend commit does not
// move it, so no false positive. The comparison here is a plain equality.
describe("normalizeAgentVersion", () => {
  it("simple trim, keeps the +agent.<sha> (carrier of the change info)", () => {
    expect(normalizeAgentVersion("0.0.0-dev+agent.abc1234  ")).toBe(
      "0.0.0-dev+agent.abc1234"
    );
  });
  it("strips a possible -dirty suffix (uncommitted build)", () => {
    expect(normalizeAgentVersion("1.2.0+agent.abc-dirty")).toBe("1.2.0+agent.abc");
  });
});

describe("computeAgentUpdateAvailable — version equality", () => {
  it("NO update if agent versions are identical (backend commit, agent unchanged)", () => {
    const r = computeAgentUpdateAvailable(
      "0.0.0-dev+agent.abc1234", // served
      "shaB",
      "0.0.0-dev+agent.abc1234", // agent
      "shaA"
    );
    expect(r).toBe(false);
  });

  it("update if the agent code changed (different +agent.<sha>)", () => {
    const r = computeAgentUpdateAvailable(
      "0.0.0-dev+agent.def5678",
      "shaB",
      "0.0.0-dev+agent.abc1234",
      "shaA"
    );
    expect(r).toBe(true);
  });

  it("update on new tag", () => {
    expect(
      computeAgentUpdateAvailable("1.3.0+agent.abc", "shaB", "1.2.0+agent.abc", "shaA")
    ).toBe(true);
  });

  it("SHA fallback if the served version is unknown", () => {
    expect(computeAgentUpdateAvailable(null, "shaB", "0.0.0-dev+agent.abc", "shaA")).toBe(true);
    expect(computeAgentUpdateAvailable(null, "shaA", "0.0.0-dev+agent.abc", "shaA")).toBe(false);
  });

  it("SHA fallback if the agent has not reported its version yet", () => {
    expect(computeAgentUpdateAvailable("1.2.0+agent.abc", "shaB", null, "shaA")).toBe(true);
  });
});
