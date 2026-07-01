import { dispatchAction } from "./action-dispatcher.js";
import { waitForResponse } from "./action-response.js";

/**
 * Dispatches an action to the agent and waits for the response.
 * Used internally by the alert-engine to poll the health state.
 */
export async function dispatchActionSync<T = any>(
  machineId: string,
  actionId: string,
  params: Record<string, unknown> = {},
  timeout = 15_000
): Promise<T> {
  const result = await dispatchAction(machineId, { action_id: actionId, params });
  if (!result.success || !result.requestId) {
    throw new Error(result.error || "dispatch failed");
  }
  return waitForResponse(result.requestId, timeout);
}
