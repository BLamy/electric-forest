import { emptyView } from "@eforest/identity";
import {
  meadowPrReducer,
  meadowPrInitialStateForStream,
  type MergeBranch,
  type MergeStreamRecord,
  type PrMergeHooks,
} from "@eforest/meadow";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { fsInitialState, type FastForwardMergeReceipt } from "@eforest/streamfs";
import { describe, expect, it, vi } from "vitest";
import { PlatformGateway, type AuthorizationVerifier, type StreamAdapter } from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const PR_STREAM = "pr:maple/reading-room/42";
const OTHER_PR_STREAM = "pr:maple/reading-room/99";
const ISSUE_A = "issue:maple/reading-room/7";
const ISSUE_B = "issue:maple/reading-room/8";
const CROSS_REPO_ISSUE = "issue:maple/other-room/9";
const DANGLING = "issue:maple/reading-room/missing";
const TARGET_STREAM = "fs:maple/reading-room:main:meta";
const SOURCE_STREAM = "fs:maple/reading-room:feature:meta";
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

type PersistedEvent = Event & { readonly offset: Offset };
type AppendFault = (streamId: string, value: Event) => boolean;

class HostileMemoryStreams implements StreamAdapter {
  readonly streams = new Map<string, PersistedEvent[]>();
  private appendFault: AppendFault | undefined;
  private readonly afterRead = new Map<string, () => void>();

  seed(streamId: string, records: readonly PersistedEvent[]): void {
    this.streams.set(streamId, [...records]);
  }

  remove(streamId: string): void {
    this.streams.delete(streamId);
  }

  inject(streamId: string, value: Event): Offset {
    const records = this.streams.get(streamId) ?? [];
    const offset = at(records.length);
    records.push({ ...value, offset });
    this.streams.set(streamId, records);
    return offset;
  }

  failNextAppend(predicate: AppendFault): void {
    this.appendFault = predicate;
  }

  mutateAfterNextRead(streamId: string, mutation: () => void): void {
    this.afterRead.set(streamId, mutation);
  }

  async create(streamId: string): Promise<void> {
    this.streams.set(streamId, this.streams.get(streamId) ?? []);
  }

  async exists(streamId: string): Promise<boolean> {
    return this.streams.has(streamId);
  }

  async append(
    streamId: string,
    value: Event,
    options?: Parameters<StreamAdapter["append"]>[2],
  ): Promise<"appended"> {
    if (this.appendFault?.(streamId, value) === true) {
      this.appendFault = undefined;
      throw new Error("injected-link-propagation-crash");
    }
    const records = this.streams.get(streamId) ?? [];
    const offset = options?.applicationOffset ?? at(records.length);
    records.push({ ...value, offset });
    this.streams.set(streamId, records);
    return "appended";
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    const snapshot = [...(this.streams.get(streamId) ?? [])];
    const mutation = this.afterRead.get(streamId);
    if (mutation !== undefined) {
      this.afterRead.delete(streamId);
      mutation();
    }
    return snapshot;
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

interface HarnessState {
  readonly streams: HostileMemoryStreams;
  readonly target: MemoryBranch;
  readonly source: MemoryBranch;
  readonly mergeFastForward: ReturnType<typeof vi.fn>;
}

function evidenceStreamFor(prStream: string): string {
  return `evidence:maple/reading-room/pr/${prStream.slice(prStream.lastIndexOf("/") + 1)}`;
}

function seedEvidence(streams: HostileMemoryStreams, prStream: string): void {
  streams.seed(evidenceStreamFor(prStream), [
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
}

function harnessState(): HarnessState {
  const streams = new HostileMemoryStreams();
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
  seedEvidence(streams, PR_STREAM);
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
  return { streams, target, source, mergeFastForward };
}

function gatewayFor(
  state: HarnessState,
  hooks?: PrMergeHooks,
  authorizationVerifier: AuthorizationVerifier = verifier,
): PlatformGateway {
  return new PlatformGateway({
    verifier: authorizationVerifier,
    streams: state.streams,
    decideAuthorization: allow,
    namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    prMerge: {
      resolveBranch: async (streamId) =>
        streamId === TARGET_STREAM
          ? state.target
          : streamId === SOURCE_STREAM
            ? state.source
            : undefined,
      operations: { mergeFastForward: state.mergeFastForward },
      now: () => 42,
      ...(hooks === undefined ? {} : { hooks }),
    },
  });
}

function request(streamId: string, action: Event): Request {
  return new Request("https://platform.test/api/dispatch", {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify({ streamId, event: action }),
  });
}

function ref(stream: string) {
  return { entity: "issue" as const, stream };
}

function openedPr(refs: readonly ReturnType<typeof ref>[], title = "Close issues"): Event {
  return event("pr.opened", {
    v: 1,
    sourceBranch: SOURCE_STREAM,
    targetBranch: TARGET_STREAM,
    forkOffset: at(0),
    title,
    body: "Cross-stream lifecycle",
    author: "alice",
    closes: refs,
  });
}

async function dispatch(gateway: PlatformGateway, streamId: string, action: Event) {
  return gateway.handle(request(streamId, action));
}

async function openIssue(gateway: PlatformGateway, streamId: string): Promise<void> {
  const response = await dispatch(
    gateway,
    streamId,
    event("issue.opened", { v: 1, title: streamId, body: "Body" }),
  );
  expect(response.status, await response.text()).toBe(202);
}

async function openAndApprove(
  gateway: PlatformGateway,
  refs: readonly ReturnType<typeof ref>[],
  prStream = PR_STREAM,
): Promise<void> {
  const opened = await dispatch(gateway, prStream, openedPr(refs));
  const openedBody = await opened.text();
  expect(opened.status, openedBody).toBe(202);
  const approved = await dispatch(
    gateway,
    prStream,
    event("pr.approved", { v: 1, reviewer: "bob" }),
  );
  const approvedBody = await approved.text();
  expect(approved.status, approvedBody).toBe(202);
}

function records(state: HarnessState, streamId: string): readonly PersistedEvent[] {
  return state.streams.streams.get(streamId) ?? [];
}

function countType(state: HarnessState, streamId: string, type: string): number {
  return records(state, streamId).filter((candidate) => candidate.type === type).length;
}

describe("E5-T07 hostile cross-entity recovery", () => {
  it("target-boundary: rejects wrong-kind, missing, cross-repo, and unknown-kind refs atomically", async () => {
    const state = harnessState();
    const gateway = gatewayFor(state);
    await openIssue(gateway, ISSUE_A);
    await openIssue(gateway, CROSS_REPO_ISSUE);
    state.streams.seed(OTHER_PR_STREAM, [
      {
        ...openedPr([], "Existing other PR"),
        offset: at(0),
      },
    ]);
    const issueBefore = canonicalJson(records(state, ISSUE_A));
    const crossRepoBefore = canonicalJson(records(state, CROSS_REPO_ISSUE));
    const wrongPrBefore = canonicalJson(records(state, OTHER_PR_STREAM));

    const expectAtomicRefusal = async (action: Event) => {
      const response = await dispatch(gateway, PR_STREAM, action);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: { class: "schema-violation" } });
      expect(records(state, PR_STREAM)).toEqual([]);
      expect(canonicalJson(records(state, ISSUE_A))).toBe(issueBefore);
      expect(canonicalJson(records(state, CROSS_REPO_ISSUE))).toBe(crossRepoBefore);
      expect(canonicalJson(records(state, OTHER_PR_STREAM))).toBe(wrongPrBefore);
      expect(state.streams.streams.has(DANGLING)).toBe(false);
      expect(countType(state, ISSUE_A, "issue.linked")).toBe(0);
    };

    await expectAtomicRefusal(openedPr([ref(ISSUE_A), ref(OTHER_PR_STREAM)]));
    await expectAtomicRefusal(openedPr([ref(ISSUE_A), ref(DANGLING)]));
    await expectAtomicRefusal(openedPr([ref(ISSUE_A), ref(CROSS_REPO_ISSUE)]));

    const unknownKind = openedPr([ref(ISSUE_A)]);
    await expectAtomicRefusal({
      ...unknownKind,
      payload: {
        ...unknownKind.payload,
        closes: [{ entity: "wiki", stream: ISSUE_A }],
      },
    });
  });

  it("operation-id target boundary refuses a disappeared issue before writer recovery", async () => {
    const state = harnessState();
    await openIssue(gatewayFor(state), ISSUE_A);
    const identity = { sub: "alice" } as const;
    const operationId = "e5-t07-target-boundary";
    let authorizedMutationCalls = 0;
    const operationVerifier: AuthorizationVerifier = {
      verifyAuthorization: async () => identity,
      withAuthorizedMutation: async (_header, plan, mutation) => {
        authorizedMutationCalls += 1;
        const planned = await plan(identity, operationId);
        expect(planned.streamId).toBe(PR_STREAM);
        return mutation(identity, operationId, async () => undefined);
      },
    };
    const gateway = gatewayFor(state, undefined, operationVerifier);
    const action = openedPr([ref(ISSUE_A)]);

    expect((await dispatch(gateway, PR_STREAM, action)).status).toBe(202);
    expect(authorizedMutationCalls).toBe(1);
    const writer = (
      records(state, PR_STREAM)[0]?.payload as { readonly writer?: { readonly op?: string } }
    ).writer;
    expect(writer?.op).toBe(operationId);
    state.streams.remove(ISSUE_A);
    const prBefore = canonicalJson(records(state, PR_STREAM));

    const response = await dispatch(gateway, PR_STREAM, action);
    expect(response.status, "E5_T07_OPERATION_ID_TARGET_BOUNDARY").toBe(422);
    expect(await response.json()).toEqual({ error: { class: "schema-violation" } });
    expect(authorizedMutationCalls).toBe(1);
    expect(canonicalJson(records(state, PR_STREAM))).toBe(prBefore);
    expect(state.streams.streams.has(ISSUE_A)).toBe(false);
  });

  it("operation-id recovery writer fence revalidates a target removed after preflight", async () => {
    const state = harnessState();
    const gateway = gatewayFor(state);
    await openIssue(gateway, ISSUE_A);
    await openIssue(gateway, ISSUE_B);
    const issueABefore = canonicalJson(records(state, ISSUE_A));
    state.streams.mutateAfterNextRead(ISSUE_B, () => state.streams.remove(ISSUE_B));
    const opened = openedPr([ref(ISSUE_A), ref(ISSUE_B)]);
    const recoveredEvent = {
      ...opened,
      payload: { ...(opened.payload as Record<string, unknown>), actor: "alice" },
    };

    await expect(
      gateway.recoverPrOpenedGrantOperation(
        "e5-t07-recovery-writer-fence",
        PR_STREAM,
        recoveredEvent,
      ),
    ).rejects.toThrow("schema-violation");
    expect(records(state, PR_STREAM), "E5_T07_RECOVERY_WRITER_FENCE").toEqual([]);
    expect(canonicalJson(records(state, ISSUE_A))).toBe(issueABefore);
    expect(countType(state, ISSUE_A, "issue.linked")).toBe(0);
    expect(state.streams.streams.has(ISSUE_B)).toBe(false);
  });

  it("partial-propagation: a restarted duplicate open completes every unpropagated ref once", async () => {
    const state = harnessState();
    let gateway = gatewayFor(state);
    await openIssue(gateway, ISSUE_A);
    await openIssue(gateway, ISSUE_B);
    state.streams.failNextAppend(
      (streamId, action) => streamId === ISSUE_B && action.type === "issue.linked",
    );

    const first = await dispatch(gateway, PR_STREAM, openedPr([ref(ISSUE_A), ref(ISSUE_B)]));
    expect(first.status).toBe(503);
    expect(countType(state, PR_STREAM, "pr.opened")).toBe(1);
    expect(countType(state, ISSUE_A, "issue.linked")).toBe(1);
    expect(countType(state, ISSUE_B, "issue.linked")).toBe(0);

    gateway = gatewayFor(state);
    const recovered = await dispatch(gateway, PR_STREAM, openedPr([ref(ISSUE_A), ref(ISSUE_B)]));
    expect(recovered.status).toBe(409);
    expect(await recovered.json()).toEqual({
      error: { class: "validator-rejected", reason: "pr/already-opened" },
    });
    expect(countType(state, PR_STREAM, "pr.opened")).toBe(1);
    expect(countType(state, ISSUE_A, "issue.linked")).toBe(1);
    expect(countType(state, ISSUE_B, "issue.linked")).toBe(1);

    const complete = canonicalJson({
      pr: records(state, PR_STREAM),
      a: records(state, ISSUE_A),
      b: records(state, ISSUE_B),
    });
    expect(
      (await dispatch(gateway, PR_STREAM, openedPr([ref(ISSUE_A), ref(ISSUE_B)]))).status,
    ).toBe(409);
    expect(
      canonicalJson({
        pr: records(state, PR_STREAM),
        a: records(state, ISSUE_A),
        b: records(state, ISSUE_B),
      }),
    ).toBe(complete);
  });

  it("crash-window target-to-PR: restart recovers the merge outcome and both links", async () => {
    const state = harnessState();
    let gateway = gatewayFor(state, {
      afterTargetAppend: () => {
        throw new Error("crash-after-target-append");
      },
    });
    await openIssue(gateway, ISSUE_A);
    await openAndApprove(gateway, [ref(ISSUE_A)]);

    expect((await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }))).status).not.toBe(202);
    expect(state.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(1);
    expect(countType(state, PR_STREAM, "pr.merged")).toBe(0);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(0);

    gateway = gatewayFor(state);
    expect((await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }))).status).toBe(202);
    expect(state.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(1);
    expect(countType(state, PR_STREAM, "pr.merged")).toBe(1);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(1);
    expect(countType(state, PR_STREAM, "pr.link-closed")).toBe(1);
    expect(state.mergeFastForward).toHaveBeenCalledOnce();
  });

  it("crash-window PR-to-issue: duplicate merge recovers one close and one backlink", async () => {
    const state = harnessState();
    let gateway = gatewayFor(state);
    await openIssue(gateway, ISSUE_A);
    await openAndApprove(gateway, [ref(ISSUE_A)]);
    state.streams.failNextAppend(
      (streamId, action) => streamId === ISSUE_A && action.type === "issue.state-changed",
    );

    expect((await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }))).status).toBe(503);
    expect(countType(state, PR_STREAM, "pr.merged")).toBe(1);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(0);

    gateway = gatewayFor(state);
    const recovered = await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }));
    expect(recovered.status).toBe(409);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(1);
    expect(countType(state, PR_STREAM, "pr.link-closed")).toBe(1);
  });

  it("crash-window issue-to-PR: duplicate merge recovers only the missing backlink", async () => {
    const state = harnessState();
    let gateway = gatewayFor(state);
    await openIssue(gateway, ISSUE_A);
    await openAndApprove(gateway, [ref(ISSUE_A)]);
    state.streams.failNextAppend(
      (streamId, action) => streamId === PR_STREAM && action.type === "pr.link-closed",
    );

    expect((await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }))).status).toBe(503);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(1);
    expect(countType(state, PR_STREAM, "pr.link-closed")).toBe(0);

    gateway = gatewayFor(state);
    const recovered = await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }));
    expect(recovered.status).toBe(409);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(1);
    expect(countType(state, PR_STREAM, "pr.link-closed")).toBe(1);
  });

  it("fence-replan: an issue write after planning is preserved and the close lands once", async () => {
    const state = harnessState();
    const gateway = gatewayFor(state);
    await openIssue(gateway, ISSUE_A);
    await openAndApprove(gateway, [ref(ISSUE_A)]);
    state.streams.mutateAfterNextRead(ISSUE_A, () => {
      state.streams.inject(
        ISSUE_A,
        event("issue.commented", { v: 1, commentId: "racing-comment", body: "wins fence" }),
      );
    });

    expect((await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }))).status).toBe(202);
    expect(records(state, ISSUE_A).map(({ type }) => type)).toEqual([
      "issue.opened",
      "issue.linked",
      "issue.commented",
      "issue.state-changed",
    ]);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(1);
    expect(countType(state, PR_STREAM, "pr.link-closed")).toBe(1);
  });

  it("multi-ref + idempotence: 200 refs, a duplicate, and a dangling ref converge in order", async () => {
    const state = harnessState();
    const gateway = gatewayFor(state);
    const issueStreams = Array.from(
      { length: 200 },
      (_, index) => `issue:maple/reading-room/bulk-${String(index).padStart(3, "0")}`,
    );
    for (const streamId of issueStreams) {
      await openIssue(gateway, streamId);
    }
    const refs = [...issueStreams.map(ref), ref(issueStreams[0]!)] as const;

    const opened = await dispatch(gateway, PR_STREAM, openedPr(refs));
    const openedBody = await opened.text();
    expect(
      opened.status,
      `${openedBody}; linked=${String(
        issueStreams.filter((streamId) => countType(state, streamId, "issue.linked") === 1).length,
      )}; pr=${records(state, PR_STREAM)
        .map(({ type }) => type)
        .join(",")}`,
    ).toBe(202);
    expect(
      (await dispatch(gateway, PR_STREAM, event("pr.approved", { v: 1, reviewer: "bob" }))).status,
    ).toBe(202);
    expect((await dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }))).status).toBe(202);

    for (const streamId of issueStreams) {
      expect(countType(state, streamId, "issue.linked"), streamId).toBe(1);
      expect(countType(state, streamId, "issue.state-changed"), streamId).toBe(1);
    }
    const backlinks = records(state, PR_STREAM).filter(({ type }) => type === "pr.link-closed");
    expect(
      backlinks.map(({ payload }) => (payload as { ref: { stream: string } }).ref.stream),
    ).toEqual(issueStreams);
    const noops = records(state, PR_STREAM).filter(({ type }) => type === "pr.link-noop");
    expect(noops).toHaveLength(0);

    const snapshot = () => ({
      pr: records(state, PR_STREAM),
      issues: issueStreams.map((streamId) => ({ streamId, records: records(state, streamId) })),
    });
    const before = canonicalJson(snapshot());
    const replays = await Promise.all(
      Array.from({ length: 8 }, () => dispatch(gateway, PR_STREAM, event("pr.merge", { v: 1 }))),
    );
    expect(replays.map(({ status }) => status)).toEqual(Array.from({ length: 8 }, () => 409));
    expect(canonicalJson(snapshot())).toBe(before);

    const reduced = records(state, PR_STREAM).reduce(
      meadowPrReducer,
      meadowPrInitialStateForStream(PR_STREAM),
    );
    expect(reduced.links).toHaveLength(200);
  });

  it("close-without-merge: a closed PR is inert and a different merged PR closes once", async () => {
    const state = harnessState();
    const gateway = gatewayFor(state);
    await openIssue(gateway, ISSUE_A);
    expect((await dispatch(gateway, PR_STREAM, openedPr([ref(ISSUE_A)]))).status).toBe(202);
    const beforeClose = canonicalJson(records(state, ISSUE_A));
    expect(
      (await dispatch(gateway, PR_STREAM, event("pr.closed", { v: 1, closedBy: "alice" }))).status,
    ).toBe(202);
    expect(canonicalJson(records(state, ISSUE_A))).toBe(beforeClose);

    seedEvidence(state.streams, OTHER_PR_STREAM);
    await openAndApprove(gateway, [ref(ISSUE_A)], OTHER_PR_STREAM);
    expect((await dispatch(gateway, OTHER_PR_STREAM, event("pr.merge", { v: 1 }))).status).toBe(
      202,
    );
    expect(countType(state, ISSUE_A, "issue.linked")).toBe(2);
    expect(countType(state, ISSUE_A, "issue.state-changed")).toBe(1);
    const close = records(state, ISSUE_A).find(({ type }) => type === "issue.state-changed")!;
    expect(close.payload).toMatchObject({ via: { prStream: OTHER_PR_STREAM } });
    expect(countType(state, PR_STREAM, "pr.link-closed")).toBe(0);
    expect(countType(state, OTHER_PR_STREAM, "pr.link-closed")).toBe(1);
  });
});
