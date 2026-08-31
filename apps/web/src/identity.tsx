import { useEffect, useState } from "react";
import { getWhoami, type Whoami } from "./chat/useWhoami.js";

export type { Whoami } from "./chat/useWhoami.js";

export function IdentityRegion(): React.JSX.Element {
  const [identity, setIdentity] = useState<Whoami | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void getWhoami()
      .then((value) => {
        if (!active) return;
        if (value === null) setFailed(true);
        else setIdentity(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
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
