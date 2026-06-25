import { describe, it, expect } from "vitest";
import { waitForResponse, resolveResponse } from "../../src/services/action-response.js";

// Régression : une action instantanée (dry-run) répond AVANT que la route
// n'appelle waitForResponse (dispatchAction `await` l'audit log entre l'envoi
// et l'enregistrement de l'attente). Sans tampon, la réponse était jetée et la
// requête timeout-ait systématiquement. Le tampon earlyResponses corrige ça.
describe("action-response — race réponse-avant-attente", () => {
  it("résout même si la réponse arrive AVANT waitForResponse", async () => {
    const id = "req_early_success";
    // Réponse arrive en premier (aucune attente enregistrée) → mise en tampon.
    const buffered = resolveResponse(id, { success: true, data: { ok: 42 } });
    expect(buffered).toBe(true);

    // L'attente s'enregistre ensuite → doit consommer le tampon immédiatement.
    const data = await waitForResponse(id, 5_000);
    expect(data).toEqual({ ok: 42 });
  });

  it("propage une erreur arrivée avant l'attente", async () => {
    const id = "req_early_error";
    resolveResponse(id, { success: false, error: "boom" });
    await expect(waitForResponse(id, 5_000)).rejects.toThrow("boom");
  });

  it("fonctionne aussi dans l'ordre normal (attente puis réponse)", async () => {
    const id = "req_normal_order";
    const p = waitForResponse(id, 5_000);
    expect(resolveResponse(id, { success: true, data: "pong" })).toBe(true);
    await expect(p).resolves.toBe("pong");
  });

  it("timeout si aucune réponse n'arrive", async () => {
    await expect(waitForResponse("req_never", 50)).rejects.toThrow(
      "Action response timeout"
    );
  });
});
