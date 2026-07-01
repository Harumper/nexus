// Action response manager
// Allows waiting for an agent's response after a dispatch

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

// Buffer for responses that arrive BEFORE waitForResponse is registered.
// Race: dispatchAction sends the action to the agent then `await`s (audit log)
// before the route calls waitForResponse. For an instant action (dry-run), the
// agent responds during that await → without a buffer the response would arrive
// into the void and cause a systematic timeout. We keep it here briefly so
// waitForResponse consumes it as soon as it's called (order no longer matters).
interface EarlyResponse {
  payload: any;
  at: number;
}
const earlyResponses = new Map<string, EarlyResponse>();
const EARLY_TTL_MS = 60_000;

function sweepEarlyResponses(now: number): void {
  for (const [id, e] of earlyResponses) {
    if (now - e.at > EARLY_TTL_MS) {
      earlyResponses.delete(id);
    }
  }
}

function settle(
  resolve: (data: any) => void,
  reject: (error: Error) => void,
  payload: any
): void {
  if (payload.success) {
    resolve(payload.data);
  } else {
    reject(new Error(payload.error || "Action failed"));
  }
}

// Register a wait for a response for a given request_id
export function waitForResponse(
  requestId: string,
  timeoutMs: number = 30_000
): Promise<any> {
  return new Promise((resolve, reject) => {
    // Has the response already arrived (ultra-fast agent, e.g. dry-run)?
    const early = earlyResponses.get(requestId);
    if (early) {
      earlyResponses.delete(requestId);
      settle(resolve, reject, early.payload);
      return;
    }

    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Action response timeout"));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timeout });
  });
}

// Called when the agent returns a response
export function resolveResponse(requestId: string, payload: any): boolean {
  const req = pending.get(requestId);
  if (!req) {
    // Response arrived before the wait was registered (instant action):
    // buffer it so waitForResponse consumes it as soon as it's called.
    const now = Date.now();
    sweepEarlyResponses(now);
    earlyResponses.set(requestId, { payload, at: now });
    return true;
  }

  clearTimeout(req.timeout);
  pending.delete(requestId);
  settle(req.resolve, req.reject, payload);

  return true;
}
