/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/kvib.ts @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
/** Tiny haptics helper — matches the prototype's `kvib`. */
export const kvib = (p: number | number[]) => {
  try {
    if (navigator.vibrate) navigator.vibrate(p); // ef: statement form for lint
  } catch {
    /* noop */
  }
};
