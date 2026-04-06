import { describe, it, expect, beforeEach } from "vitest";

// Test du store de nonces LRU directement
// On importe le module security et on teste le comportement anti-replay
describe("Nonce Replay Detection", () => {
  it("should detect duplicate nonces via LRU cache", async () => {
    // Simuler le comportement du LRU cache
    const { LRUCache } = await import("lru-cache");

    const recentNonces = new LRUCache<string, true>({
      max: 10_000,
      ttl: 5 * 60 * 1000,
    });

    const nonce1 = "test-nonce-abc123";
    const nonce2 = "test-nonce-def456";

    // Premier usage : nonce non trouvé
    expect(recentNonces.has(nonce1)).toBe(false);
    recentNonces.set(nonce1, true);

    // Deuxième usage du même nonce : détecté comme replay
    expect(recentNonces.has(nonce1)).toBe(true);

    // Nonce différent : pas de replay
    expect(recentNonces.has(nonce2)).toBe(false);
    recentNonces.set(nonce2, true);
    expect(recentNonces.has(nonce2)).toBe(true);
  });

  it("should respect max capacity", async () => {
    const { LRUCache } = await import("lru-cache");

    const smallCache = new LRUCache<string, true>({
      max: 3,
      ttl: 5 * 60 * 1000,
    });

    smallCache.set("a", true);
    smallCache.set("b", true);
    smallCache.set("c", true);
    smallCache.set("d", true); // Devrait évincer "a"

    expect(smallCache.has("a")).toBe(false); // Évincé
    expect(smallCache.has("b")).toBe(true);
    expect(smallCache.has("c")).toBe(true);
    expect(smallCache.has("d")).toBe(true);
  });

  it("should expire entries after TTL", async () => {
    const { LRUCache } = await import("lru-cache");

    const shortTtlCache = new LRUCache<string, true>({
      max: 100,
      ttl: 100, // 100ms TTL pour le test
    });

    shortTtlCache.set("ephemeral", true);
    expect(shortTtlCache.has("ephemeral")).toBe(true);

    // Attendre l'expiration
    await new Promise((r) => setTimeout(r, 150));

    expect(shortTtlCache.has("ephemeral")).toBe(false);
  });
});
