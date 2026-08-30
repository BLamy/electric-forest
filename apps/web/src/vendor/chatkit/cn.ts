/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/cn.ts @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
/** Minimal className joiner (avoids a hard dep while @touchkit/ui is built in parallel). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
