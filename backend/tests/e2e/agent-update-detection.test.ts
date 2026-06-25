import { describe, it, expect } from "vitest";
import {
  normalizeAgentVersion,
  computeAgentUpdateAvailable,
} from "../../src/services/agent-upgrade-tracker.js";

// La "MAJ dispo" doit se baser sur l'égalité de version servie vs agent. La
// version est calculée (CI) pour ne changer QUE sur un changement de code agent
// (build metadata +agent.<sha>) ou un tag → un commit backend/frontend ne la
// bouge pas, donc aucun faux positif. La comparaison ici est une simple égalité.
describe("normalizeAgentVersion", () => {
  it("trim simple, conserve le +agent.<sha> (porteur de l'info de changement)", () => {
    expect(normalizeAgentVersion("0.0.0-dev+agent.abc1234  ")).toBe(
      "0.0.0-dev+agent.abc1234"
    );
  });
  it("retire un éventuel suffixe -dirty (build non commité)", () => {
    expect(normalizeAgentVersion("1.2.0+agent.abc-dirty")).toBe("1.2.0+agent.abc");
  });
});

describe("computeAgentUpdateAvailable — égalité de version", () => {
  it("PAS de MAJ si versions agent identiques (commit backend, agent inchangé)", () => {
    const r = computeAgentUpdateAvailable(
      "0.0.0-dev+agent.abc1234", // servie
      "shaB",
      "0.0.0-dev+agent.abc1234", // agent
      "shaA"
    );
    expect(r).toBe(false);
  });

  it("MAJ si le code agent a changé (+agent.<sha> différent)", () => {
    const r = computeAgentUpdateAvailable(
      "0.0.0-dev+agent.def5678",
      "shaB",
      "0.0.0-dev+agent.abc1234",
      "shaA"
    );
    expect(r).toBe(true);
  });

  it("MAJ sur nouveau tag", () => {
    expect(
      computeAgentUpdateAvailable("1.3.0+agent.abc", "shaB", "1.2.0+agent.abc", "shaA")
    ).toBe(true);
  });

  it("repli SHA si la version servie est inconnue", () => {
    expect(computeAgentUpdateAvailable(null, "shaB", "0.0.0-dev+agent.abc", "shaA")).toBe(true);
    expect(computeAgentUpdateAvailable(null, "shaA", "0.0.0-dev+agent.abc", "shaA")).toBe(false);
  });

  it("repli SHA si l'agent n'a pas encore reporté sa version", () => {
    expect(computeAgentUpdateAvailable("1.2.0+agent.abc", "shaB", null, "shaA")).toBe(true);
  });
});
