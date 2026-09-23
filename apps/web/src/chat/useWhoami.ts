import { useEffect, useState } from "react";

export interface WhoamiUser {
  readonly sub: string;
  readonly email: string;
}

let cached: WhoamiUser | null | undefined;
let inflight: Promise<WhoamiUser | null> | undefined;

async function load(): Promise<WhoamiUser | null> {
  try {
    const response = await fetch("/api/whoami", { credentials: "same-origin" });
    if (!response.ok) return null;
    const value = (await response.json()) as { user?: { sub?: unknown; email?: unknown } };
    if (typeof value.user?.sub !== "string" || typeof value.user.email !== "string") return null;
    return { sub: value.user.sub, email: value.user.email };
  } catch {
    return null;
  }
}

/** The signed-in subject, replayed once per page from the identity stream via whoami. */
export function useWhoami(): WhoamiUser | null {
  const [user, setUser] = useState<WhoamiUser | null>(cached ?? null);
  useEffect(() => {
    if (cached !== undefined) return;
    inflight ??= load().then((value) => {
      cached = value;
      return value;
    });
    let active = true;
    void inflight.then((value) => {
      if (active) setUser(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return user;
}
