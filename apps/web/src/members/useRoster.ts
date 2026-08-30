import { useCallback, useEffect, useState } from "react";
import { useDispatch, useStreamReducer, type DispatchFunction } from "@eforest/web-hooks";
import {
  AGENTS_REDUCER,
  DEFAULT_AGENTS,
  agentsStreamId,
  type AgentConfig,
  type AgentsState,
  type MemberInvite,
} from "@eforest/reducers";

export interface HumanMember {
  readonly sub: string;
  readonly email: string | null;
  readonly role: "owner" | "admin" | "member";
  readonly status: string;
}

export interface RosterSnapshot {
  readonly org: string;
  readonly owner: string;
  readonly me: { readonly sub: string; readonly role: "owner" | "admin" | "member" };
  readonly humans: readonly HumanMember[];
  readonly invites: readonly MemberInvite[];
  readonly identityOffset: string;
  readonly emailDelivery: "resend" | "unconfigured";
}

export interface HumanRoster {
  readonly snapshot: RosterSnapshot | undefined;
  readonly status: "loading" | "ready" | `error:${string}`;
  readonly reload: () => Promise<void>;
  readonly invite: (
    email: string,
    role: "admin" | "member",
  ) => Promise<{ readonly link: string; readonly emailed: boolean }>;
}

/** Humans come from identity (memberships) plus the org's invite stream, via the platform door. */
export function useHumanRoster(org: string): HumanRoster {
  const [snapshot, setSnapshot] = useState<RosterSnapshot | undefined>(undefined);
  const [status, setStatus] = useState<HumanRoster["status"]>("loading");
  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(org)}/members`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        setStatus(`error:${String(response.status)}`);
        return;
      }
      setSnapshot((await response.json()) as RosterSnapshot);
      setStatus("ready");
    } catch (cause) {
      setStatus(`error:${cause instanceof Error ? cause.message : "unreachable"}`);
    }
  }, [org]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const invite = useCallback(
    async (email: string, role: "admin" | "member") => {
      const response = await fetch(`/api/orgs/${encodeURIComponent(org)}/invites`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        link?: string;
        emailed?: unknown;
        error?: { reason?: string; class?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.reason ?? body.error?.class ?? `invite refused ${String(response.status)}`,
        );
      }
      await reload();
      return {
        link: body.link ?? "",
        emailed: body.emailed !== null && body.emailed !== undefined,
      };
    },
    [org, reload],
  );
  return { snapshot, status, reload, invite };
}

export interface AgentRoster {
  readonly streamId: string;
  readonly state: AgentsState;
  readonly status: string;
  readonly checkpoint: string;
  readonly dispatch: DispatchFunction;
}

/** Agents are a reducer over the org's `agents:` stream, followed live. */
export function useAgentRoster(org: string): AgentRoster {
  const streamId = agentsStreamId(org);
  const projection = useStreamReducer<AgentsState>({
    apiPath: `/api/agents/${encodeURIComponent(org)}`,
    streamId,
    reducerId: AGENTS_REDUCER,
    followWaitMs: 10_000,
    reconnectDelayMs: 1_000,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: projection.checkpoint });
  return {
    streamId,
    state: projection.state,
    status: projection.status,
    checkpoint: projection.checkpoint,
    dispatch,
  };
}

export function registerAgentEvent(handle: string, config: AgentConfig) {
  return { type: "agent.register", payload: { v: 1, handle, config }, ts: Date.now() };
}

/** Seeds the default roster; already-present handles are skipped, refusals are surfaced. */
export async function seedDefaultAgents(
  dispatch: DispatchFunction,
  present: ReadonlySet<string>,
): Promise<number> {
  let seeded = 0;
  for (const agent of DEFAULT_AGENTS) {
    if (present.has(agent.handle)) continue;
    const { handle, ...config } = agent;
    await dispatch(registerAgentEvent(handle, config));
    seeded += 1;
  }
  return seeded;
}
