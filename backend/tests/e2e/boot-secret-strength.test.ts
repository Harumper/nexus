import { describe, it, expect } from "vitest";
import { secretWeakness } from "../../src/services/boot-secrets.js";

// NEXUS-CONTROL-PLANE-005 (extension) — la garde de boot ne doit pas se contenter
// du seuil de 32 caractères : un placeholder copié de la doc
// ("changeme_changeme_changeme_changeme") franchit 32 car. mais reste deviné d'avance.
// Ces tests exercent la VRAIE logique de validation (secretWeakness, celle qu'appellent
// requireStrongSecret / requireStrongSecretIfSet dans main()), pas une copie.
//
// RED→GREEN : sur l'ancienne garde (longueur seule), tous les cas "placeholder ≥32"
// passaient (secretWeakness aurait renvoyé null) — les assertions ci-dessous échouaient.

describe("CONTROL-PLANE-005 — secretWeakness", () => {
  // --- valeurs FAIBLES : doivent renvoyer une raison (truthy) ---

  it("rejette une valeur vide / espaces (vide après trim)", () => {
    expect(secretWeakness("")).toBeTruthy();
    expect(secretWeakness("        ")).toBeTruthy();
  });

  it("rejette une valeur trop courte (< 32)", () => {
    expect(secretWeakness("short-secret")).toBeTruthy();
    expect(secretWeakness("a".repeat(31))).toBeTruthy();
  });

  it("rejette un placeholder exact connu", () => {
    for (const v of ["changeme", "secret", "password", "default", "example"]) {
      expect(secretWeakness(v), `attendu faible: ${v}`).toBeTruthy();
    }
  });

  it("rejette un placeholder répété/paddé pour atteindre 32 car. (LE footgun)", () => {
    // ≥ 32 caractères, donc l'ancienne garde longueur-seule laissait passer.
    expect("changeme_changeme_changeme_changeme".length).toBeGreaterThanOrEqual(32);
    expect(secretWeakness("changeme_changeme_changeme_changeme")).toBeTruthy();
    expect(secretWeakness("CHANGEME-CHANGEME-CHANGEME-CHANGEME")).toBeTruthy(); // casse insensible
    expect(secretWeakness("password.password.password.password")).toBeTruthy();
  });

  it("rejette un seul caractère répété (entropie nulle)", () => {
    expect(secretWeakness("a".repeat(40))).toBeTruthy();
    expect(secretWeakness("0".repeat(64))).toBeTruthy();
  });

  // --- valeurs FORTES : doivent renvoyer null ---

  it("accepte un secret aléatoire fort (style openssl rand -hex 32)", () => {
    expect(secretWeakness("9f1c4e7a2b8d0f63a5e1c9d47b6028fa3c2e1d0b9a8f7e6d5c4b3a2918007f6e5")).toBeNull();
    expect(secretWeakness("k7Qz2mVx9pLrT4wB6nYc1sHd8jFg3aEu")).toBeNull(); // 32 car. mixtes
  });

  it("traite undefined comme acceptable (le caller décide si la var est requise)", () => {
    expect(secretWeakness(undefined)).toBeNull();
  });

  it("n'écrase pas un secret fort contenant par hasard une sous-chaîne (résidu non vide)", () => {
    // contient "secret" mais garde de l'entropie autour → résidu non vide → accepté.
    expect(secretWeakness("secret_9f1c4e7a2b8d0f63a5e1c9d47b6028fa")).toBeNull();
  });
});
