import { OFFSET_BEFORE_FIRST, isEvent, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  chatCatalogInitialState,
  chatCatalogReducer,
  chatChannelInitialState,
  chatChannelReducer,
  chatMessageById,
  isChatCatalogStreamId,
  isChatChannelStreamId,
  isChatEvent,
  type ChatCatalogState,
  type ChatChannelState,
} from "@eforest/reducers";
import type { ActionValidatorRegistry } from "../validation.js";

export class ChatSchemaError extends Error {
  constructor(readonly reason = "schema-violation") {
    super(reason);
    this.name = "ChatSchemaError";
  }
}
export class ChatUnknownActionError extends Error {
  constructor() {
    super("unknown-action-type");
    this.name = "ChatUnknownActionError";
  }
}
export class ChatRefusalError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ChatRefusalError";
  }
}

/** Committed records carry writer metadata the reducers never see. */
export function chatEventWithoutWriter(value: unknown): Event {
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
  const offset = typeof record.offset === "string" ? { offset: record.offset } : {};
  return { ...base, payload, ...offset } as Event;
}

export function registerChatValidators(registry: ActionValidatorRegistry): ActionValidatorRegistry {
  registry.registerValidator("chat.channel.create", (action, context) => {
    if (!isChatCatalogStreamId(context.streamId)) throw new ChatUnknownActionError();
    if (!isChatEvent(action)) throw new ChatSchemaError();
    const state = context.state as ChatCatalogState;
    const name = (action.payload as { name: string }).name;
    if (Object.hasOwn(state.channels, name)) throw new ChatRefusalError("chat/channel-exists");
  });
  registry.registerValidator("chat.message.post", (action, context) => {
    if (!isChatChannelStreamId(context.streamId)) throw new ChatUnknownActionError();
    if (!isChatEvent(action)) throw new ChatSchemaError();
    const state = context.state as ChatChannelState;
    const payload = action.payload as { id: string; threadOf?: string };
    if (chatMessageById(state, payload.id) !== undefined) {
      throw new ChatRefusalError("chat/duplicate-message");
    }
    if (payload.threadOf !== undefined) {
      const root = chatMessageById(state, payload.threadOf);
      if (root === undefined || root.deleted) throw new ChatRefusalError("chat/unknown-thread");
      if (root.threadOf !== null) throw new ChatRefusalError("chat/nested-thread");
    }
  });
  for (const type of ["chat.message.edit", "chat.message.delete"] as const) {
    registry.registerValidator(type, (action, context) => {
      if (!isChatChannelStreamId(context.streamId)) throw new ChatUnknownActionError();
      if (!isChatEvent(action)) throw new ChatSchemaError();
      const state = context.state as ChatChannelState;
      const payload = action.payload as { id: string; actor: string; expectedRevision: number };
      const target = chatMessageById(state, payload.id);
      if (target === undefined) throw new ChatRefusalError("chat/unknown-message");
      if (target.deleted) throw new ChatRefusalError("chat/message-deleted");
      if (target.actor !== payload.actor) throw new ChatRefusalError("chat/not-author");
      if (target.revision !== payload.expectedRevision) {
        throw new ChatRefusalError("chat/stale-revision");
      }
    });
  }
  return registry;
}

export function validateChatDispatch(
  records: readonly unknown[],
  event: Event,
  streamId: string,
  actionValidators: ActionValidatorRegistry,
): Promise<void> {
  const catalog = isChatCatalogStreamId(streamId);
  if (!catalog && !isChatChannelStreamId(streamId)) throw new ChatUnknownActionError();
  const chatRecords = records.map(chatEventWithoutWriter);
  const state: unknown = catalog
    ? chatRecords.reduce(chatCatalogReducer, chatCatalogInitialState)
    : chatRecords.reduce(chatChannelReducer, chatChannelInitialState);
  return actionValidators.validate(chatEventWithoutWriter(event), {
    streamId,
    state,
    headOffset:
      chatRecords.length === 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(chatRecords.length - 1),
    nextOffset: offsetForOrdinal(chatRecords.length),
    records: chatRecords,
  });
}

/** The reduced channel catalog for an org from raw stream items (empty when absent). */
export function reduceChatCatalog(records: readonly unknown[]): ChatCatalogState {
  return records.map(chatEventWithoutWriter).reduce(chatCatalogReducer, chatCatalogInitialState);
}
