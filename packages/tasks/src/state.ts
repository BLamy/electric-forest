import type { Offset } from "@eforest/protocol";
import { issueInitialStateFor, type IssueState } from "@eforest/issues";
import {
  parseTaskStreamId,
  type TaskBranchRef,
  type TaskEvidenceRef,
  type TaskFinding,
} from "./events.js";
import { TASK_EVENT_VERSION } from "./version.js";

export const TASK_STATUSES = [
  "pending",
  "in-progress",
  "implemented",
  "refuted",
  "verified",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskAgentRef {
  readonly actor: string;
  readonly run: string;
}

/** One builder claim: born at its own stream offset, which every verdict must cite. */
export interface TaskClaim {
  readonly offset: Offset;
  readonly actor: string;
  readonly run: string;
  readonly branch: TaskBranchRef;
  readonly evidence: TaskEvidenceRef;
  readonly summary: string;
}

export interface TaskVerdict {
  readonly kind: "refuted" | "verified";
  readonly offset: Offset;
  readonly actor: string;
  readonly run: string;
  readonly claim: Offset;
  readonly branch: TaskBranchRef;
  readonly evidence: TaskEvidenceRef;
  /** Complete findings of a refutation; replay keeps them, not just the status flip. */
  readonly findings?: readonly TaskFinding[];
  readonly summary?: string;
}

/** Attempt history is append-only: a rework opens attempt n+1, it never edits attempt n. */
export interface TaskAttempt {
  readonly n: number;
  readonly builder: TaskAgentRef;
  readonly startedAt: Offset;
  readonly reworkOf?: Offset;
  readonly claim?: TaskClaim;
  readonly verdict?: TaskVerdict;
}

export interface TaskCurrentClaim {
  readonly attempt: number;
  readonly offset: Offset;
}

/** The accepted readme text of the task (E6-T05); absent until the first revision. */
export interface TaskSpec {
  readonly offset: Offset;
  readonly folder: string;
  readonly sha256: string;
  readonly readme: string;
}

export interface TaskVerification {
  readonly attempt: number;
  readonly claim: Offset;
  readonly critic: TaskAgentRef;
  readonly offset: Offset;
}

/**
 * Canonical `tasks/v1` state. `issue` is the frozen E5-T01 issue state of the same
 * stream, byte-for-byte what the `issue` reducer produces; the loop fields are additive.
 */
export interface TaskState {
  readonly v: typeof TASK_EVENT_VERSION;
  readonly stream: string;
  readonly taskId: string;
  readonly issue: IssueState;
  readonly status: TaskStatus;
  readonly attempts: readonly TaskAttempt[];
  readonly currentClaim?: TaskCurrentClaim;
  readonly verification?: TaskVerification;
  readonly spec?: TaskSpec;
}

export function taskInitialStateFor(stream: string, taskId: string): TaskState {
  return {
    v: TASK_EVENT_VERSION,
    stream,
    taskId,
    issue: issueInitialStateFor(taskId),
    status: "pending",
    attempts: [],
  };
}

/** Identity-less initial state: no claim reference can ever match it (fail closed). */
export const taskInitialState: TaskState = Object.freeze(taskInitialStateFor("", ""));

export function taskInitialStateForStream(streamId: string): TaskState {
  const identity = parseTaskStreamId(streamId);
  if (identity === undefined) throw new TypeError(`invalid task stream id: ${streamId}`);
  return taskInitialStateFor(streamId, identity.taskId);
}

export function currentAttempt(state: TaskState): TaskAttempt | undefined {
  return state.attempts.at(-1);
}
