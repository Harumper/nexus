import { describe, it, expect } from "vitest";
import { waitForResponse, resolveResponse } from "../../src/services/action-response.js";

// Regression: an instant action (dry-run) responds BEFORE the route calls
// waitForResponse (dispatchAction `await`s the audit log between sending and
// registering the wait). Without a buffer, the response was discarded and the
// request timed out systematically. The earlyResponses buffer fixes this.
describe("action-response — response-before-wait race", () => {
  it("resolves even if the response arrives BEFORE waitForResponse", async () => {
    const id = "req_early_success";
    // Response arrives first (no wait registered) → buffered.
    const buffered = resolveResponse(id, { success: true, data: { ok: 42 } });
    expect(buffered).toBe(true);

    // The wait registers afterward → must consume the buffer immediately.
    const data = await waitForResponse(id, 5_000);
    expect(data).toEqual({ ok: 42 });
  });

  it("propagates an error that arrived before the wait", async () => {
    const id = "req_early_error";
    resolveResponse(id, { success: false, error: "boom" });
    await expect(waitForResponse(id, 5_000)).rejects.toThrow("boom");
  });

  it("also works in the normal order (wait then response)", async () => {
    const id = "req_normal_order";
    const p = waitForResponse(id, 5_000);
    expect(resolveResponse(id, { success: true, data: "pong" })).toBe(true);
    await expect(p).resolves.toBe("pong");
  });

  it("times out if no response arrives", async () => {
    await expect(waitForResponse("req_never", 50)).rejects.toThrow(
      "Action response timeout"
    );
  });
});
