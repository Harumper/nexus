// Gestionnaire de réponses d'actions
// Permet d'attendre la réponse d'un agent après un dispatch

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

// Enregistrer une attente de réponse pour un request_id
export function waitForResponse(
  requestId: string,
  timeoutMs: number = 30_000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Action response timeout"));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timeout });
  });
}

// Appelé quand l'agent renvoie une réponse
export function resolveResponse(requestId: string, payload: any): boolean {
  const req = pending.get(requestId);
  if (!req) return false;

  clearTimeout(req.timeout);
  pending.delete(requestId);

  if (payload.success) {
    req.resolve(payload.data);
  } else {
    req.reject(new Error(payload.error || "Action failed"));
  }

  return true;
}
