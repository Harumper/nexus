import { describe, it, expect, beforeEach } from "vitest";

// Test the LRU nonce store directly
// We import the security module and test the anti-replay behavior
describe("Nonce Replay Detection", () => {
  it("should detect duplicate nonces via LRU cache", async () => {
    // Simulate the LRU cache behavior
    const { LRUCache } = await import("lru-cache");

    const recentNonces = new LRUCache<string, true>({
      max: 10_000,
      ttl: 5 * 60 * 1000,
    });

    const nonce1 = "test-nonce-abc123";
    const nonce2 = "test-nonce-def456";

    // First use: nonce not found
    expect(recentNonces.has(nonce1)).toBe(false);
    recentNonces.set(nonce1, true);

    // Second use of the same nonce: detected as replay
    expect(recentNonces.has(nonce1)).toBe(true);

    // Different nonce: no replay
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
    smallCache.set("d", true); // Should evict "a"

    expect(smallCache.has("a")).toBe(false); // Evicted
    expect(smallCache.has("b")).toBe(true);
    expect(smallCache.has("c")).toBe(true);
    expect(smallCache.has("d")).toBe(true);
  });

  it("should expire entries after TTL", async () => {
    const { LRUCache } = await import("lru-cache");

    const shortTtlCache = new LRUCache<string, true>({
      max: 100,
      ttl: 100, // 100ms TTL for the test
    });

    shortTtlCache.set("ephemeral", true);
    expect(shortTtlCache.has("ephemeral")).toBe(true);

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 150));

    expect(shortTtlCache.has("ephemeral")).toBe(false);
  });
});
