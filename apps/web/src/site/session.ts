/**
 * The platform stamps `<meta name="ef-session" content="replayed">` into the served shell
 * when the request carried a valid replayed session. That single server-supplied bit lets
 * `/` choose between the public landing page and the application without a whoami round
 * trip; the client never reads the session cookie itself.
 */
export function hasReplayedSession(doc: Document = document): boolean {
  return doc.querySelector('meta[name="ef-session"][content="replayed"]') !== null;
}

/** The proof receipt is a browser-verify-only diagnostic, never a production request. */
export function hasProofReceipt(doc: Document = document): boolean {
  return doc.querySelector('meta[name="ef-proof-receipt"][content="available"]') !== null;
}

export type PublicSitePage =
  | { readonly kind: "landing" }
  | { readonly kind: "roadmap" }
  | { readonly kind: "roadmap-document" }
  | { readonly kind: "task"; readonly id: string }
  | { readonly kind: "docs"; readonly slug: string | undefined };

/** Client-side mirror of the platform's PUBLIC_SITE_ROUTES; `/` is public only without a session. */
export function publicSitePage(pathname: string, session: boolean): PublicSitePage | undefined {
  if (pathname === "/") return session ? undefined : { kind: "landing" };
  if (pathname === "/home") return { kind: "landing" };
  if (pathname === "/roadmap") return { kind: "roadmap" };
  if (pathname === "/roadmap/document") return { kind: "roadmap-document" };
  if (pathname.startsWith("/roadmap/")) {
    const id = decodeURIComponent(pathname.slice("/roadmap/".length));
    return { kind: "task", id };
  }
  if (pathname === "/docs") return { kind: "docs", slug: undefined };
  if (pathname.startsWith("/docs/")) {
    return { kind: "docs", slug: pathname.slice("/docs/".length).replace(/\/+$/, "") };
  }
  return undefined;
}
