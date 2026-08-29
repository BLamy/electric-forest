import { readFileSync } from "node:fs";
import { emptyView } from "@eforest/identity";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  meadowPrInitialStateForStream,
  meadowPrReducer,
  type MergeBranch,
  type MergeStreamRecord,
  type PrMergeOperations,
} from "@eforest/meadow";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { fsInitialState, treeDigest, type FastForwardMergeReceipt } from "@eforest/streamfs";
import { describe, expect, it, vi } from "vitest";
import {
  OfficialStreamAdapter,
  PlatformGateway,
  WriterLaneDispatcher,
  createPlatformProductionRuntime,
  tokenHash,
  type AuthorizationVerifier,
  type StreamAdapter,
} from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const PR_STREAM = "pr:maple/reading-room/42";
const TARGET_STREAM = "fs:maple/reading-room:main:meta";
const SOURCE_STREAM = "fs:maple/reading-room:feature:meta";
const EVIDENCE_STREAM = "evidence:maple/reading-room/pr/42";
const RESULT_DIGEST = "a".repeat(64);
const at = offsetForOrdinal;
const STREAM_EVIDENCE = new URL(
  "../../../.eforest/tasks/epic-5-the-meadow/E5-T06-pr-merge-execution/evidence/streams/",
  import.meta.url,
);

function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
}

function canonicalDump(records: readonly unknown[]): string {
  return `${records.map(canonicalJson).join("\n")}\n`;
}

function committedDump(name: string): string {
  return readFileSync(new URL(name, STREAM_EVIDENCE), "utf8");
}

function record(
  ordinal: number,
  type: string,
  payload: Record<string, unknown>,
): MergeStreamRecord {
  return { ...event(type, payload, ordinal + 1), offset: at(ordinal) };
}

class MemoryStreams implements StreamAdapter {
  readonly streams = new Map<string, Array<Event & { readonly offset: Offset }>>();

  seed(streamId: string, records: readonly (Event & { readonly offset: Offset })[]): void {
    this.streams.set(streamId, [...records]);
  }

  async create(streamId: string): Promise<void> {
    this.streams.set(streamId, this.streams.get(streamId) ?? []);
  }

  async append(
    streamId: string,
    value: Event,
    options?: Parameters<StreamAdapter["append"]>[2],
  ): Promise<"appended"> {
    const records = this.streams.get(streamId) ?? [];
    const offset = options?.applicationOffset ?? at(records.length);
    records.push({ ...value, offset });
    this.streams.set(streamId, records);
    return "appended";
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    return [...(this.streams.get(streamId) ?? [])];
  }

  async readResolved(streamId: string): Promise<readonly unknown[]> {
    return this.read(streamId);
  }

  follow(): AsyncIterable<unknown> {
    return (async function* () {
      yield* [];
    })();
  }
}

class MemoryBranch implements MergeBranch {
  constructor(
    readonly metadataStreamId: string,
    readonly records: MergeStreamRecord[],
  ) {}

  async rawDump(): Promise<readonly MergeStreamRecord[]> {
    return [...this.records];
  }

  async treeAt() {
    return fsInitialState;
  }
}

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: "alice" }),
  authorizationContext: async () => ({
    principal: { kind: "identified", sub: "alice" },
    identity: emptyView(),
    identityOffset: "-1",
  }),
};

function allow(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "public" as const,
    streamId:
      input.target.kind === "repo" ||
      input.target.kind === "control" ||
      input.target.kind === "sandbox" ||
      input.target.kind === "internal"
        ? input.target.streamId
        : PR_STREAM,
  };
}

function mergeRequest(): Request {
  return new Request("https://platform.test/api/dispatch", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-eforest-dispatch-receipt": "offset",
    },
    body: JSON.stringify({
      streamId: PR_STREAM,
      event: event("pr.merge", { v: 1 }),
    }),
  });
}

describe("E5-T06 authenticated PR merge door", () => {
  it("executes the command, persists only the outcome, and serializes double dispatch", async () => {
    const streams = new MemoryStreams();
    streams.seed(PR_STREAM, [
      {
        ...event("pr.opened", {
          v: 1,
          sourceBranch: SOURCE_STREAM,
          targetBranch: TARGET_STREAM,
          forkOffset: at(0),
          title: "Merge feature",
          body: "Door test",
          author: "alice",
        }),
        offset: at(0),
      },
      { ...event("pr.approved", { v: 1, reviewer: "bob" }), offset: at(1) },
    ]);
    streams.seed(EVIDENCE_STREAM, [
      {
        ...event("evidence.linked", {
          v: 1,
          attachmentId: "replay",
          kind: "replay-recording",
          url: "https://app.replay.io/recording/test",
        }),
        offset: at(0),
      },
    ]);

    const target = new MemoryBranch(TARGET_STREAM, [
      record(0, "fs.branch.genesis", { v: 1, branch: "main" }),
    ]);
    const source = new MemoryBranch(SOURCE_STREAM, [
      record(0, "fs.branch.fork", {
        v: 1,
        parentStreamId: TARGET_STREAM,
        forkOffset: at(0),
      }),
    ]);
    const mergeFastForward = vi.fn(
      async (branch: MergeBranch): Promise<FastForwardMergeReceipt> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const persisted = record(1, "fs.branch.merge", {
          v: 1,
          sourceStreamId: SOURCE_STREAM,
          forkOffset: at(0),
          mergedThroughOffset: at(0),
        });
        (branch as MemoryBranch).records.push(persisted);
        return {
          mergeOffset: persisted.offset,
          mergedThroughOffset: at(0),
          treeDigest: RESULT_DIGEST,
        };
      },
    );
    const operations: Partial<PrMergeOperations> = { mergeFastForward };
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      prMerge: {
        resolveBranch: async (streamId) =>
          streamId === TARGET_STREAM ? target : streamId === SOURCE_STREAM ? source : undefined,
        operations,
        now: () => 42,
      },
    });

    const responses = await Promise.all([
      gateway.handle(mergeRequest()),
      gateway.handle(mergeRequest()),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([202, 409]);

    const accepted = responses.find(({ status }) => status === 202)!;
    expect(await accepted.json()).toEqual({
      ok: true,
      actor: "alice",
      identityOffset: "-1",
      offset: at(2),
    });
    const refused = responses.find(({ status }) => status === 409)!;
    expect(await refused.json()).toEqual({
      error: { class: "validator-rejected", reason: "pr/already-merged" },
    });

    const prRecords = (await streams.read(PR_STREAM)) as readonly (Event & {
      readonly offset: Offset;
    })[];
    expect(prRecords.filter(({ type }) => type === "pr.merge")).toHaveLength(0);
    expect(prRecords.filter(({ type }) => type === "pr.merged")).toHaveLength(1);
    expect(target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(1);
    expect(mergeFastForward).toHaveBeenCalledOnce();
    expect(prRecords.reduce(meadowPrReducer, meadowPrInitialStateForStream(PR_STREAM)).status).toBe(
      "merged",
    );
  });
});

const PRODUCTION_NOW = 1_800_000_000_000;
const PRODUCTION_SUBJECT = "auth0|e5-t06-recovery";
const PRODUCTION_SECRET = "e5-t06-production-recovery-secret-is-long-enough";

async function seedStream(
  streams: OfficialStreamAdapter,
  streamId: string,
  events: readonly Event[],
): Promise<void> {
  await streams.create(streamId);
  for (const [index, value] of events.entries()) {
    const offset = at(index);
    await streams.append(streamId, value, { sequence: offset, applicationOffset: offset });
  }
}

async function runProductionRecovery(
  crashPosition: "after-target" | "after-outcome",
): Promise<void> {
  const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const officialUrl = await official.start();
  const suffix = crashPosition === "after-target" ? "before-outcome" : "after-outcome";
  const prStream = `pr:maple/recovery-${suffix}/42`;
  const targetStream = `fs:maple/recovery-${suffix}:main:meta`;
  const sourceStream = `fs:maple/recovery-${suffix}:feature:meta`;
  const evidenceStream = `evidence:maple/recovery-${suffix}/pr/42`;
  const grantId = `grant-${suffix}`;
  const operationId = `merge-${suffix}`;
  const environment = {
    EF_OIDC_ISSUER: "https://issuer.example.test/",
    EF_OIDC_CLIENT_ID: "eforest-e5-t06",
    EF_SESSION_SECRET: PRODUCTION_SECRET,
    EF_SESSION_TTL: "60",
    EFOREST_SERVER_URL: officialUrl,
  };
  const first = await createPlatformProductionRuntime(environment, { now: () => PRODUCTION_NOW });
  let restarted: Awaited<ReturnType<typeof createPlatformProductionRuntime>> | undefined;
  try {
    await first.identity.login(
      PRODUCTION_SUBJECT,
      "e5-t06-recovery@example.test",
      `session-${suffix}`,
    );
    await first.identity.issueCliGrant({
      grantId,
      sub: PRODUCTION_SUBJECT,
      tokenKind: "web-mint",
      tokenHash: tokenHash(`token-${suffix}`),
      scopes: ["repo:write"],
    });

    const streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
    await seedStream(streams, targetStream, [
      event("fs.branch.genesis", { v: 1, branch: "main" }, PRODUCTION_NOW),
    ]);
    const targetBeforeMerge = await streams.readResolved(targetStream);
    await streams.append(
      targetStream,
      event(
        "fs.branch.merge",
        {
          v: 1,
          sourceStreamId: sourceStream,
          forkOffset: at(0),
          mergedThroughOffset: at(0),
        },
        PRODUCTION_NOW,
      ),
      { sequence: at(1), applicationOffset: at(1) },
    );
    await seedStream(streams, sourceStream, [
      event(
        "fs.branch.fork",
        { v: 1, parentStreamId: targetStream, forkOffset: at(0) },
        PRODUCTION_NOW,
      ),
    ]);
    await seedStream(streams, prStream, [
      event(
        "pr.opened",
        {
          v: 1,
          sourceBranch: sourceStream,
          targetBranch: targetStream,
          forkOffset: at(0),
          title: "Recover production merge",
          body: `Crash position ${crashPosition}`,
          author: PRODUCTION_SUBJECT,
        },
        PRODUCTION_NOW,
      ),
      event("pr.approved", { v: 1, reviewer: "reviewer" }, PRODUCTION_NOW),
    ]);
    const prBeforeOutcome = await streams.readResolved(prStream);
    await seedStream(streams, evidenceStream, [
      event(
        "evidence.linked",
        {
          v: 1,
          attachmentId: "stream-proof",
          kind: "replay-recording",
          url: "https://app.replay.io/recording/e5-t06-stream-proof",
        },
        PRODUCTION_NOW,
      ),
    ]);
    await first.identity.beginGrantOperation(grantId, operationId, {
      streamId: prStream,
      event: event("pr.merge", { v: 1, actor: PRODUCTION_SUBJECT }, PRODUCTION_NOW),
    });

    if (crashPosition === "after-outcome") {
      await new WriterLaneDispatcher(streams).dispatch(
        prStream,
        event(
          "pr.merged",
          {
            v: 1,
            targetMergeOffset: at(1),
            kind: "fast-forward",
            resultTreeDigest: treeDigest(fsInitialState),
          },
          PRODUCTION_NOW,
        ),
        PRODUCTION_SUBJECT,
        { operationId },
      );
    }

    await first.registry.stop();
    restarted = await createPlatformProductionRuntime(environment, { now: () => PRODUCTION_NOW });
    await restarted.identity.revokeCliGrant(grantId);

    const targetRecords = (await streams.readResolved(targetStream)) as readonly Event[];
    const prRecords = (await streams.readResolved(prStream)) as readonly Event[];
    expect(targetRecords.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(1);
    expect(prRecords.filter(({ type }) => type === "pr.merged")).toHaveLength(1);
    expect(prRecords.filter(({ type }) => type === "pr.merge")).toHaveLength(0);
    expect(prRecords.find(({ type }) => type === "pr.merged")?.payload).toMatchObject({
      actor: PRODUCTION_SUBJECT,
      writer: { v: 1, sub: PRODUCTION_SUBJECT, seq: 1, op: operationId },
    });
    expect(prRecords.reduce(meadowPrReducer, meadowPrInitialStateForStream(prStream)).status).toBe(
      "merged",
    );
    if (crashPosition === "after-target") {
      expect(canonicalDump(targetBeforeMerge)).toBe(committedDump("recovery-target-before.jsonl"));
      expect(canonicalDump(targetRecords)).toBe(committedDump("recovery-target-after.jsonl"));
      expect(canonicalDump(prBeforeOutcome)).toBe(committedDump("recovery-pr-before.jsonl"));
      expect(canonicalDump(prRecords)).toBe(committedDump("recovery-pr-after.jsonl"));
    }

    const identity = await restarted.identity.snapshot();
    expect(identity.view.grantOperations?.[operationId]?.status).toBe("completed");
    expect(identity.view.grants[grantId]?.status).toBe("revoked");
    expect(
      identity.events.filter(
        ({ type, payload }) =>
          type === "identity.grant.operation.completed" &&
          (payload as { readonly operationId?: string }).operationId === operationId,
      ),
    ).toHaveLength(1);
  } finally {
    await restarted?.registry.stop();
    await first.registry.stop();
    await official.stop();
  }
}

describe("E5-T06 production grant-aware recovery", () => {
  it("recovers a target-appended merge before the PR outcome without persisting pr.merge", async () => {
    await runProductionRecovery("after-target");
  });

  it("recognizes the operation outcome committed before journal completion", async () => {
    await runProductionRecovery("after-outcome");
  });
});
