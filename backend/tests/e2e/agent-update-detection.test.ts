import { describe, it, expect } from "vitest";
import {
  normalizeAgentVersion,
  computeAgentUpdateAvailable,
} from "../../src/services/agent-upgrade-tracker.js";

// La détection "MAJ dispo" doit ignorer le tampon de version qui change à chaque
// commit (sha de build), sinon un déploiement backend/frontend signale une MAJ
// sur tous les agents alors que le binaire est fonctionnellement identique.
describe("normalizeAgentVersion", () => {
  it("retire les métadonnées de build semver (+sha)", () => {
    expect(normalizeAgentVersion("0.0.0-dev+203d4a6")).toBe("0.0.0-dev");
    expect(normalizeAgentVersion("0.0.0-dev+60041d8")).toBe("0.0.0-dev");
  });
  it("retire le suffixe git-describe -<n>-g<sha>", () => {
    expect(normalizeAgentVersion("v1.2.3-5-gabcdef")).toBe("v1.2.3");
  });
  it("laisse une version de tag intacte", () => {
    expect(normalizeAgentVersion("v1.2.3")).toBe("v1.2.3");
  });
});

describe("computeAgentUpdateAvailable — comparaison par version", () => {
  it("PAS de MAJ entre deux builds de dev (sha différent, version identique)", () => {
    const r = computeAgentUpdateAvailable(
      "0.0.0-dev+def", // servie
      "shaB",
      "0.0.0-dev+abc", // agent
      "shaA"
    );
    expect(r).toBe(false);
  });

  it("MAJ quand la version change vraiment (tag)", () => {
    const r = computeAgentUpdateAvailable("v1.3.0", "shaB", "v1.2.0", "shaA");
    expect(r).toBe(true);
  });

  it("repli SHA si la version servie est inconnue", () => {
    expect(computeAgentUpdateAvailable(null, "shaB", "0.0.0-dev+abc", "shaA")).toBe(true);
    expect(computeAgentUpdateAvailable(null, "shaA", "0.0.0-dev+abc", "shaA")).toBe(false);
  });

  it("repli SHA si l'agent n'a pas encore reporté sa version", () => {
    expect(computeAgentUpdateAvailable("v1.2.3", "shaB", null, "shaA")).toBe(true);
  });
});
