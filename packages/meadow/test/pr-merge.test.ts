import { readFileSync } from "node:fs";
import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { attachmentInitialStateForStream, type AttachmentListState } from "@eforest/evidence";
import {
  fsInitialState,
  ThreeWayMergeError,
  treeDigest,
  type FastForwardMergeReceipt,
  type FsTree,
  type ThreeWayMergePlan,
  type ThreeWayMergeReceipt,
} from "@eforest/streamfs";
import { describe, expect, it, vi } from "vitest";
import {
  PrMergeRefusalError,
  PrMergeSchemaError,
  executeMerge,
  meadowPrReducer,
  validatePrMergeCommand,
  validatePrMergeOutcome,
  type MeadowPrMergeOutcomeEvent,
  type MeadowPrState,
  type MergeBranch,
  type MergeStreamRecord,
  type PrMergeExecutorContext,
  type PrMergeHooks,
  type PrMergeOperations,
} from "../src/index.js";

const PR_STREAM = "pr:maple/reading-room/42";
const TARGET_STREAM = "fs:maple/reading-room:main:meta";
const SOURCE_STREAM = "fs:maple/reading-room:feature:meta";
const EVIDENCE_STREAM = "evidence:maple/reading-room/pr/42";
const FORK = offsetForOrdinal(1);
const RESULT_DIGEST = "a".repeat(64);

function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
}

function record(
  ordinal: number,
  type: string,
  payload: Record<string, unknown>,
): MergeStreamRecord {
  return { ...event(type, payload, ordinal), offset: offsetForOrdinal(ordinal) };
}

function approvedState(status: MeadowPrState["status"] = "approved"): MeadowPrState {
  return {
    v: 1,
    status,
    sourceBranch: SOURCE_STREAM,
    targetBranch: TARGET_STREAM,
    forkOffset: FORK,
    title: "Merge feature",
    body: "Body",
    author: "alice",
    approvals: status === "approved" ? ["reviewer"] : [],
    reviews: [],
    threads: [],
    openedAtOffset: offsetForOrdinal(0),
    resolvedAtOffset:
      status === "merged" || status === "closed" ? offsetForOrdinal(3) : OFFSET_BEFORE_FIRST,
  };
}

function evidenceState(active = true): AttachmentListState {
  const initial = attachmentInitialStateForStream(EVIDENCE_STREAM);
  return {
    ...initial,
    attachments: active
      ? [
          {
            attachmentId: "recording",
            type: "reference",
            kind: "replay-recording",
            url: "https://app.replay.io/recording/abc",
            attachedAtOffset: offsetForOrdinal(0),
          },
        ]
      : [],
  };
}

class MemoryBranch implements MergeBranch {
  constructor(
    readonly metadataStreamId: string,
    readonly records: MergeStreamRecord[],
    private readonly tree: FsTree = fsInitialState,
  ) {}

  async rawDump(): Promise<readonly MergeStreamRecord[]> {
    return [...this.records];
  }

  async treeAt(): Promise<FsTree> {
    return this.tree;
  }

  append(type: string, payload: Record<string, unknown>): MergeStreamRecord {
    const next = record(this.records.length, type, payload);
    this.records.push(next);
    return next;
  }
}

class MemoryContext implements PrMergeExecutorContext {
  readonly target = new MemoryBranch(TARGET_STREAM, [
    record(0, "fs.branch.genesis", { v: 1, branch: "main" }),
    record(1, "fs.dir.create", { v: 2, path: "src" }),
  ]);
  readonly source = new MemoryBranch(SOURCE_STREAM, [
    record(0, "fs.branch.fork", { v: 1, parentStreamId: TARGET_STREAM, forkOffset: FORK }),
  ]);
  readonly prRecords: Array<Event & { readonly offset: Offset }> = [];
  state = approvedState();
  evidence = evidenceState();
  evidenceRecords: Event[] = [];
  hooks?: PrMergeHooks;
  operations: Partial<PrMergeOperations>;
  private prHead = offsetForOrdinal(10);

  constructor(operations: Partial<PrMergeOperations>) {
    this.operations = operations;
  }

  async readPr() {
    return { state: this.state, records: [...this.prRecords], headOffset: this.prHead };
  }

  async readEvidence(streamId: string) {
    expect(streamId).toBe(EVIDENCE_STREAM);
    return { state: this.evidence, records: [...this.evidenceRecords] };
  }

  async resolveBranch(streamId: string) {
    return streamId === TARGET_STREAM
      ? this.target
      : streamId === SOURCE_STREAM
        ? this.source
        : undefined;
  }

  async appendPrOutcome(
    _streamId: string,
    outcome: MeadowPrMergeOutcomeEvent,
    expectedHead: Offset,
  ) {
    if (expectedHead !== this.prHead) throw new Error("pr/head-advanced");
    const next = offsetForOrdinal(Number(this.prHead.split("_")[1]) + 1);
    const persisted = { ...outcome, offset: next };
    this.prRecords.push(persisted);
    this.state = meadowPrReducer(this.state, persisted);
    this.prHead = next;
    return { offset: next };
  }

  readonly now = () => 42;
}

function fastForwardOperations(
  delay = false,
): Required<Pick<PrMergeOperations, "mergeFastForward">> {
  return {
    mergeFastForward: vi.fn(async (target): Promise<FastForwardMergeReceipt> => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, 5));
      const branch = target as MemoryBranch;
      const merge = branch.append("fs.branch.merge", {
        v: 1,
        sourceStreamId: SOURCE_STREAM,
        forkOffset: FORK,
        mergedThroughOffset: FORK,
      });
      return { mergeOffset: merge.offset, mergedThroughOffset: FORK, treeDigest: RESULT_DIGEST };
    }),
  };
}

function fakePlan(
  targetOffset: Offset,
  conflicts: ThreeWayMergePlan["conflicts"] = [],
): ThreeWayMergePlan {
  return {
    kind: "three-way",
    mergeId: "merge-1",
    base: { streamId: TARGET_STREAM, offset: FORK, treeDigest: RESULT_DIGEST },
    target: { streamId: TARGET_STREAM, offset: targetOffset, treeDigest: RESULT_DIGEST },
    source: { streamId: SOURCE_STREAM, offset: offsetForOrdinal(0), treeDigest: RESULT_DIGEST },
    forkOffset: FORK,
    changes: [],
    contentDependencies: [],
    conflicts,
    events: [event("fs.branch.merge", { v: 2 })],
    firstOffset: offsetForOrdinal(3),
    terminalOffset: offsetForOrdinal(3),
    resultTreeDigest: RESULT_DIGEST,
  } as unknown as ThreeWayMergePlan;
}

function threeWayOperations(
  conflicts: ThreeWayMergeReceipt["conflicts"] = [],
): Required<Pick<PrMergeOperations, "planThreeWayMerge" | "applyThreeWayMerge">> {
  const planThreeWayMerge = vi.fn(async (target: MergeBranch) => {
    const head = (await target.rawDump()).at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
    return fakePlan(head);
  });
  const applyThreeWayMerge = vi.fn(async (target: MergeBranch, _source, plan) => {
    const branch = target as MemoryBranch;
    const payloadConflicts = conflicts.map(({ path, kind, reason }) => ({
      v: 1,
      mergeId: "merge-1",
      path,
      kind,
      reason,
      base: {
        streamId: TARGET_STREAM,
        offset: FORK,
        treeDigest: RESULT_DIGEST,
        node: { kind: "missing", path },
      },
      target: {
        streamId: TARGET_STREAM,
        offset: plan.target.offset,
        treeDigest: RESULT_DIGEST,
        node: { kind: "missing", path },
      },
      source: {
        streamId: SOURCE_STREAM,
        offset: plan.source.offset,
        treeDigest: RESULT_DIGEST,
        node: { kind: "missing", path },
      },
    }));
    const merge = branch.append("fs.branch.merge", {
      v: 2,
      kind: "three-way",
      mergeId: "merge-1",
      targetStreamId: TARGET_STREAM,
      sourceStreamId: SOURCE_STREAM,
      forkOffset: FORK,
      mergedThroughOffset: plan.source.offset,
      sourceHeadOffset: plan.source.offset,
      targetHeadOffset: plan.target.offset,
      baseTreeDigest: RESULT_DIGEST,
      targetTreeDigest: RESULT_DIGEST,
      sourceTreeDigest: RESULT_DIGEST,
      resultTreeDigest: RESULT_DIGEST,
      changes: [],
      conflicts: payloadConflicts,
    });
    return {
      kind: "three-way",
      mergeId: "merge-1",
      mergeOffset: merge.offset,
      resultTreeDigest: RESULT_DIGEST,
      conflicts,
    } satisfies ThreeWayMergeReceipt;
  });
  return { planThreeWayMerge, applyThreeWayMerge };
}

describe("PR merge event and reducer contracts", () => {
  it("rejects malformed commands and outcomes at the Meadow door", () => {
    expect(() => validatePrMergeCommand(event("pr.merge", { v: 1 }))).not.toThrow();
    expect(() => validatePrMergeCommand(event("pr.merge", { v: 1, extra: true }))).toThrow(
      PrMergeSchemaError,
    );
    expect(() =>
      validatePrMergeOutcome(
        event("pr.merged", {
          v: 1,
          targetMergeOffset: offsetForOrdinal(2),
          kind: "fast-forward",
          resultTreeDigest: RESULT_DIGEST,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validatePrMergeOutcome(
        event("pr.merge-conflicted", {
          v: 1,
          targetMergeOffset: offsetForOrdinal(2),
          conflicts: [],
        }),
      ),
    ).toThrow(PrMergeSchemaError);
  });

  it("makes merged terminal and requires a fresh approval after conflict", () => {
    const conflicted = meadowPrReducer(approvedState(), {
      ...event("pr.merge-conflicted", {
        v: 1,
        targetMergeOffset: offsetForOrdinal(3),
        conflicts: [{ path: "README.md", kind: "edit-edit" }],
      }),
      offset: offsetForOrdinal(11),
    });
    expect(conflicted.status).toBe("conflicted");
    expect(conflicted.approvals).toEqual([]);
    const reapproved = meadowPrReducer(conflicted, {
      ...event("pr.approved", { v: 1, reviewer: "reviewer" }),
      offset: offsetForOrdinal(12),
    });
    expect(reapproved.status).toBe("approved");
    const merged = meadowPrReducer(reapproved, {
      ...event("pr.merged", {
        v: 1,
        targetMergeOffset: offsetForOrdinal(4),
        kind: "three-way",
        resultTreeDigest: RESULT_DIGEST,
      }),
      offset: offsetForOrdinal(13),
    });
    expect(merged.status).toBe("merged");
    expect(
      meadowPrReducer(merged, {
        ...event("pr.approved", { v: 1, reviewer: "other" }),
        offset: offsetForOrdinal(14),
      }),
    ).toEqual(merged);
  });

  it.each([
    [
      "pr.merged",
      {
        v: 1,
        targetMergeOffset: offsetForOrdinal(3),
        kind: "fast-forward",
        resultTreeDigest: RESULT_DIGEST,
      },
      "merged",
    ],
    [
      "pr.merge-conflicted",
      {
        v: 1,
        targetMergeOffset: offsetForOrdinal(3),
        conflicts: [{ path: "README.md", kind: "edit-edit" }],
      },
      "conflicted",
    ],
  ] as const)(
    "reduces server-stamped %s while keeping client schemas exact",
    (type, payload, status) => {
      const stamped = {
        ...event(type, { ...payload, actor: "alice", writer: "browser-session" }),
        offset: offsetForOrdinal(11),
      };

      expect(meadowPrReducer(approvedState(), stamped)).toMatchObject({
        status,
        mergeOutcome: payload,
      });
      expect(() => validatePrMergeOutcome(stamped)).toThrow(PrMergeSchemaError);
    },
  );
});

describe("executeMerge", () => {
  it("selects fast-forward only when the target has no event greater than forkOffset", async () => {
    const ff = fastForwardOperations();
    const plan = vi.fn();
    const context = new MemoryContext({ ...ff, planThreeWayMerge: plan });
    const receipt = await executeMerge(context, PR_STREAM);

    expect(receipt).toMatchObject({
      recovered: false,
      outcome: { type: "pr.merged" },
      prOutcomeOffset: context.prRecords.at(-1)!.offset,
    });
    expect(receipt.outcome.payload).toMatchObject({
      kind: "fast-forward",
      resultTreeDigest: RESULT_DIGEST,
    });
    expect(ff.mergeFastForward).toHaveBeenCalledOnce();
    expect(plan).not.toHaveBeenCalled();
    expect(context.state.status).toBe("merged");
  });

  it("selects plan/apply three-way after exactly one target advance", async () => {
    const operations = threeWayOperations();
    const ff = vi.fn();
    const context = new MemoryContext({ ...operations, mergeFastForward: ff });
    context.target.append("fs.file.write", { v: 2, path: "README.md", content: "target" });

    const receipt = await executeMerge(context, PR_STREAM);

    expect(receipt.outcome).toMatchObject({
      type: "pr.merged",
      payload: { kind: "three-way", resultTreeDigest: RESULT_DIGEST },
    });
    expect(operations.planThreeWayMerge).toHaveBeenCalledOnce();
    expect(operations.applyThreeWayMerge).toHaveBeenCalledOnce();
    expect(ff).not.toHaveBeenCalled();
  });

  it("mirrors ordered StreamFS conflicts and transitions the PR to conflicted", async () => {
    const conflicts = [
      { path: "a.txt", kind: "edit-edit" as const, reason: "overlap" as const },
      { path: "b.txt", kind: "delete-edit" as const, reason: "overlap" as const },
    ];
    const context = new MemoryContext(threeWayOperations(conflicts));
    context.target.append("fs.file.write", { v: 2, path: "a.txt", content: "target" });

    const receipt = await executeMerge(context, PR_STREAM);

    expect(receipt.outcome).toEqual({
      type: "pr.merge-conflicted",
      payload: {
        v: 1,
        targetMergeOffset: context.target.records.at(-1)!.offset,
        conflicts: conflicts.map(({ path, kind }) => ({ path, kind })),
      },
      ts: 42,
    });
    expect(context.state.status).toBe("conflicted");
  });

  it.each([
    ["unapproved", "open", "pr/merge-not-approved"],
    ["changes-requested", "open", "pr/merge-not-approved"],
    ["closed", "closed", "pr/merge-not-approved"],
    ["conflicted-pending", "conflicted", "pr/merge-not-approved"],
    ["already-merged", "merged", "pr/already-merged"],
  ] as const)("refuses %s without touching either stream", async (_name, status, reason) => {
    const ff = fastForwardOperations();
    const context = new MemoryContext(ff);
    context.state = approvedState(status);
    const prBefore = JSON.stringify(context.prRecords);
    const targetBefore = JSON.stringify(context.target.records);

    await expect(executeMerge(context, PR_STREAM)).rejects.toMatchObject({ reason });
    expect(JSON.stringify(context.prRecords)).toBe(prBefore);
    expect(JSON.stringify(context.target.records)).toBe(targetBefore);
    expect(ff.mergeFastForward).not.toHaveBeenCalled();
  });

  it("requires an active attachment, linked recording, or explicit waiver", async () => {
    const missing = new MemoryContext(fastForwardOperations());
    missing.evidence = evidenceState(false);
    await expect(executeMerge(missing, PR_STREAM)).rejects.toEqual(
      new PrMergeRefusalError("pr/merge-evidence-missing"),
    );
    expect(missing.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(0);

    const waived = new MemoryContext(fastForwardOperations());
    waived.evidence = evidenceState(false);
    waived.evidenceRecords = [event("evidence.waived", { v: 1, justification: "server proof" })];
    await expect(executeMerge(waived, PR_STREAM)).resolves.toMatchObject({ recovered: false });
  });

  it("passes through target-conflicted and reports a plan-to-append target race", async () => {
    const conflicted = new ThreeWayMergeError(
      "merge/target-conflicted",
      "target has unresolved conflicts",
    );
    const blocked = new MemoryContext({
      planThreeWayMerge: vi.fn(async () => {
        throw conflicted;
      }),
    });
    blocked.target.append("fs.file.write", { v: 2, path: "a", content: "target" });
    await expect(executeMerge(blocked, PR_STREAM)).rejects.toBe(conflicted);

    const operations = threeWayOperations();
    operations.applyThreeWayMerge.mockImplementationOnce(async (target, _source, plan) => {
      const actual = (await target.rawDump()).at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
      if (actual !== plan.target.offset) {
        throw new ThreeWayMergeError("merge/target-advanced", "target changed after planning");
      }
      throw new Error("unreachable");
    });
    const raced = new MemoryContext(operations);
    raced.target.append("fs.file.write", { v: 2, path: "a", content: "target" });
    raced.hooks = {
      beforeTargetAppend: ({ target }) => {
        (target as MemoryBranch).append("fs.file.write", {
          v: 2,
          path: "race",
          content: "external",
        });
      },
    };
    await expect(executeMerge(raced, PR_STREAM)).rejects.toMatchObject({
      code: "merge/target-advanced",
    });
    expect(raced.prRecords).toHaveLength(0);
    expect(raced.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(0);
    expect(raced.state.status).toBe("approved");
  });

  it("recovers the crash window without a second target merge", async () => {
    const operations = fastForwardOperations();
    const context = new MemoryContext(operations);
    context.hooks = {
      afterTargetAppend: () => {
        throw new Error("fault-after-target-append");
      },
    };
    await expect(executeMerge(context, PR_STREAM)).rejects.toThrow("fault-after-target-append");
    expect(context.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(1);
    expect(context.prRecords).toHaveLength(0);

    context.hooks = undefined;
    const recovered = await executeMerge(context, PR_STREAM);
    expect(recovered.recovered).toBe(true);
    expect(recovered.prOutcomeOffset).toBe(context.prRecords.at(-1)!.offset);
    expect(context.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(1);
    expect(context.prRecords.filter(({ type }) => type === "pr.merged")).toHaveLength(1);
    expect(operations.mergeFastForward).toHaveBeenCalledOnce();
    await expect(executeMerge(context, PR_STREAM)).rejects.toMatchObject({
      reason: "pr/already-merged",
    });
  });

  it("does not recover an earlier merge from the same source at a different fork", async () => {
    const operations = threeWayOperations();
    const context = new MemoryContext(operations);
    const unrelated = context.target.append("fs.branch.merge", {
      v: 1,
      sourceStreamId: SOURCE_STREAM,
      forkOffset: offsetForOrdinal(0),
      mergedThroughOffset: offsetForOrdinal(0),
    });

    const receipt = await executeMerge(context, PR_STREAM);

    expect(receipt.recovered).toBe(false);
    expect(receipt.outcome.payload.targetMergeOffset).not.toBe(unrelated.offset);
    expect(receipt.prOutcomeOffset).toBe(context.prRecords.at(-1)!.offset);
    expect(operations.planThreeWayMerge).toHaveBeenCalledOnce();
    expect(operations.applyThreeWayMerge).toHaveBeenCalledOnce();
    expect(context.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(2);
  });

  it("serializes double dispatch so exactly one merge and one outcome land", async () => {
    const operations = fastForwardOperations(true);
    const context = new MemoryContext(operations);
    const results = await Promise.allSettled([
      executeMerge(context, PR_STREAM),
      executeMerge(context, PR_STREAM),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { reason: "pr/already-merged" },
    });
    expect(context.target.records.filter(({ type }) => type === "fs.branch.merge")).toHaveLength(1);
    expect(context.prRecords.filter(({ type }) => type === "pr.merged")).toHaveLength(1);
  });
});

function frozenBlock(source: string, name: string): string {
  const start = `<!-- frozen:E5-T06:${name} -->`;
  const end = `<!-- /frozen:E5-T06:${name} -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`missing frozen block ${name}`);
  return source.slice(startIndex, endIndex + end.length);
}

describe("frozen E5-T06 documentation", () => {
  it("reproduces every task contract block byte-for-byte", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const task = readFileSync(
      new URL(
        "../../../.eforest/tasks/epic-5-the-meadow/E5-T06-pr-merge-execution/readme.md",
        import.meta.url,
      ),
      "utf8",
    );
    for (const name of ["outcome-events", "gate-and-refusals", "recovery"]) {
      expect(frozenBlock(readme, name)).toBe(frozenBlock(task, name));
    }
  });
});
