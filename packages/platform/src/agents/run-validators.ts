import type { Event } from "@eforest/protocol";
import {
  agentRunInitialState,
  agentRunReducer,
  agentRunRefusal,
  isAgentRunActionType,
  isAgentRunDispatchPayload,
  isAgentRunEvent,
} from "@eforest/reducers";
import {
  ChatRefusalError,
  ChatSchemaError,
  ChatUnknownActionError,
  chatEventWithoutWriter,
} from "../chat/validators.js";

/**
 * Admission for `agent-run:` streams. Shares the chat refusal classes: unknown action
 * → 404, schema → 422, refusal (out-of-order, not the run's agent, after finish) → 409.
 */
export function checkAgentRunPayload(type: string, payload: unknown): void {
  if (!isAgentRunActionType(type)) throw new ChatUnknownActionError();
  if (!isAgentRunDispatchPayload(type, payload)) throw new ChatSchemaError();
}

export function validateAgentRunDispatch(records: readonly unknown[], stamped: Event): void {
  const event = chatEventWithoutWriter(stamped);
  if (!isAgentRunEvent(event)) throw new ChatSchemaError();
  const state = records.map(chatEventWithoutWriter).reduce(agentRunReducer, agentRunInitialState);
  const refusal = agentRunRefusal(state, event);
  if (refusal !== undefined) throw new ChatRefusalError(refusal);
}
