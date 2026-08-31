import { sha256Hex, stateDigest, type Event, type Offset } from "@eforest/protocol";
import {
  isIssueActionType,
  isIssueStreamId,
  issueHasBeenOpened,
  issueReducer,
} from "@eforest/issues";
import { parseTaskReadme } from "./folder/parse.js";
import {
  TASK_BRANCH_STREAM_PATTERN,
  TASK_SPEC_NO_BASE,
  isTaskActionType,
  isTaskEventShape,
  parseTaskStreamId,
  taskEventOffset,
  taskEvidenceStreamId,
  type TaskBranchRef,
  type TaskEvent,
  type TaskEvidenceRef,
} from "./events.js";
import {
  currentAttempt,
  taskInitialState,
  taskInitialStateForStream,
  type TaskAttempt,
  type TaskState,
} from "./state.js";
import { TASKS_REDUCER_ID, TASK_EVENT_VERSION, type TaskRefusalReason } from "./version.js";

export type TaskTransition =
  | { readonly ok: true; readonly next: TaskState }
  | { readonly ok: false; readonly reason: TaskRefusalReason };

function refuse(reason: TaskRefusalReason): TaskTransition {
  return { ok: false, reason };
}

function replaceLast(attempts: readonly TaskAttempt[], attempt: TaskAttempt): TaskAttempt[] {
  return [...attempts.slice(0, -1), attempt];
}

function branchBelongsToTask(state: TaskState, branch: TaskBranchRef): boolean {
  const identity = parseTaskStreamId(state.stream);
  const match = TASK_BRANCH_STREAM_PATTERN.exec(branch.stream);
  return (
    identity !== undefined &&
    match !== null &&
    match[1] === identity.org &&
    match[2] === identity.repo
  );
}

function evidenceBelongsToTask(state: TaskState, evidence: TaskEvidenceRef): boolean {
  return evidence.stream === taskEvidenceStreamId(state.stream);
}

function withoutCurrentClaim(state: TaskState): TaskState {
  const next: TaskState = {
    v: state.v,
    stream: state.stream,
    taskId: state.taskId,
    issue: state.issue,
    status: state.status,
    attempts: state.attempts,
  };
  const withVerification =
    state.verification === undefined ? next : { ...next, verification: state.verification };
  return state.spec === undefined ? withVerification : { ...withVerification, spec: state.spec };
}

/**
 * E6-T05: a spec revision is fenced on the previous revision (`base`), must hash to its
 * own bytes, and must be a parseable E6-T02 readme for this task id. It never touches
 * status: the frontmatter `status` inside `readme` is text.
 */
function applySpecRevised(
  state: TaskState,
  event: TaskEvent & { readonly type: "task.spec-revised" },
  offset: Offset,
): TaskTransition {
  const currentBase = state.spec?.offset ?? TASK_SPEC_NO_BASE;
  if (event.payload.base !== currentBase) return refuse("task/stale-spec");
  if (!branchBelongsToTask(state, event.payload.origin)) return refuse("task/spec-foreign-origin");
  const bytes = new TextEncoder().encode(event.payload.readme);
  if (sha256Hex(bytes) !== event.payload.sha256) return refuse("task/spec-digest-mismatch");
  const parsed = parseTaskReadme(bytes);
  if (!parsed.ok) return refuse("task/spec-unparseable");
  if (parsed.frontmatter.id !== state.taskId) return refuse("task/spec-id-mismatch");
  const folderId = event.payload.folder.split("/")[1]!.split("-").slice(0, 2).join("-");
  if (
    folderId !== state.taskId ||
    !event.payload.folder.startsWith(`epic-${parsed.frontmatter.epic}`)
  )
    return refuse("task/spec-folder-mismatch");
  return {
    ok: true,
    next: {
      ...state,
      spec: {
        offset,
        folder: event.payload.folder,
        sha256: event.payload.sha256,
        readme: event.payload.readme,
      },
    },
  };
}

function sameBranch(a: TaskBranchRef, b: TaskBranchRef): boolean {
  return a.stream === b.stream && a.head === b.head;
}

/**
 * The single transition table for loop events. The validator throws its refusal reason
 * before append; the reducer treats the same refusal as a deterministic no-op on replay.
 * `offset` is the stream offset the event occupies (or will occupy).
 */
export function applyTaskEvent(state: TaskState, event: TaskEvent, offset: Offset): TaskTransition {
  if (!issueHasBeenOpened(state.issue)) return refuse("task/not-opened");
  if (event.type === "task.spec-revised") return applySpecRevised(state, event, offset);
  const by = event.payload.by;
  const attempt = currentAttempt(state);
  switch (event.type) {
    case "task.started": {
      if (by.role !== "builder") return refuse("task/wrong-role");
      if (state.status !== "pending" || attempt !== undefined)
        return refuse("task/illegal-transition");
      return {
        ok: true,
        next: {
          ...state,
          status: "in-progress",
          attempts: [{ n: 1, builder: { actor: by.actor, run: by.run }, startedAt: offset }],
        },
      };
    }
    case "task.claimed": {
      if (by.role !== "builder") return refuse("task/wrong-role");
      if (state.status !== "in-progress" || attempt === undefined || attempt.claim !== undefined)
        return refuse("task/illegal-transition");
      if (by.actor !== attempt.builder.actor) return refuse("task/builder-mismatch");
      if (!branchBelongsToTask(state, event.payload.branch)) return refuse("task/foreign-branch");
      if (!evidenceBelongsToTask(state, event.payload.evidence))
        return refuse("task/foreign-evidence");
      const claim = {
        offset,
        actor: by.actor,
        run: by.run,
        branch: event.payload.branch,
        evidence: event.payload.evidence,
        summary: event.payload.summary,
      };
      return {
        ok: true,
        next: {
          ...state,
          status: "implemented",
          attempts: replaceLast(state.attempts, { ...attempt, claim }),
          currentClaim: { attempt: attempt.n, offset },
        },
      };
    }
    case "task.refuted":
    case "task.verified": {
      // E6_T01_CRITIC_ROLE_GUARD: the sabotage sentinel removes this line and proves
      // verify-E6-T01 goes red on the builder-verifies refusal transcript.
      if (by.role !== "critic") return refuse("task/wrong-role");
      if (state.status === "verified") return refuse("task/terminal");
      if (
        state.status !== "implemented" ||
        attempt?.claim === undefined ||
        state.currentClaim === undefined
      ) {
        return refuse("task/no-claim");
      }
      if (event.payload.claim.stream !== state.stream) return refuse("task/foreign-claim");
      if (
        event.payload.claim.offset !== state.currentClaim.offset ||
        state.currentClaim.attempt !== attempt.n ||
        !sameBranch(event.payload.branch, attempt.claim.branch)
      ) {
        return refuse("task/stale-claim");
      }
      if (!evidenceBelongsToTask(state, event.payload.evidence))
        return refuse("task/foreign-evidence");
      if (by.actor === attempt.builder.actor || by.actor === attempt.claim.actor)
        return refuse("task/self-verdict");
      const base = {
        offset,
        actor: by.actor,
        run: by.run,
        claim: attempt.claim.offset,
        branch: event.payload.branch,
        evidence: event.payload.evidence,
      };
      if (event.type === "task.refuted") {
        return {
          ok: true,
          next: {
            ...state,
            status: "refuted",
            attempts: replaceLast(state.attempts, {
              ...attempt,
              verdict: { kind: "refuted", ...base, findings: event.payload.findings },
            }),
          },
        };
      }
      return {
        ok: true,
        next: {
          ...state,
          status: "verified",
          attempts: replaceLast(state.attempts, {
            ...attempt,
            verdict: { kind: "verified", ...base, summary: event.payload.summary },
          }),
          verification: {
            attempt: attempt.n,
            claim: attempt.claim.offset,
            critic: { actor: by.actor, run: by.run },
            offset,
          },
        },
      };
    }
    case "task.rework-started": {
      if (by.role !== "builder") return refuse("task/wrong-role");
      if (state.status !== "refuted" || attempt?.verdict === undefined)
        return refuse("task/illegal-transition");
      if (event.payload.refutation.stream !== state.stream)
        return refuse("task/foreign-refutation");
      if (event.payload.refutation.offset !== attempt.verdict.offset)
        return refuse("task/stale-refutation");
      return {
        ok: true,
        next: {
          ...withoutCurrentClaim(state),
          status: "in-progress",
          attempts: [
            ...state.attempts,
            {
              n: attempt.n + 1,
              builder: { actor: by.actor, run: by.run },
              startedAt: offset,
              reworkOf: attempt.verdict.offset,
            },
          ],
        },
      };
    }
  }
}

function cleanPayload(event: Event): Event {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload))
    return event;
  const payload = Object.fromEntries(
    Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  return { ...event, payload };
}

/**
 * Total over every event: issue events flow through the frozen E5 issue reducer; loop
 * events need a well-formed stream offset and a legal transition; everything else
 * (unknown types, unknown versions, malformed shapes, illegal transitions) keeps the
 * prior state as a deterministic no-op.
 */
export function taskReducer(state: TaskState, rawEvent: Event): TaskState {
  if (state.v !== TASK_EVENT_VERSION) return state;
  const event = cleanPayload(rawEvent);
  if (isIssueActionType(event.type)) {
    const issue = issueReducer(state.issue, event);
    return issue === state.issue ? state : { ...state, issue };
  }
  if (!isTaskActionType(event.type) || !isTaskEventShape(event)) return state;
  const offset = taskEventOffset(rawEvent);
  if (offset === undefined) return state;
  const transition = applyTaskEvent(state, event, offset);
  return transition.ok ? transition.next : state;
}

export function reduceTaskApplicationEvent(state: unknown, event: Event): TaskState {
  return taskReducer(state as TaskState, event);
}

export function replayTaskLog(streamId: string, events: readonly Event[]): TaskState {
  return events.reduce(taskReducer, taskInitialStateForStream(streamId));
}

export const tasksReducerDefinition = Object.freeze({
  id: TASKS_REDUCER_ID,
  version: TASK_EVENT_VERSION,
  initialState: taskInitialState,
  initialStateForStream: taskInitialStateForStream,
  reduce: reduceTaskApplicationEvent,
  digest: stateDigest as (state: unknown) => string,
  matchesStream: isIssueStreamId,
});
