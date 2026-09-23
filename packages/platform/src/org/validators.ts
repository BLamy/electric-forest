import { OFFSET_BEFORE_FIRST, isEvent, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  agentsInitialState,
  agentsReducer,
  isAgentsEvent,
  isAgentsStreamId,
  isMembersEvent,
  isMembersStreamId,
  membersInitialState,
  membersReducer,
  type AgentsState,
  type MembersState,
} from "@eforest/reducers";
import type { ActionValidatorRegistry } from "../validation.js";
import { ChatRefusalError, ChatSchemaError, ChatUnknownActionError } from "../chat/validators.js";

/**
 * Org-scoped roster streams (`members:<org>`, `agents:<org>`) share the chat streams'
 * refusal classes: unknown action → 404, schema → 422, refusal → 409 with a reason.
 */
export function isOrgRosterStreamId(streamId: string): boolean {
  return isMembersStreamId(streamId) || isAgentsStreamId(streamId);
}

export function orgRosterEventWithoutWriter(value: unknown): Event {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatSchemaError();
  }
  const record = value as Record<string, unknown>;
  const base = { type: record.type, payload: record.payload, ts: record.ts };
  if (!isEvent(base)) throw new ChatSchemaError();
  if (base.payload === null || typeof base.payload !== "object" || Array.isArray(base.payload)) {
    throw new ChatSchemaError();
  }
  const payload = Object.fromEntries(
    Object.entries(base.payload as Record<string, unknown>).filter(([key]) => key !== "writer"),
  );
  return { ...base, payload } as Event;
}

export function registerOrgRosterValidators(
  registry: ActionValidatorRegistry,
): ActionValidatorRegistry {
  registry.registerValidator("member.invite", (action, context) => {
    if (!isMembersStreamId(context.streamId)) throw new ChatUnknownActionError();
    if (!isMembersEvent(action)) throw new ChatSchemaError();
    const state = context.state as MembersState;
    const payload = action.payload as { token: string; email: string };
    if (Object.hasOwn(state.invites, payload.token)) {
      throw new ChatRefusalError("members/duplicate-token");
    }
    const pending = Object.values(state.invites).find(
      (invite) => invite.status === "pending" && invite.email === payload.email,
    );
    if (pending !== undefined) throw new ChatRefusalError("members/already-invited");
  });
  for (const type of ["member.invite.accepted", "member.invite.revoke"] as const) {
    registry.registerValidator(type, (action, context) => {
      if (!isMembersStreamId(context.streamId)) throw new ChatUnknownActionError();
      if (!isMembersEvent(action)) throw new ChatSchemaError();
      const state = context.state as MembersState;
      const payload = action.payload as { token: string };
      const invite = state.invites[payload.token];
      if (invite === undefined) throw new ChatRefusalError("members/unknown-invite");
      if (invite.status !== "pending") throw new ChatRefusalError("members/invite-resolved");
    });
  }
  registry.registerValidator("agent.register", (action, context) => {
    if (!isAgentsStreamId(context.streamId)) throw new ChatUnknownActionError();
    if (!isAgentsEvent(action)) throw new ChatSchemaError();
    const state = context.state as AgentsState;
    const payload = action.payload as { handle: string };
    const existing = state.agents[payload.handle];
    if (existing !== undefined && !existing.removed) {
      throw new ChatRefusalError("agents/handle-taken");
    }
  });
  for (const type of ["agent.update", "agent.remove"] as const) {
    registry.registerValidator(type, (action, context) => {
      if (!isAgentsStreamId(context.streamId)) throw new ChatUnknownActionError();
      if (!isAgentsEvent(action)) throw new ChatSchemaError();
      const state = context.state as AgentsState;
      const payload = action.payload as { handle: string; expectedRevision: number };
      const existing = state.agents[payload.handle];
      if (existing === undefined || existing.removed) {
        throw new ChatRefusalError("agents/unknown-agent");
      }
      if (existing.revision !== payload.expectedRevision) {
        throw new ChatRefusalError("agents/stale-revision");
      }
    });
  }
  return registry;
}

export function validateOrgRosterDispatch(
  records: readonly unknown[],
  event: Event,
  streamId: string,
  actionValidators: ActionValidatorRegistry,
): Promise<void> {
  if (!isOrgRosterStreamId(streamId)) throw new ChatUnknownActionError();
  const rosterRecords = records.map(orgRosterEventWithoutWriter);
  const state: unknown = isMembersStreamId(streamId)
    ? rosterRecords.reduce(membersReducer, membersInitialState)
    : rosterRecords.reduce(agentsReducer, agentsInitialState);
  return actionValidators.validate(orgRosterEventWithoutWriter(event), {
    streamId,
    state,
    headOffset:
      rosterRecords.length === 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(rosterRecords.length - 1),
    nextOffset: offsetForOrdinal(rosterRecords.length),
    records: rosterRecords,
  });
}

export function reduceMembers(records: readonly unknown[]): MembersState {
  return records.map(orgRosterEventWithoutWriter).reduce(membersReducer, membersInitialState);
}
