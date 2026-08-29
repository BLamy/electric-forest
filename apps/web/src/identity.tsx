import { useEffect, useState } from "react";

export interface Whoami {
  readonly user: { readonly sub: string; readonly email: string };
  readonly stream: string;
  readonly offset: string;
  readonly digest: string;
}

function isWhoami(value: unknown): value is Whoami {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Whoami>;
  return (
    typeof candidate.user === "object" &&
    candidate.user !== null &&
    typeof candidate.user.sub === "string" &&
    typeof candidate.user.email === "string" &&
    typeof candidate.stream === "string" &&
    typeof candidate.offset === "string" &&
    typeof candidate.digest === "string"
  );
}

export function IdentityRegion(): React.JSX.Element {
  const [identity, setIdentity] = useState<Whoami | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/whoami", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`whoami refused with ${String(response.status)}`);
        const value: unknown = await response.json();
        if (!isWhoami(value)) throw new Error("whoami returned an invalid identity view");
        return value;
      })
      .then(setIdentity, (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed) return <p role="alert">Identity could not be replayed.</p>;
  if (identity === null) return <p data-testid="identity-loading">Replaying identity…</p>;
  return (
    <section
      className="identity"
      data-testid="identity-region"
      data-ef-stream={identity.stream}
      data-ef-offset={identity.offset}
      data-ef-digest={identity.digest}
    >
      <p>
        Signed in as <strong data-testid="identity-email">{identity.user.email}</strong>
      </p>
      <p className="subject" data-testid="identity-sub">
        {identity.user.sub}
      </p>
    </section>
  );
}
