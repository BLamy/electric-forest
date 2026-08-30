# Task event model (`tasks/v1`)

**A task is an issue with evidence.** The task stream _is_ the issue stream
`issue:<org>/<repo>/<taskId>`: the eight frozen E5-T01 issue actions keep their meaning,
and the loop appends a sibling event family `task.*` (envelope `v: 1`) to the same log.
The `issue` reducer, the issue board, and every E5 golden treat `task.*` as a
deterministic no-op (the precedent is `fs:` meta streams, which the `streamfs` and
`history` reducers both read). The `tasks/v1` reducer reads both families and reduces
every task to one canonical `TaskState`. Evidence lives on the task's E5-T10 attachment
list `evidence:<org>/<repo>/issue/<taskId>` — no second attachment schema, no task
table, no side store: replay of the task log is the only source of task status.

Spec prose writes the loop events as `task/claimed`; the wire type is `task.claimed`
(dot-typed like every other event family), and refusal reasons are `task/<reason>`.

## Events

| Type                  | Payload (exact keys)                       | Role    | From          | To            |
| --------------------- | ------------------------------------------ | ------- | ------------- | ------------- |
| `task.started`        | `v, by`                                    | builder | `pending`     | `in-progress` |
| `task.claimed`        | `v, by, branch, evidence, summary`         | builder | `in-progress` | `implemented` |
| `task.refuted`        | `v, by, claim, branch, evidence, findings` | critic  | `implemented` | `refuted`     |
| `task.rework-started` | `v, by, refutation`                        | builder | `refuted`     | `in-progress` |
| `task.verified`       | `v, by, claim, branch, evidence, summary`  | critic  | `implemented` | `verified`    |

- `by = { actor, role: "builder" | "critic", run }`; `run` is an agent-run stream id
  `agent-run:<org>/<run-id>` (E6-T07 writes it). At the dispatch door `by.actor` must
  equal the authenticated identity (`task/actor-mismatch`).
- `branch = { stream, head }`: a task-branch StreamFS meta stream of the same org/repo
  (`fs:<org>/<repo>:<branch>:meta`) and the opaque head offset the claim was made at.
- `evidence = { stream, attachmentIds[] }`: the task's own E5-T10 attachment list; a
  claim cites at least one attachment. When the door can resolve the list, every cited
  id must exist and be attached (`task/unknown-attachment`).
- `claim = { stream, offset }` is the task stream and the offset of the claim a verdict
  answers; `refutation` likewise cites the refutation a rework answers. A verdict's
  `branch` must equal the claim's branch and head.
- `findings[]` (1–64): `{ fingerprint, summary, citation }` where `fingerprint` is a
  stable slug (`[a-z0-9-]`, 3–64 chars, unique per verdict) and `citation` is either
  `{ stream, attachmentId }` on an evidence stream or `{ stream, offset }` on any stream.

`verified` is terminal and only `task.verified` produces it; only `task.claimed`
produces `implemented`. Attempt history is append-only: a rework opens attempt `n+1`
with `reworkOf` pointing at the refutation offset; nothing edits attempt `n`.

## Refusals (before append)

`task/not-opened`, `task/illegal-transition`, `task/wrong-role`, `task/actor-mismatch`,
`task/builder-mismatch` (claim by an actor other than the attempt's builder),
`task/foreign-branch`, `task/foreign-evidence`, `task/no-claim` (verdict with no current
claim), `task/terminal`, `task/foreign-claim` (claim on another task stream),
`task/stale-claim` (claim offset or branch head is not the current one),
`task/self-verdict` (critic is the claim's builder), `task/foreign-refutation`,
`task/stale-refutation`, `task/unknown-attachment`. Unknown types are 404
`unknown-action-type`; unknown versions, extra keys, or malformed refs are 422
`schema-violation`. `TASK_REFUSAL_REASONS` is the frozen list.

Role provenance is structural in this task: the event declares its role, and the door
binds the actor to the authenticated identity and separates builder and critic per
claim. Binding roles to the agent roster is E6-T07's job.

## State

`TaskState = { v, stream, taskId, issue, status, attempts[], currentClaim?, verification? }`.
`issue` is byte-for-byte the E5 `issue` reducer's state of the same stream (comments,
labels, workflow state, link metadata round-trip untouched). `attempts[n]` carries
`builder`, `startedAt`, optional `reworkOf`, `claim` (`offset, actor, run, branch,
evidence, summary`) and `verdict` (`kind, offset, actor, run, claim, branch, evidence,
findings | summary`). `verification` names the attempt, claim offset, critic and verdict
offset of the terminal `verified` state.

The reducer is total: unknown types/versions, malformed shapes, offset-less loop events,
and illegal-but-present transitions keep the prior state. Replay identity comes from the
stream id (`initialStateForStream`); the bare `initialState` has no identity and can
never accept a claim reference (fail closed).

```sh
ef replay <dump.jsonl> --digest --reducer tasks/v1 --stream-id issue:<org>/<repo>/<taskId>
```

Frozen artifacts and the verifier live in `.eforest/tasks/epic-6-the-loop/E6-T01-task-event-model/`
(`make verify-E6-T01`).
