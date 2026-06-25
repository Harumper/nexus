// Gestionnaire de réponses d'actions
// Permet d'attendre la réponse d'un agent après un dispatch

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

// Tampon des réponses arrivées AVANT que waitForResponse ne soit enregistré.
// Race : dispatchAction envoie l'action à l'agent puis `await` (audit log) avant
// que la route n'appelle waitForResponse. Pour une action instantanée (dry-run),
// l'agent répond pendant cet await → sans tampon la réponse arriverait dans le
// vide et provoquerait un timeout systématique. On la garde ici brièvement pour
// que waitForResponse la consomme dès son appel (l'ordre n'importe plus).
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

// Enregistrer une attente de réponse pour un request_id
export function waitForResponse(
  requestId: string,
  timeoutMs: number = 30_000
): Promise<any> {
  return new Promise((resolve, reject) => {
    // La réponse est-elle déjà arrivée (agent ultra-rapide, ex. dry-run) ?
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

// Appelé quand l'agent renvoie une réponse
export function resolveResponse(requestId: string, payload: any): boolean {
  const req = pending.get(requestId);
  if (!req) {
    // Réponse arrivée avant l'enregistrement de l'attente (action instantanée) :
    // on la met en tampon pour que waitForResponse la consomme dès son appel.
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
