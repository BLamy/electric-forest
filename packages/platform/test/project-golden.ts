import type { Event, Offset } from "@eforest/protocol";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type {
  ProjectActorRole,
  ProjectQueueProof,
  ProjectRefusalReason,
  ProjectStatus,
} from "../src/loop/index.js";

export const ORG = "maple";
/** A validated owner web session (authorization basis `repo-owner`). */
export const HUMAN = "human-rowan";
/** Grant-backed bearer identities (authorization basis `grant:write`). */
export const AGENT = "agent-ash";
export const CRITIC = "agent-fern";

export const LIFECYCLE_REPO = "loom";
export const LIFECYCLE_STREAM = `project:${ORG}/${LIFECYCLE_REPO}`;

export const by = (actor: string, role: ProjectActorRole) => ({ actor, role });

export function transition(
  actor: string,
  role: ProjectActorRole,
  to: ProjectStatus,
  expected: number,
  statusReason: string,
  ts: number,
  proof?: ProjectQueueProof,
): Event {
  return {
    type: "project.transitioned",
    payload: {
      v: 1,
      by: by(actor, role),
      to,
      expectedOffset: expected < 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(expected),
      statusReason,
      ...(proof === undefined ? {} : { proof }),
    },
    ts,
  };
}

export function launch(
  actor: string,
  role: ProjectActorRole,
  expected: number,
  run: string,
  ts: number,
): Event {
  return {
    type: "loop.launch.requested",
    payload: {
      v: 1,
      by: by(actor, role),
      expectedOffset: expected < 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(expected),
      run: `agent-run:${ORG}/${run}`,
    },
    ts,
  };
}

/** Two tasks opened in this order on `loom`: the catalog head is ordinal 1. */
export const LIFECYCLE_PROOF: ProjectQueueProof = {
  queue: { stream: `repo-issues:${ORG}/${LIFECYCLE_REPO}`, offset: offsetForOrdinal(1) },
  /** Six fences (0-5) + launch, pause, resume, stop, resume, launch (6-11): tail 11. */
  project: { offset: offsetForOrdinal(11) },
  tasks: [
    { id: "loom-cap", status: "verified", capstone: true },
    { id: "loom-t1", status: "verified", capstone: false },
  ],
};

/** Fences the two seeded tasks (started, claimed, verified each) leave on the project stream. */
export const LIFECYCLE_FENCES = 6;

/**
 * The frozen valid lifecycle on `project:maple/loom`, offsets 6..12 (after six fences;
 * `expectedOffset` cites `state.head`, which fences never move):
 * launch (agent) -> paused (human) -> building (human) -> invalid_loop (agent) ->
 * building (human) -> launch (human) -> complete (agent, with the real queue proof).
 */
export const LIFECYCLE_EVENTS: readonly Event[] = [
  launch(AGENT, "agent", -1, "loom-run-1", 2000),
  transition(HUMAN, "human", "paused", 6, "human halted the loop for review", 2001),
  transition(HUMAN, "human", "building", 7, "review finished; loop may resume", 2002),
  transition(AGENT, "agent", "invalid_loop", 8, "progress critic: death-spiral after run 3", 2003),
  transition(HUMAN, "human", "building", 9, "human authorized recovery: runs 4-6 only", 2004),
  launch(HUMAN, "human", 10, "loom-run-2", 2005),
  transition(
    AGENT,
    "agent",
    "complete",
    11,
    "every task verified including the capstone loom-cap",
    2006,
    LIFECYCLE_PROOF,
  ),
];

export const LIFECYCLE_OFFSET_EVENTS: readonly (Event & { readonly offset: Offset })[] =
  LIFECYCLE_EVENTS.map((record, index) => ({
    ...record,
    offset: offsetForOrdinal(LIFECYCLE_FENCES + index),
  }));

export const MATRIX_ACTIONS = [
  "launch",
  "to:building",
  "to:paused",
  "to:invalid_loop",
  "to:complete",
  "to:complete+proof",
  "task.started",
  "task.claimed",
  "task.refuted",
  "task.rework-started",
  "task.verified",
] as const;
export type MatrixAction = (typeof MATRIX_ACTIONS)[number];

export type MatrixExpectation = "accepted" | ProjectRefusalReason;

export interface MatrixRow {
  readonly state: ProjectStatus;
  readonly role: ProjectActorRole;
  readonly action: MatrixAction;
  readonly expect: MatrixExpectation;
}

const TASK_ACTIONS: readonly MatrixAction[] = [
  "task.started",
  "task.claimed",
  "task.refuted",
  "task.rework-started",
  "task.verified",
];

/**
 * The hand-written enforcement matrix: every state x actor-role x loop-action tuple the
 * server must decide, with its exact outcome. Loop actions (the launch and every
 * task-stream loop event) are admitted only in `building`; transitions follow the
 * `.eforest/loop.md` table; resumes and pauses are human-only.
 */
export const MATRIX: readonly MatrixRow[] = [
  // building
  { state: "building", role: "human", action: "launch", expect: "accepted" },
  { state: "building", role: "human", action: "to:building", expect: "project/invalid-transition" },
  { state: "building", role: "human", action: "to:paused", expect: "accepted" },
  { state: "building", role: "human", action: "to:invalid_loop", expect: "accepted" },
  { state: "building", role: "human", action: "to:complete", expect: "project/proof-required" },
  { state: "building", role: "human", action: "to:complete+proof", expect: "accepted" },
  { state: "building", role: "human", action: "task.started", expect: "accepted" },
  { state: "building", role: "agent", action: "launch", expect: "accepted" },
  { state: "building", role: "agent", action: "to:building", expect: "project/invalid-transition" },
  { state: "building", role: "agent", action: "to:paused", expect: "project/human-required" },
  { state: "building", role: "agent", action: "to:invalid_loop", expect: "accepted" },
  { state: "building", role: "agent", action: "to:complete", expect: "project/proof-required" },
  { state: "building", role: "agent", action: "to:complete+proof", expect: "accepted" },
  ...TASK_ACTIONS.map((action): MatrixRow => ({
    state: "building",
    role: "agent",
    action,
    expect: "accepted",
  })),
  // paused
  { state: "paused", role: "human", action: "launch", expect: "project/paused" },
  { state: "paused", role: "human", action: "to:building", expect: "accepted" },
  { state: "paused", role: "human", action: "to:paused", expect: "project/invalid-transition" },
  { state: "paused", role: "human", action: "to:invalid_loop", expect: "accepted" },
  { state: "paused", role: "human", action: "to:complete", expect: "project/invalid-transition" },
  {
    state: "paused",
    role: "human",
    action: "to:complete+proof",
    expect: "project/invalid-transition",
  },
  { state: "paused", role: "human", action: "task.started", expect: "project/paused" },
  { state: "paused", role: "agent", action: "launch", expect: "project/paused" },
  { state: "paused", role: "agent", action: "to:building", expect: "project/unauthorized-resume" },
  { state: "paused", role: "agent", action: "to:paused", expect: "project/invalid-transition" },
  { state: "paused", role: "agent", action: "to:invalid_loop", expect: "accepted" },
  { state: "paused", role: "agent", action: "to:complete", expect: "project/invalid-transition" },
  {
    state: "paused",
    role: "agent",
    action: "to:complete+proof",
    expect: "project/invalid-transition",
  },
  ...TASK_ACTIONS.map((action): MatrixRow => ({
    state: "paused",
    role: "agent",
    action,
    expect: "project/paused",
  })),
  // invalid_loop
  { state: "invalid_loop", role: "human", action: "launch", expect: "project/invalid-loop" },
  { state: "invalid_loop", role: "human", action: "to:building", expect: "accepted" },
  {
    state: "invalid_loop",
    role: "human",
    action: "to:paused",
    expect: "project/invalid-transition",
  },
  {
    state: "invalid_loop",
    role: "human",
    action: "to:invalid_loop",
    expect: "project/invalid-transition",
  },
  {
    state: "invalid_loop",
    role: "human",
    action: "to:complete",
    expect: "project/invalid-transition",
  },
  {
    state: "invalid_loop",
    role: "human",
    action: "to:complete+proof",
    expect: "project/invalid-transition",
  },
  { state: "invalid_loop", role: "human", action: "task.started", expect: "project/invalid-loop" },
  { state: "invalid_loop", role: "agent", action: "launch", expect: "project/invalid-loop" },
  {
    state: "invalid_loop",
    role: "agent",
    action: "to:building",
    expect: "project/unauthorized-resume",
  },
  {
    state: "invalid_loop",
    role: "agent",
    action: "to:paused",
    expect: "project/invalid-transition",
  },
  {
    state: "invalid_loop",
    role: "agent",
    action: "to:invalid_loop",
    expect: "project/invalid-transition",
  },
  {
    state: "invalid_loop",
    role: "agent",
    action: "to:complete",
    expect: "project/invalid-transition",
  },
  {
    state: "invalid_loop",
    role: "agent",
    action: "to:complete+proof",
    expect: "project/invalid-transition",
  },
  ...TASK_ACTIONS.map((action): MatrixRow => ({
    state: "invalid_loop",
    role: "agent",
    action,
    expect: "project/invalid-loop",
  })),
  // complete
  { state: "complete", role: "human", action: "launch", expect: "project/complete" },
  { state: "complete", role: "human", action: "to:building", expect: "accepted" },
  { state: "complete", role: "human", action: "to:paused", expect: "project/invalid-transition" },
  {
    state: "complete",
    role: "human",
    action: "to:invalid_loop",
    expect: "project/invalid-transition",
  },
  { state: "complete", role: "human", action: "to:complete", expect: "project/invalid-transition" },
  {
    state: "complete",
    role: "human",
    action: "to:complete+proof",
    expect: "project/invalid-transition",
  },
  { state: "complete", role: "human", action: "task.started", expect: "project/complete" },
  { state: "complete", role: "agent", action: "launch", expect: "project/complete" },
  {
    state: "complete",
    role: "agent",
    action: "to:building",
    expect: "project/unauthorized-resume",
  },
  { state: "complete", role: "agent", action: "to:paused", expect: "project/invalid-transition" },
  {
    state: "complete",
    role: "agent",
    action: "to:invalid_loop",
    expect: "project/invalid-transition",
  },
  { state: "complete", role: "agent", action: "to:complete", expect: "project/invalid-transition" },
  {
    state: "complete",
    role: "agent",
    action: "to:complete+proof",
    expect: "project/invalid-transition",
  },
  ...TASK_ACTIONS.map((action): MatrixRow => ({
    state: "complete",
    role: "agent",
    action,
    expect: "project/complete",
  })),
];
