import { createHash } from "node:crypto";
import type { Server } from "node:http";
import {
  canonicalJson,
  OFFSET_BEFORE_FIRST,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  FixedWindowRateLimiter,
  OfficialStreamAdapter,
  PlatformGateway,
  createPlatformServer,
  listenPlatformServer,
  type ActionValidatorRegistry,
  type AuthzInput,
  type AuthorizationVerifier,
} from "@eforest/platform";
import { createDurableStreamTestServer } from "@eforest/server";
import { prInitialStateForStream, prReducer, type PrState } from "../src/index.js";

export interface OffsetEvent extends Event {
  readonly offset: Offset;
}

export interface PrSnapshot {
  readonly headOffset: Offset;
  readonly digest: string;
  readonly dumpSha256: string;
  readonly dump: string;
  readonly state: PrState;
  readonly records: readonly OffsetEvent[];
}

export interface DispatchResult {
  readonly status: number;
  readonly body: string;
  readonly offset?: Offset;
}

export interface AttachedGateway {
  readonly baseUrl: string;
  readonly gateway: PlatformGateway;
  stop(): Promise<void>;
}

export interface PrHttpFixture {
  readonly baseUrl: string;
  readonly officialUrl: string;
  readonly streams: OfficialStreamAdapter;
  readonly mainStream: string;
  readonly sourceStream: string;
  readonly forkOffset: Offset;
  createPr(prId: string): Promise<string>;
  dispatch(streamId: string, event: Event, baseUrl?: string): Promise<DispatchResult>;
  attachGateway(actionValidators?: ActionValidatorRegistry): Promise<AttachedGateway>;
  stop(): Promise<void>;
}

export function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
}

function allowRepository(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write" as const,
    streamId: "streamId" in input.target ? input.target.streamId : "",
  };
}

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: "alice" }),
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function startPrHttpFixture(): Promise<PrHttpFixture> {
  const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const officialUrl = await official.start();
  const streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
  const mainStream = "fs:maple/reading-room:main:meta";
  const sourceStream = "fs:maple/reading-room:feature:meta";
  const forkOffset = offsetForOrdinal(0);

  await streams.create(mainStream);
  await streams.append(mainStream, event("fs.dir.create", { path: "src", v: 2 }, 0), {
    sequence: forkOffset,
    applicationOffset: forkOffset,
  });
  await streams.fork!(
    sourceStream,
    mainStream,
    forkOffset,
    event("fs.branch.fork", { forkOffset, parentStreamId: mainStream, v: 1 }, 0),
  );

  const attached: AttachedGateway[] = [];
  const attachGateway = async (
    actionValidators?: ActionValidatorRegistry,
  ): Promise<AttachedGateway> => {
    const gateway = new PlatformGateway({
      verifier,
      streams: new OfficialStreamAdapter({ baseUrl: officialUrl }),
      decideAuthorization: allowRepository,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      rateLimiter: new FixedWindowRateLimiter({ max: 100_000, windowMs: 3_600_000 }),
      ...(actionValidators === undefined ? {} : { actionValidators }),
    });
    const server = createPlatformServer((request) => gateway.handle(request));
    const baseUrl = await listenPlatformServer(server);
    const result: AttachedGateway = {
      baseUrl,
      gateway,
      async stop() {
        gateway.terminate();
        await closeServer(server);
      },
    };
    attached.push(result);
    return result;
  };
  const primary = await attachGateway();

  return {
    baseUrl: primary.baseUrl,
    officialUrl,
    streams,
    mainStream,
    sourceStream,
    forkOffset,
    async createPr(prId) {
      const streamId = `pr:maple/reading-room/${prId}`;
      await streams.create(streamId);
      return streamId;
    },
    async dispatch(streamId, current, baseUrl = primary.baseUrl) {
      const response = await fetch(`${baseUrl}/api/dispatch`, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          "x-eforest-dispatch-receipt": "offset",
        },
        body: JSON.stringify({ streamId, event: current }),
      });
      const body = await response.text();
      let offset: Offset | undefined;
      try {
        const decoded = JSON.parse(body) as { readonly offset?: unknown };
        if (typeof decoded.offset === "string") offset = decoded.offset as Offset;
      } catch {
        // The raw body remains the transport oracle for malformed responses.
      }
      return { status: response.status, body, ...(offset === undefined ? {} : { offset }) };
    },
    attachGateway,
    async stop() {
      await Promise.all(attached.splice(0).map((gateway) => gateway.stop()));
      await official.stop();
    },
  };
}

function normalizeRecord(value: unknown, index: number): OffsetEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PR stream record is not an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.payload === null || typeof raw.payload !== "object" || Array.isArray(raw.payload)) {
    throw new TypeError("PR stream payload is not an object");
  }
  const offset = typeof raw.offset === "string" ? (raw.offset as Offset) : offsetForOrdinal(index);
  return {
    type: raw.type as string,
    ts: raw.ts as number,
    payload: Object.fromEntries(
      Object.entries(raw.payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
    offset,
  };
}

export async function prSnapshot(
  streams: OfficialStreamAdapter,
  streamId: string,
): Promise<PrSnapshot> {
  const records = (await streams.read(streamId)).map(normalizeRecord);
  const state = records.reduce(prReducer, prInitialStateForStream(streamId));
  const dump =
    records.length === 0
      ? ""
      : `${records
          .map((record) =>
            canonicalJson({
              offset: record.offset,
              payload: record.payload,
              ts: record.ts,
              type: record.type,
            }),
          )
          .join("\n")}\n`;
  return {
    headOffset: records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
    digest: stateDigest(state),
    dumpSha256: createHash("sha256").update(dump).digest("hex"),
    dump,
    state,
    records,
  };
}

export async function bootstrapPrState(
  streams: OfficialStreamAdapter,
  streamId: string,
): Promise<PrState> {
  const batch = await streams.applicationBootstrap(streamId);
  const records = batch.events.map(normalizeRecord);
  return records.reduce(prReducer, prInitialStateForStream(streamId));
}

export function openedPayload(fixture: PrHttpFixture, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    sourceBranch: fixture.sourceStream,
    targetBranch: fixture.mainStream,
    forkOffset: fixture.forkOffset,
    title: "Add the meadow",
    body: "A replayable proposal",
    author: "alice",
    ...overrides,
  };
}
