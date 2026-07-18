import {
  appendDurableJsonBatch,
  createDurableJsonStream,
  headDurableJsonStream,
  isDurableConflict,
  isDurableExistsConflict,
  readDurableJson,
  type StreamRecord,
} from "@eforest/client";
import {
  emptyView,
  identityReducer,
  IdentityReducerError,
  userForSub,
  viewDigest,
  type AuthorizationView,
} from "@eforest/identity";
import { replay, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset, offsetForOrdinal } from "@eforest/protocol/offset-allocation";

export interface IdentitySnapshot {
  readonly events: readonly StreamRecord[];
  readonly view: AuthorizationView;
  readonly offset: Offset | "-1";
  readonly digest: string;
  readonly sessionStartedAt: ReadonlyMap<string, number>;
}

export interface IdentityStoreOptions {
  readonly baseUrl: string;
  readonly streamId?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class IdentityConflictError extends Error {
  constructor() {
    super("identity stream remained contended");
    this.name = "IdentityConflictError";
  }
}

export class IdentityDispatchRefusedError extends Error {
  readonly code: string;

  constructor(error: IdentityReducerError) {
    super(error.message, { cause: error });
    this.name = "IdentityDispatchRefusedError";
    this.code = error.code;
  }
}

function streamUrl(baseUrl: string, streamId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/streams/${encodeURIComponent(streamId)}`;
}

function nextOffset(events: readonly StreamRecord[], increment = 1): Offset {
  const last = events.at(-1)?.offset;
  let ordinal = -1;
  if (last !== undefined) {
    if (!isWellFormedOffset(last) || last === "-1") throw new Error("invalid identity offset");
    ordinal = Number(last.slice(last.lastIndexOf("_") + 1));
    if (!Number.isSafeInteger(ordinal)) throw new Error("invalid identity offset");
  }
  return offsetForOrdinal(ordinal + increment);
}

function snapshotOf(events: readonly StreamRecord[], offset: Offset | "-1"): IdentitySnapshot {
  const view = replay(events.map(eventOf), identityReducer, emptyView());
  const started = new Map<string, number>();
  for (const event of events) {
    if (event.type === "identity.session.started") {
      const payload = event.payload as { sessionId: string };
      started.set(payload.sessionId, event.ts);
    }
  }
  return {
    events,
    view,
    offset,
    digest: viewDigest(view),
    sessionStartedAt: started,
  };
}

function eventOf(record: StreamRecord): Event {
  return { type: record.type, payload: record.payload, ts: record.ts };
}

function transportOffset(value: string | undefined): Offset | "-1" {
  if (value === undefined) return "-1";
  if (!isWellFormedOffset(value) || value === "-1") {
    throw new Error("invalid identity stream head offset");
  }
  return value;
}

export class IdentityStore {
  readonly streamId: string;
  private readonly url: string;
  private readonly fetcher: typeof fetch | undefined;
  private readonly now: () => number;

  constructor(options: IdentityStoreOptions) {
    this.streamId = options.streamId ?? "__identity__";
    this.url = streamUrl(options.baseUrl, this.streamId);
    this.fetcher = options.fetch;
    this.now = options.now ?? Date.now;
  }

  private options(): { readonly url: string; readonly fetch?: typeof fetch } {
    return {
      url: this.url,
      ...(this.fetcher === undefined ? {} : { fetch: this.fetcher }),
    };
  }

  async ensure(): Promise<void> {
    try {
      await createDurableJsonStream(this.options());
    } catch (error) {
      if (!isDurableExistsConflict(error)) throw error;
    }
  }

  async snapshot(): Promise<IdentitySnapshot> {
    const [events, head] = await Promise.all([
      readDurableJson<StreamRecord>(this.options()),
      headDurableJsonStream(this.options()),
    ]);
    return snapshotOf(events, transportOffset(head.offset));
  }

  async login(sub: string, email: string, sessionId: string): Promise<IdentitySnapshot> {
    if (userForSub((await this.snapshot()).view, sub) === null) {
      try {
        await this.dispatch({
          type: "identity.user.created",
          payload: { v: 1, sub, email },
          ts: this.now(),
        });
      } catch (error) {
        if (
          !(error instanceof IdentityDispatchRefusedError) ||
          error.code !== "identity/duplicate-user"
        ) {
          throw error;
        }
      }
    }
    return this.dispatch({
      type: "identity.session.started",
      payload: { v: 1, sessionId, sub },
      ts: this.now(),
    });
  }

  async endSession(sessionId: string): Promise<IdentitySnapshot> {
    try {
      return await this.dispatch({
        type: "identity.session.ended",
        payload: { v: 1, sessionId },
        ts: this.now(),
      });
    } catch (error) {
      if (
        !(error instanceof IdentityDispatchRefusedError) ||
        error.code !== "identity/session-ended"
      ) {
        throw error;
      }
      return this.snapshot();
    }
  }

  private async dispatch(event: Event): Promise<IdentitySnapshot> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const before = await this.snapshot();
      const record: StreamRecord = {
        offset: nextOffset(before.events),
        ...event,
      };
      try {
        identityReducer(before.view, eventOf(record));
      } catch (error) {
        if (error instanceof IdentityReducerError) throw new IdentityDispatchRefusedError(error);
        throw error;
      }
      try {
        await appendDurableJsonBatch(this.options(), [record], record.offset);
        return this.snapshot();
      } catch (error) {
        if (isDurableConflict(error)) continue;
        throw error;
      }
    }
    throw new IdentityConflictError();
  }
}
