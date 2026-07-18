import {
  appendDurableJsonBatch,
  createDurableJsonStream,
  headDurableJsonStream,
  isDurableConflict,
  isDurableExistsConflict,
  readDurableJsonSnapshot,
  type StreamRecord,
} from "@eforest/client";
import {
  emptyView,
  identityReducer,
  IdentityReducerError,
  userForSub,
  viewDigest,
  type AuthorizationView,
  type CliTokenKind,
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
  /** Test/telemetry hook fired after a durable revoke attempt observes an active operation. */
  readonly onGrantRevocationBlocked?: (grantId: string) => void;
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
  private readonly onGrantRevocationBlocked: ((grantId: string) => void) | undefined;

  constructor(options: IdentityStoreOptions) {
    this.streamId = options.streamId ?? "__identity__";
    this.url = streamUrl(options.baseUrl, this.streamId);
    this.fetcher = options.fetch;
    this.now = options.now ?? Date.now;
    this.onGrantRevocationBlocked = options.onGrantRevocationBlocked;
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
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const read = await readDurableJsonSnapshot<StreamRecord>(this.options());
      const offset = transportOffset(read.offset);
      const head = transportOffset((await headDurableJsonStream(this.options())).offset);
      if (head === offset) return snapshotOf(read.items, offset);
    }
    throw new IdentityConflictError();
  }

  async login(sub: string, email: string, sessionId: string): Promise<IdentitySnapshot> {
    await this.ensureUser(sub, email);
    return this.dispatch({
      type: "identity.session.started",
      payload: { v: 1, sessionId, sub },
      ts: this.now(),
    });
  }

  async ensureUser(sub: string, email: string): Promise<IdentitySnapshot> {
    if (userForSub((await this.snapshot()).view, sub) === null) {
      try {
        return await this.dispatch({
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
    return this.snapshot();
  }

  async issueCliGrant(input: {
    readonly grantId: string;
    readonly sub: string;
    readonly tokenKind: CliTokenKind;
    readonly tokenHash: string;
    readonly scopes: readonly string[];
    readonly name?: string;
  }): Promise<IdentitySnapshot> {
    const issuedAt = this.now();
    return this.dispatch({
      type: "identity.grant.issued",
      payload: {
        v: 2,
        grantId: input.grantId,
        sub: input.sub,
        kind: input.tokenKind === "device" ? "cli-token" : "web-session-mint",
        tokenKind: input.tokenKind,
        tokenHash: input.tokenHash,
        scopes: input.scopes,
        ...(input.name === undefined ? {} : { name: input.name }),
        issuedAt,
      },
      ts: issuedAt,
    });
  }

  async revokeCliGrant(grantId: string): Promise<IdentitySnapshot> {
    for (;;) {
      const revokedAt = this.now();
      try {
        return await this.dispatch({
          type: "identity.grant.revoked",
          payload: { v: 2, grantId, revokedAt },
          ts: revokedAt,
        });
      } catch (error) {
        if (
          !(error instanceof IdentityDispatchRefusedError) ||
          error.code !== "identity/grant-in-use"
        ) {
          throw error;
        }
        this.onGrantRevocationBlocked?.(grantId);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
    }
  }

  async beginGrantOperation(grantId: string, operationId: string): Promise<IdentitySnapshot> {
    const startedAt = this.now();
    return this.dispatch({
      type: "identity.grant.operation.started",
      payload: { v: 2, operationId, grantId, startedAt },
      ts: startedAt,
    });
  }

  async completeGrantOperation(operationId: string): Promise<IdentitySnapshot> {
    const completedAt = this.now();
    return this.dispatch({
      type: "identity.grant.operation.completed",
      payload: { v: 2, operationId, completedAt },
      ts: completedAt,
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
