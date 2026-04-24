import { dispatchAction } from "./action-dispatcher.js";
import { waitForResponse } from "./action-response.js";

/**
 * Dispatch une action a l'agent et attend la reponse.
 * Utilise en interne par l'alert-engine pour poll l'etat sante.
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
