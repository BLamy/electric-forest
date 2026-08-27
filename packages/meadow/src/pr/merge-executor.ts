import { OFFSET_BEFORE_FIRST, compareOffsets, type Event, type Offset } from "@eforest/protocol";
import { evidenceStreamId, type AttachmentListState } from "@eforest/evidence";
import { parsePrStreamId } from "@eforest/pr";
import {
  ThreeWayMergeError,
  applyThreeWayMerge,
  isFsBranchMergeEvent,
  mergeFastForward,
  planThreeWayMerge,
  treeDigest,
  type FastForwardMergeReceipt,
  type FsTree,
  type StreamFsRepo,
  type ThreeWayMergePlan,
  type ThreeWayMergeReceipt,
} from "@eforest/streamfs";
import {
  PR_MERGE_EVENT_VERSION,
  type MeadowPrMergeConflictedEvent,
  type MeadowPrMergeOutcomeEvent,
  type MeadowPrMergedEvent,
  type PrMergeKind,
} from "./events.js";
import type { MeadowPrState } from "./reducer.js";
import { validatePrMergeGate } from "./validate.js";

export interface MergeStreamRecord extends Event {
  readonly offset: Offset;
}

export interface MergeBranch {
  readonly metadataStreamId: string;
  rawDump(): Promise<readonly MergeStreamRecord[]>;
  treeAt(offset?: Offset): Promise<FsTree>;
}

export interface PrMergeSnapshot {
  readonly state: MeadowPrState;
  readonly records: readonly Event[];
  readonly headOffset: Offset;
}

export interface PrMergeEvidenceSnapshot {
  readonly state: AttachmentListState;
  readonly records: readonly Event[];
}

export interface PrOutcomeAppendReceipt {
  readonly offset: Offset;
}

export interface PrMergeOperations {
  mergeFastForward(target: MergeBranch, source: MergeBranch): Promise<FastForwardMergeReceipt>;
  planThreeWayMerge(target: MergeBranch, source: MergeBranch): Promise<ThreeWayMergePlan>;
  applyThreeWayMerge(
    target: MergeBranch,
    source: MergeBranch,
    plan: ThreeWayMergePlan,
  ): Promise<ThreeWayMergeReceipt>;
}

export interface PrMergeHookContext {
  readonly prStreamId: string;
  readonly kind: PrMergeKind;
  readonly target: MergeBranch;
  readonly source: MergeBranch;
  readonly plan?: ThreeWayMergePlan;
  readonly outcome?: MeadowPrMergeOutcomeEvent;
}

export interface PrMergeHooks {
  /** Race injection point after selection/planning and before the target append. */
  readonly beforeTargetAppend?: (context: PrMergeHookContext) => void | Promise<void>;
  /** Crash injection point after the target append and before the PR mirror append. */
  readonly afterTargetAppend?: (context: PrMergeHookContext) => void | Promise<void>;
  readonly beforePrOutcomeAppend?: (context: PrMergeHookContext) => void | Promise<void>;
}

export interface PrMergeExecutorContext {
  readPr(prStreamId: string): Promise<PrMergeSnapshot>;
  readEvidence(evidenceStreamId: string): Promise<PrMergeEvidenceSnapshot>;
  resolveBranch(streamId: string): Promise<MergeBranch | undefined>;
  appendPrOutcome(
    prStreamId: string,
    event: MeadowPrMergeOutcomeEvent,
    expectedHead: Offset,
  ): Promise<PrOutcomeAppendReceipt>;
  readonly now?: () => number;
  readonly operations?: Partial<PrMergeOperations>;
  readonly hooks?: PrMergeHooks;
  /** Supply a distributed/external lock in production; a context-local lock is the fallback. */
  readonly withMergeLock?: <A>(prStreamId: string, run: () => Promise<A>) => Promise<A>;
}

export interface PrMergeExecutionReceipt {
  readonly recovered: boolean;
  readonly outcome: MeadowPrMergeOutcomeEvent;
  readonly prOutcomeOffset: Offset;
}

const defaultOperations: PrMergeOperations = {
  mergeFastForward: (target, source) =>
    mergeFastForward(target as StreamFsRepo, source as StreamFsRepo),
  planThreeWayMerge: (target, source) =>
    planThreeWayMerge(target as StreamFsRepo, source as StreamFsRepo),
  applyThreeWayMerge: (target, source, plan) =>
    applyThreeWayMerge(target as StreamFsRepo, source as StreamFsRepo, plan),
};

const localLockTails = new WeakMap<object, Map<string, Promise<void>>>();

async function withLocalLock<A>(owner: object, key: string, run: () => Promise<A>): Promise<A> {
  let tails = localLockTails.get(owner);
  if (tails === undefined) {
    tails = new Map();
    localLockTails.set(owner, tails);
  }
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  tails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function recordEvent(record: MergeStreamRecord): Event {
  return { type: record.type, payload: record.payload, ts: record.ts };
}

function mergeErrorReason(error: unknown): unknown {
  if (error instanceof ThreeWayMergeError) return error.code;
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as {
    readonly code?: unknown;
    readonly body?: { readonly error?: { readonly reason?: unknown } };
  };
  return candidate.code ?? candidate.body?.error?.reason;
}

function rethrowMergeError(error: unknown): never {
  if (error instanceof ThreeWayMergeError) throw error;
  const reason = mergeErrorReason(error);
  if (reason === "fs/merge-not-fast-forward" || reason === "merge/target-advanced") {
    throw new ThreeWayMergeError("merge/target-advanced", "target changed before merge append");
  }
  if (reason === "merge/target-conflicted") {
    throw new ThreeWayMergeError("merge/target-conflicted", "target has unresolved conflicts");
  }
  throw error;
}

function matchingTargetMerge(
  records: readonly MergeStreamRecord[],
  forkOffset: Offset,
  sourceStreamId: string,
): MergeStreamRecord | undefined {
  return records.find((record) => {
    if (compareOffsets(record.offset, forkOffset) <= 0) return false;
    const event = recordEvent(record);
    return (
      isFsBranchMergeEvent(event) &&
      event.payload.sourceStreamId === sourceStreamId &&
      event.payload.forkOffset === forkOffset
    );
  });
}

async function outcomeForTargetRecord(
  target: MergeBranch,
  record: MergeStreamRecord,
  now: () => number,
): Promise<MeadowPrMergeOutcomeEvent> {
  const event = recordEvent(record);
  if (!isFsBranchMergeEvent(event)) throw new TypeError("target record is not a merge event");
  if (event.payload.v === 2 && event.payload.conflicts.length > 0) {
    return {
      type: "pr.merge-conflicted",
      payload: {
        v: PR_MERGE_EVENT_VERSION,
        targetMergeOffset: record.offset,
        conflicts: event.payload.conflicts.map(({ path, kind }) => ({ path, kind })),
      },
      ts: now(),
    };
  }
  const resultTreeDigest =
    event.payload.v === 2
      ? event.payload.resultTreeDigest
      : treeDigest(await target.treeAt(record.offset));
  return {
    type: "pr.merged",
    payload: {
      v: PR_MERGE_EVENT_VERSION,
      targetMergeOffset: record.offset,
      kind: event.payload.v === 2 ? "three-way" : "fast-forward",
      resultTreeDigest,
    },
    ts: now(),
  };
}

function mergedOutcome(
  kind: PrMergeKind,
  receipt: FastForwardMergeReceipt | ThreeWayMergeReceipt,
  now: () => number,
): MeadowPrMergedEvent {
  return {
    type: "pr.merged",
    payload: {
      v: PR_MERGE_EVENT_VERSION,
      targetMergeOffset: receipt.mergeOffset as Offset,
      kind,
      resultTreeDigest: "treeDigest" in receipt ? receipt.treeDigest : receipt.resultTreeDigest,
    },
    ts: now(),
  };
}

function conflictedOutcome(
  receipt: ThreeWayMergeReceipt,
  now: () => number,
): MeadowPrMergeConflictedEvent {
  return {
    type: "pr.merge-conflicted",
    payload: {
      v: PR_MERGE_EVENT_VERSION,
      targetMergeOffset: receipt.mergeOffset,
      conflicts: receipt.conflicts.map(({ path, kind }) => ({ path, kind })),
    },
    ts: now(),
  };
}

async function executeUnlocked(
  context: PrMergeExecutorContext,
  prStreamId: string,
): Promise<PrMergeExecutionReceipt> {
  const identity = parsePrStreamId(prStreamId);
  if (identity === undefined) throw new TypeError(`invalid PR stream id: ${prStreamId}`);
  const now = context.now ?? Date.now;
  const pr = await context.readPr(prStreamId);
  const evidence = await context.readEvidence(
    evidenceStreamId({ ...identity, entityType: "pr", entityId: identity.prId }),
  );
  validatePrMergeGate(pr.state, evidence.state, evidence.records);

  const [target, source] = await Promise.all([
    context.resolveBranch(pr.state.targetBranch),
    context.resolveBranch(pr.state.sourceBranch),
  ]);
  if (target === undefined || source === undefined) {
    throw new TypeError("PR references an unavailable branch stream");
  }

  const targetRecords = await target.rawDump();
  const recoveredRecord = matchingTargetMerge(
    targetRecords,
    pr.state.forkOffset,
    pr.state.sourceBranch,
  );
  if (recoveredRecord !== undefined) {
    const outcome = await outcomeForTargetRecord(target, recoveredRecord, now);
    await context.hooks?.beforePrOutcomeAppend?.({
      prStreamId,
      kind: outcome.type === "pr.merged" ? outcome.payload.kind : "three-way",
      target,
      source,
      outcome,
    });
    const appended = await context.appendPrOutcome(prStreamId, outcome, pr.headOffset);
    return { recovered: true, outcome, prOutcomeOffset: appended.offset };
  }

  const targetAdvanced = targetRecords.some(
    ({ offset }) => compareOffsets(offset, pr.state.forkOffset) > 0,
  );
  const operations: PrMergeOperations = { ...defaultOperations, ...context.operations };
  let outcome: MeadowPrMergeOutcomeEvent;
  let kind: PrMergeKind;
  let plan: ThreeWayMergePlan | undefined;
  try {
    if (!targetAdvanced) {
      kind = "fast-forward";
      await context.hooks?.beforeTargetAppend?.({ prStreamId, kind, target, source });
      const receipt = await operations.mergeFastForward(target, source);
      outcome = mergedOutcome(kind, receipt, now);
    } else {
      kind = "three-way";
      plan = await operations.planThreeWayMerge(target, source);
      await context.hooks?.beforeTargetAppend?.({ prStreamId, kind, target, source, plan });
      const receipt = await operations.applyThreeWayMerge(target, source, plan);
      outcome =
        receipt.conflicts.length === 0
          ? mergedOutcome(kind, receipt, now)
          : conflictedOutcome(receipt, now);
    }
  } catch (error) {
    rethrowMergeError(error);
  }

  const hookContext: PrMergeHookContext = {
    prStreamId,
    kind,
    target,
    source,
    ...(plan === undefined ? {} : { plan }),
    outcome,
  };
  await context.hooks?.afterTargetAppend?.(hookContext);
  await context.hooks?.beforePrOutcomeAppend?.(hookContext);
  const appended = await context.appendPrOutcome(prStreamId, outcome, pr.headOffset);
  return { recovered: false, outcome, prOutcomeOffset: appended.offset };
}

/** Execute one serialized merge attempt and mirror exactly one target outcome to the PR stream. */
export function executeMerge(
  context: PrMergeExecutorContext,
  prStreamId: string,
): Promise<PrMergeExecutionReceipt> {
  const run = () => executeUnlocked(context, prStreamId);
  return context.withMergeLock === undefined
    ? withLocalLock(context, prStreamId, run)
    : context.withMergeLock(prStreamId, run);
}
