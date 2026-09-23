import { useEffect, useState } from "react";

export interface WhoamiUser {
  readonly sub: string;
  readonly email: string;
}

export interface Whoami {
  readonly user: WhoamiUser;
  readonly stream: string;
  readonly offset: string;
  readonly digest: string;
}

let cached: Whoami | null | undefined;
let inflight: Promise<Whoami | null> | undefined;

async function load(): Promise<Whoami | null> {
  try {
    const response = await fetch("/api/whoami", { credentials: "same-origin" });
    if (!response.ok) return null;
    const value = (await response.json()) as {
      user?: { sub?: unknown; email?: unknown };
      stream?: unknown;
      offset?: unknown;
      digest?: unknown;
    };
    if (
      typeof value.user?.sub !== "string" ||
      typeof value.user.email !== "string" ||
      typeof value.stream !== "string" ||
      typeof value.offset !== "string" ||
      typeof value.digest !== "string"
    ) {
      return null;
    }
    return {
      user: { sub: value.user.sub, email: value.user.email },
      stream: value.stream,
      offset: value.offset,
      digest: value.digest,
    };
  } catch {
    return null;
  }
}

/** One cached identity request shared by the shell, PR actions, and chat pages. */
export function getWhoami(): Promise<Whoami | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  inflight ??= load().then((value) => {
    cached = value;
    inflight = undefined;
    return value;
  });
  return inflight;
}

/** The signed-in subject, replayed once per page from the identity stream via whoami. */
export function useWhoami(): WhoamiUser | null {
  const [user, setUser] = useState<WhoamiUser | null>(cached?.user ?? null);
  useEffect(() => {
    let active = true;
    void getWhoami().then((value) => {
      if (active) setUser(value?.user ?? null);
    });
    return () => {
      active = false;
    };
  }, []);
  return user;
}
