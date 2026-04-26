// Helper unique pour extraire un message lisible depuis un catch.
// Évite les `catch (err: any)` partout : err est typé `unknown` (norme TS)
// et on extrait le message proprement selon le type réel.
//
// Le fallback permet de remplacer le pattern `err?.message || "X"`
// directement par `getErrorMessage(err, "X")`.
export function getErrorMessage(err: unknown, fallback = "Erreur inconnue"): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback;
}
