import { userForSub } from "@eforest/identity";
import type { IdentityStore, IdentitySnapshot } from "../auth/provision.js";
import { parseSessionCookie, sessionIsValid } from "../auth/session.js";

export interface SessionBackedIdentity {
  readonly snapshot: IdentitySnapshot;
  readonly sub: string;
  readonly email: string;
}

export interface WhoamiOptions {
  readonly identity: IdentityStore;
  readonly sessionSecret: string;
  readonly sessionTtlMs: number;
  readonly now: () => number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function resolveSessionBackedIdentity(
  request: Request,
  options: WhoamiOptions,
): Promise<SessionBackedIdentity | null> {
  if (request.headers.has("authorization")) return null;
  const parsed = parseSessionCookie(request.headers.get("cookie"), options.sessionSecret);
  if (parsed.kind !== "valid") return null;
  const snapshot = await options.identity.snapshot();
  if (!sessionIsValid(snapshot, parsed.sessionId, options.now(), options.sessionTtlMs)) return null;
  const session = snapshot.view.sessions[parsed.sessionId];
  if (session === undefined) return null;
  const user = userForSub(snapshot.view, session.sub);
  if (user === null) return null;
  return { snapshot, sub: session.sub, email: user.email };
}

export async function whoamiResponse(request: Request, options: WhoamiOptions): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(405, { error: { class: "method-not-allowed" } });
  }
  const identity = await resolveSessionBackedIdentity(request, options);
  if (identity === null) return json(401, { error: { class: "auth-refused" } });
  return json(200, {
    user: { sub: identity.sub, email: identity.email },
    stream: options.identity.streamId,
    offset: identity.snapshot.offset,
    digest: identity.snapshot.digest,
  });
}
