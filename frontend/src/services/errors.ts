// Single helper to extract a readable message from a catch.
// Avoids `catch (err: any)` everywhere: err is typed `unknown` (TS norm)
// and we extract the message cleanly based on the actual type.
//
// The fallback lets you replace the `err?.message || "X"` pattern
// directly with `getErrorMessage(err, "X")`.
export function getErrorMessage(err: unknown, fallback = "Unknown error"): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback;
}
