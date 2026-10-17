import { useState } from "react";
import { Button } from "@brett_lamy/ui";
import { navigate } from "../navigation.js";
import { Box, ghButton } from "../blocks/github/parts.js";
import { useWhoami } from "../chat/useWhoami.js";

/**
 * Invite landing: `/invite/<org>/<token>`. The email link routes through
 * `/auth/login?next=…`, so by the time this renders the recipient has a session; accepting
 * asks the platform door to check the signed-in email against the invite, grant the
 * identity membership, and append `member.invite.accepted` to the workspace stream.
 */
export function InvitePage(props: {
  readonly org: string;
  readonly token: string;
}): React.JSX.Element {
  const me = useWhoami();
  const [state, setState] = useState<"idle" | "busy" | "done" | `error:${string}`>("idle");
  const accept = async (): Promise<void> => {
    setState("busy");
    const response = await fetch(
      `/api/orgs/${encodeURIComponent(props.org)}/invites/${encodeURIComponent(props.token)}/accept`,
      { method: "POST", credentials: "same-origin" },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { reason?: string; class?: string };
      };
      setState(`error:${body.error?.reason ?? body.error?.class ?? String(response.status)}`);
      return;
    }
    setState("done");
    navigate(`/members/${encodeURIComponent(props.org)}`);
  };
  return (
    <Box data-testid="invite-page" className="mx-auto grid max-w-xl gap-3 px-6 py-8">
      <p className="m-0 text-muted-foreground">Workspace invitation</p>
      <h1 className="m-0 text-[20px] font-semibold">Join {props.org}</h1>
      <p className="m-0">
        {me === null ? "Replaying your identity…" : `You are signed in as ${me.email}.`} Accepting
        grants your account membership in <strong>{props.org}</strong> — an event on the identity
        stream — and records the acceptance on the workspace's member stream.
      </p>
      {state.startsWith("error:") ? (
        <p role="alert" className="m-0 text-destructive" data-testid="invite-error">
          {state.slice("error:".length) === "invite-email-mismatch"
            ? "This invitation was sent to a different email address than the one you signed in with."
            : `The invitation could not be accepted: ${state.slice("error:".length)}`}
        </p>
      ) : null}
      <div>
        <Button
          className={ghButton(state === "idle" || state.startsWith("error:"))}
          onPress={() => void accept()}
        >
          {state === "busy" ? "Joining…" : state === "done" ? "Joined" : "Accept invitation"}
        </Button>
      </div>
    </Box>
  );
}
