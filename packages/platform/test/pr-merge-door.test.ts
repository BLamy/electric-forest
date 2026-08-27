import { emptyView } from "@eforest/identity";
import {
  meadowPrInitialStateForStream,
  meadowPrReducer,
  type MergeBranch,
  type MergeStreamRecord,
  type PrMergeOperations,
} from "@eforest/meadow";
import { type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { fsInitialState, type FastForwardMergeReceipt } from "@eforest/streamfs";
import { describe, expect, it, vi } from "vitest";
import { PlatformGateway, type AuthorizationVerifier, type StreamAdapter } from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const PR_STREAM = "pr:maple/reading-room/42";
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
