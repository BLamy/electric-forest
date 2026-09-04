import { stateDigest, type Event } from "@eforest/protocol";

/**
 * Workspace chat: one catalog stream per org (`chat:<org>`) listing channels, and one
 * message stream per channel (`chat:<org>/<channel>`). Both are org-scoped application
 * streams — the only mutation path is the authenticated dispatch door, and every view
 * here is `replay(events)`. Unlike issue state, the author (`payload.actor`, stamped by
 * the gateway) is part of the reduced state: a chat message without its author is not
 * a message.
 *
 * Edits and deletes mirror the slack-clone conversation model: they name the message
 * and the `expectedRevision` they were composed against, so a stale edit is refused
 * instead of silently clobbering a newer one; a delete leaves a tombstone so replies
 * and offsets stay addressable. Replies reference their root (`threadOf`).
 */
export const CHAT_EVENT_VERSION = 1 as const;
export const CHAT_CATALOG_REDUCER = "chat-catalog" as const;
export const CHAT_CHANNEL_REDUCER = "chat-channel" as const;
export const CHAT_BODY_MAX_CODE_UNITS = 64 * 1024;
export const CHAT_TOPIC_MAX_CODE_UNITS = 512;

const ORG_PATTERN = "[a-z0-9](?:-?[a-z0-9])*";
const CHANNEL_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?";
const CATALOG_RE = new RegExp(`^chat:(${ORG_PATTERN})$`);
const CHANNEL_RE = new RegExp(`^chat:(${ORG_PATTERN})/(${CHANNEL_PATTERN})$`);
const CHANNEL_NAME_RE = new RegExp(`^${CHANNEL_PATTERN}$`);
const MESSAGE_ID_RE = /^[A-Za-z0-9._~-]{1,80}$/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type ChatActionType =
  "chat.channel.create" | "chat.message.post" | "chat.message.edit" | "chat.message.delete";

export function isChatActionType(type: string): type is ChatActionType {
  return (
    type === "chat.channel.create" ||
    type === "chat.message.post" ||
    type === "chat.message.edit" ||
    type === "chat.message.delete"
  );
}

export function isChatChannelName(value: string): boolean {
  return CHANNEL_NAME_RE.test(value);
}

export function isChatMessageId(value: string): boolean {
  return MESSAGE_ID_RE.test(value);
}

export function chatCatalogStreamId(org: string): string {
  return `chat:${org}`;
}

export function chatChannelStreamId(org: string, channel: string): string {
  return `chat:${org}/${channel}`;
}

export function isChatCatalogStreamId(streamId: string): boolean {
  return CATALOG_RE.test(streamId);
}

export function isChatChannelStreamId(streamId: string): boolean {
  return CHANNEL_RE.test(streamId);
}

export function isChatStreamId(streamId: string): boolean {
  return isChatCatalogStreamId(streamId) || isChatChannelStreamId(streamId);
}

export function parseChatStreamId(
  streamId: string,
): { readonly org: string; readonly channel: string | undefined } | undefined {
  const channel = CHANNEL_RE.exec(streamId);
  if (channel !== null) return { org: channel[1]!, channel: channel[2]! };
  const catalog = CATALOG_RE.exec(streamId);
  if (catalog !== null) return { org: catalog[1]!, channel: undefined };
  return undefined;
}

export interface ChatChannelEntry {
  readonly topic: string;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface ChatCatalogState {
  readonly channels: Readonly<Record<string, ChatChannelEntry>>;
}

export interface ChatMessage {
  readonly id: string;
  readonly actor: string;
  readonly body: string;
  readonly ts: number;
  /** Application offset of the posting event; "" while an event has no offset. */
  readonly offset: string;
  /** Root message id when this message is a thread reply. */
  readonly threadOf: string | null;
  /** 1 on post, +1 per accepted edit; edits and deletes must cite the current value. */
  readonly revision: number;
  readonly editedAt: number | null;
  /** A deleted message stays as a tombstone so replies and offsets remain addressable. */
  readonly deleted: boolean;
}

export interface ChatChannelState {
  readonly messages: readonly ChatMessage[];
}

export const chatCatalogInitialState: ChatCatalogState = Object.freeze({
  channels: Object.freeze({}),
});
export const chatChannelInitialState: ChatChannelState = Object.freeze({
  messages: Object.freeze([]),
});

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function chatString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !LONE_SURROGATE_RE.test(value);
}

function chatBody(value: unknown): value is string {
  return chatString(value, CHAT_BODY_MAX_CODE_UNITS) && value.trim().length > 0;
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Client-authored payload shape (before the gateway stamps `actor`). */
export function isChatDispatchPayload(type: string, payload: unknown): boolean {
  if (type === "chat.channel.create") {
    return (
      exactObject(payload, ["v", "name", "topic"]) &&
      payload.v === CHAT_EVENT_VERSION &&
      typeof payload.name === "string" &&
      isChatChannelName(payload.name) &&
      chatString(payload.topic, CHAT_TOPIC_MAX_CODE_UNITS)
    );
  }
  if (type === "chat.message.post") {
    const threaded = exactObject(payload, ["v", "id", "body", "threadOf"]);
    if (!threaded && !exactObject(payload, ["v", "id", "body"])) return false;
    return (
      payload.v === CHAT_EVENT_VERSION &&
      typeof payload.id === "string" &&
      isChatMessageId(payload.id) &&
      chatBody(payload.body) &&
      (!threaded ||
        (typeof payload.threadOf === "string" &&
          isChatMessageId(payload.threadOf) &&
          payload.threadOf !== payload.id))
    );
  }
  if (type === "chat.message.edit") {
    return (
      exactObject(payload, ["v", "id", "body", "expectedRevision"]) &&
      payload.v === CHAT_EVENT_VERSION &&
      typeof payload.id === "string" &&
      isChatMessageId(payload.id) &&
      chatBody(payload.body) &&
      revision(payload.expectedRevision)
    );
  }
  if (type === "chat.message.delete") {
    return (
      exactObject(payload, ["v", "id", "expectedRevision"]) &&
      payload.v === CHAT_EVENT_VERSION &&
      typeof payload.id === "string" &&
      isChatMessageId(payload.id) &&
      revision(payload.expectedRevision)
    );
  }
  return false;
}

function withoutWriter(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "writer"));
}

/** Committed event shape: the client payload plus the gateway-stamped `actor`. */
export function isChatEvent(event: Event): boolean {
  if (!isChatActionType(event.type)) return false;
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return false;
  }
  const { actor, ...rest } = withoutWriter(event.payload as Record<string, unknown>);
  return typeof actor === "string" && actor.length > 0 && isChatDispatchPayload(event.type, rest);
}

export function chatCatalogReducer(state: ChatCatalogState, event: Event): ChatCatalogState {
  if (event.type !== "chat.channel.create" || !isChatEvent(event)) return state;
  const payload = event.payload as { name: string; topic: string; actor: string };
  if (Object.hasOwn(state.channels, payload.name)) return state;
  return {
    channels: {
      ...state.channels,
      [payload.name]: { topic: payload.topic, createdBy: payload.actor, createdAt: event.ts },
    },
  };
}

export function chatMessageById(state: ChatChannelState, id: string): ChatMessage | undefined {
  return state.messages.find((message) => message.id === id);
}

/**
 * Total and idempotent: an edit or delete that does not cite the live revision, names
 * an unknown or deleted message, or comes from someone other than the author leaves
 * state unchanged (the server refuses those before they are ever appended).
 */
export function chatChannelReducer(state: ChatChannelState, event: Event): ChatChannelState {
  if (!isChatEvent(event)) return state;
  const payload = event.payload as Record<string, unknown> & { actor: string; id: string };
  if (event.type === "chat.message.post") {
    if (chatMessageById(state, payload.id) !== undefined) return state;
    const threadOf = typeof payload.threadOf === "string" ? payload.threadOf : null;
    if (threadOf !== null) {
      const root = chatMessageById(state, threadOf);
      if (root === undefined || root.threadOf !== null) return state;
    }
    const offset = (event as { readonly offset?: unknown }).offset;
    return {
      messages: [
        ...state.messages,
        {
          id: payload.id,
          actor: payload.actor,
          body: payload.body as string,
          ts: event.ts,
          offset: typeof offset === "string" ? offset : "",
          threadOf,
          revision: 1,
          editedAt: null,
          deleted: false,
        },
      ],
    };
  }
  const target = chatMessageById(state, payload.id);
  if (
    target === undefined ||
    target.deleted ||
    target.actor !== payload.actor ||
    target.revision !== payload.expectedRevision
  ) {
    return state;
  }
  const updated: ChatMessage =
    event.type === "chat.message.edit"
      ? {
          ...target,
          body: payload.body as string,
          revision: target.revision + 1,
          editedAt: event.ts,
        }
      : { ...target, body: "", revision: target.revision + 1, deleted: true };
  return {
    messages: state.messages.map((message) => (message.id === target.id ? updated : message)),
  };
}

export const chatCatalogReducerDefinition = Object.freeze({
  id: CHAT_CATALOG_REDUCER,
  version: CHAT_EVENT_VERSION,
  initialState: chatCatalogInitialState,
  reduce: chatCatalogReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isChatCatalogStreamId,
});

export const chatChannelReducerDefinition = Object.freeze({
  id: CHAT_CHANNEL_REDUCER,
  version: CHAT_EVENT_VERSION,
  initialState: chatChannelInitialState,
  reduce: chatChannelReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isChatChannelStreamId,
});
