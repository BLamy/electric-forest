/** Frozen `task` envelope version: every loop payload carries `v: 1`. */
export const TASK_EVENT_VERSION = 1 as const;

/** Registry id of the task projection over an issue stream (`ef replay --reducer tasks/v1`). */
export const TASKS_REDUCER_ID = "tasks/v1" as const;

/**
 * Every loop event type lives in this family on the task's issue stream. The issue
 * reducer and the issue board treat the family as a deterministic no-op; only the
 * `tasks/v1` reducer gives it meaning.
 */
export const TASK_EVENT_FAMILY = "task." as const;

export const TASK_REFUSAL_REASONS = [
  "task/not-opened",
  "task/illegal-transition",
  "task/wrong-role",
  "task/actor-mismatch",
  "task/builder-mismatch",
  "task/foreign-branch",
  "task/foreign-evidence",
  "task/no-claim",
  "task/terminal",
  "task/foreign-claim",
  "task/stale-claim",
  "task/self-verdict",
  "task/foreign-refutation",
  "task/stale-refutation",
  "task/unknown-attachment",
] as const;

export type TaskRefusalReason = (typeof TASK_REFUSAL_REASONS)[number];
