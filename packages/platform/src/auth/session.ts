import { createHmac, timingSafeEqual } from "node:crypto";
import type { IdentitySnapshot } from "./provision.js";

export const SESSION_COOKIE = "ef_session";

export type CookieResult =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly sessionId: string };

function signature(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("base64url");
}

export function signedSessionCookie(secret: string, sessionId: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}.${signature(secret, sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(ttlSeconds))}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseSessionCookie(header: string | null, secret: string): CookieResult {
  if (header === null) return { kind: "missing" };
  const pair = header
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (pair === undefined) return { kind: "missing" };
  const value = pair.slice(SESSION_COOKIE.length + 1);
  if (value.length === 0 || value.length > 1_024) return { kind: "malformed" };
  const segments = value.split(".");
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    return { kind: "malformed" };
  }
  const [sessionId, actual] = segments as [string, string];
  const expected = signature(secret, sessionId);
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { kind: "invalid" };
  return { kind: "valid", sessionId };
}

export function sessionIsValid(
  snapshot: IdentitySnapshot,
  sessionId: string,
  now: number,
  ttlMs: number,
): boolean {
  const session = snapshot.view.sessions[sessionId];
  const startedAt = snapshot.sessionStartedAt.get(sessionId);
  return (
    session?.status === "active" &&
    startedAt !== undefined &&
    now >= startedAt &&
    now - startedAt < ttlMs
  );
}
