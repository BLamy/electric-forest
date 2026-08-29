import { emptyView } from "@eforest/identity";
import {
  meadowPrInitialStateForStream,
  meadowPrReducer,
  type MergeBranch,
  type MergeStreamRecord,
  type PrMergeOperations,
} from "@eforest/meadow";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { issueInitialStateFor, reduceIssueApplicationEvent } from "@eforest/reducers";
import { fsInitialState, type FastForwardMergeReceipt } from "@eforest/streamfs";
import { describe, expect, it, vi } from "vitest";
import { PlatformGateway, type AuthorizationVerifier, type StreamAdapter } from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const PR_STREAM = "pr:maple/reading-room/42";
const ISSUE_STREAM = "issue:maple/reading-room/7";
const TARGET_STREAM = "fs:maple/reading-room:main:meta";
const SOURCE_STREAM = "fs:maple/reading-room:feature:meta";
const EVIDENCE_STREAM = "evidence:maple/reading-room/pr/42";
const RESULT_DIGEST = "a".repeat(64);
const at = offsetForOrdinal;

function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
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

function request(streamId: string, action: Event): Request {
  return new Request("https://platform.test/api/dispatch", {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify({ streamId, event: action }),
  });
}

function openedPr(closes = true): Event {
  return event("pr.opened", {
    v: 1,
    sourceBranch: SOURCE_STREAM,
    targetBranch: TARGET_STREAM,
    forkOffset: at(0),
    title: "Close the issue",
    body: "Cross-stream lifecycle",
    author: "alice",
    ...(closes ? { closes: [{ entity: "issue", stream: ISSUE_STREAM }] } : {}),
  });
}

function gatewayFixture() {
  const streams = new MemoryStreams();
  streams.seed(TARGET_STREAM, [
    { ...event("fs.branch.genesis", { v: 1, branch: "main" }), offset: at(0) },
  ]);
  streams.seed(SOURCE_STREAM, [
    {
      ...event("fs.branch.fork", {
        v: 1,
        parentStreamId: TARGET_STREAM,
        forkOffset: at(0),
      }),
      offset: at(0),
    },
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
  const mergeFastForward = vi.fn(async (branch: MergeBranch): Promise<FastForwardMergeReceipt> => {
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
  });
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
  return { gateway, streams, mergeFastForward };
}

describe("E5-T07 cross-entity dispatch wiring", () => {
  it("links on open, closes on merge once, and recovers the same trigger without appends", async () => {
    const { gateway, streams, mergeFastForward } = gatewayFixture();

    expect(
      (
        await gateway.handle(
          request(
            ISSUE_STREAM,
            event("issue.opened", { v: 1, title: "Linked issue", body: "Body" }),
          ),
        )
      ).status,
    ).toBe(202);
    expect((await gateway.handle(request(PR_STREAM, openedPr()))).status).toBe(202);

    let issueRecords = (await streams.read(ISSUE_STREAM)) as readonly (Event & {
      readonly offset: Offset;
    })[];
    expect(issueRecords.map(({ type }) => type)).toEqual(["issue.opened", "issue.linked"]);
    expect(issueRecords[1]).toMatchObject({
      payload: {
        by: { entity: "pr", stream: PR_STREAM },
        atOffset: at(0),
      },
    });

    expect(
      (await gateway.handle(request(PR_STREAM, event("pr.approved", { v: 1, reviewer: "bob" }))))
        .status,
    ).toBe(202);
    expect((await gateway.handle(request(PR_STREAM, event("pr.merge", { v: 1 })))).status).toBe(
      202,
    );

    issueRecords = (await streams.read(ISSUE_STREAM)) as readonly (Event & {
      readonly offset: Offset;
    })[];
    const prRecords = (await streams.read(PR_STREAM)) as readonly (Event & {
      readonly offset: Offset;
    })[];
    const merged = prRecords.find(({ type }) => type === "pr.merged")!;
    const closed = issueRecords.find(
      ({ type, payload }) =>
        type === "issue.state-changed" && (payload as { to?: unknown }).to === "done",
    )!;
    const backlink = prRecords.find(({ type }) => type === "pr.link-closed")!;
    expect(closed.payload).toMatchObject({
      via: { prStream: PR_STREAM, prMergedOffset: merged.offset },
    });
    expect(backlink.payload).toMatchObject({ issueOffset: closed.offset });
    expect(issueRecords.filter(({ type }) => type === "issue.state-changed")).toHaveLength(1);
    expect(prRecords.filter(({ type }) => type === "pr.link-closed")).toHaveLength(1);

    const issueState = issueRecords.reduce(reduceIssueApplicationEvent, issueInitialStateFor("7"));
    expect(issueState).toMatchObject({
      state: "done",
      closedBy: [{ prStream: PR_STREAM, prMergedOffset: merged.offset }],
    });
    const prState = prRecords.reduce(meadowPrReducer, meadowPrInitialStateForStream(PR_STREAM));
    expect(prState).toMatchObject({
      status: "merged",
      links: [{ state: "closed", issueOffset: closed.offset }],
    });

    const before = canonicalJson({ issueRecords, prRecords });
    const replay = await gateway.handle(request(PR_STREAM, event("pr.merge", { v: 1 })));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({
      error: { class: "validator-rejected", reason: "pr/already-merged" },
    });
    expect(
      canonicalJson({
        issueRecords: await streams.read(ISSUE_STREAM),
        prRecords: await streams.read(PR_STREAM),
      }),
    ).toBe(before);
    expect(mergeFastForward).toHaveBeenCalledOnce();

    const duplicate = await gateway.handle(
      request(
        ISSUE_STREAM,
        event("issue.state-changed", {
          v: 2,
          to: "done",
          via: { prStream: PR_STREAM, prMergedOffset: merged.offset },
        }),
      ),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: { class: "validator-rejected", reason: "link/duplicate-close" },
    });

    const duplicateBacklink = await gateway.handle(
      request(
        PR_STREAM,
        event("pr.link-closed", {
          v: 1,
          ref: { entity: "issue", stream: ISSUE_STREAM },
          issueOffset: closed.offset,
        }),
      ),
    );
    expect(duplicateBacklink.status).toBe(409);
    expect(await duplicateBacklink.json()).toEqual({
      error: { class: "validator-rejected", reason: "pr/link-duplicate" },
    });
  });

  it("keeps issue history byte-identical when a PR closes without merging", async () => {
    const { gateway, streams } = gatewayFixture();
    expect(
      (
        await gateway.handle(
          request(ISSUE_STREAM, event("issue.opened", { v: 1, title: "Stay open", body: "Body" })),
        )
      ).status,
    ).toBe(202);
    expect((await gateway.handle(request(PR_STREAM, openedPr()))).status).toBe(202);
    const before = canonicalJson(await streams.read(ISSUE_STREAM));
    expect(
      (await gateway.handle(request(PR_STREAM, event("pr.closed", { v: 1, closedBy: "alice" }))))
        .status,
    ).toBe(202);
    expect(canonicalJson(await streams.read(ISSUE_STREAM))).toBe(before);
  });
});
