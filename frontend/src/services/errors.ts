// Helper unique pour extraire un message lisible depuis un catch.
// Évite les `catch (err: any)` partout : err est typé `unknown` (norme TS)
// et on extrait le message proprement selon le type réel.
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "Erreur inconnue";
}
