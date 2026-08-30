# `packages/platform/src/loop` — the project state machine (E6-T03)

The authoritative project status of a hosted repository is `replay(project:<org>/<repo>)`
under the `project/v1` reducer. `.eforest/project.json` is a projection of that state
(`projectProjectionBytes`) — replay writes it, the guard never reads it.

| File                    | Role                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `project-events.ts`     | stream id, event shapes (`project.transitioned`, `loop.launch.requested`), refusal reasons |
| `project-reducer.ts`    | `ProjectState`, the total reducer, `projectReducerDefinition` (`project/v1`)               |
| `project-transition.ts` | the transition table, queue-proof verification, `validateProjectEvent` (the door)          |
| `project-guard.ts`      | `guardLoopAction` (state × loop action), the task-stream hook, refusal error classes       |
| `project-projection.ts` | the deterministic `project.json` projector                                                 |

## Actors

The dispatch door derives `by.role` from the presented credential's authorization basis:
an owner/admin **web session** (`repo-owner`, `org-owner`, `membership:admin`) is `human`;
a grant-backed bearer token (`grant:write`) is `agent`. An event whose `by.role` claims
otherwise is refused `project/role-mismatch`; `by.actor` must equal the stamped identity.

## Transitions (`project.transitioned`)

| from           | to             | who                                        |
| -------------- | -------------- | ------------------------------------------ |
| `building`     | `paused`       | human only (`project/human-required`)      |
| `building`     | `invalid_loop` | anyone                                     |
| `building`     | `complete`     | anyone, with a queue proof                 |
| `paused`       | `building`     | human only (`project/unauthorized-resume`) |
| `paused`       | `invalid_loop` | anyone                                     |
| `invalid_loop` | `building`     | human only (the recovery authorization)    |
| `complete`     | `building`     | human only (new tasks were planned)        |

Every other pair, including `to === from`, is `project/invalid-transition`. Every event
cites `expectedOffset` — the project stream head the dispatcher observed — and is refused
`project/stale-offset` when the head moved; the writer lane serializes the stream, so a
human pause and an agent launch racing at the same offset have exactly one winner.

A queue proof cites the repository issue catalog (`repo-issues:<org>/<repo>`) at its
current head and lists every loop task with its replayed status and capstone flag. The
task universe is derived from append-only history so the proving credential cannot
shrink it: an issue is a task once any `task.*` event exists on it or once it has ever
carried the `task` or `capstone` label (`issue.unlabeled` does not retract membership);
`capstone` likewise means ever-labeled. A plain issue never started and never labeled is
not a task and does not block completion. The
door replays each task stream: a stale head is `project/stale-proof`; an omitted,
invented, duplicated, or misreported task, a missing or doubled capstone, or any
non-`verified` status is `project/false-proof`.

## The cross-process fence (`project.fenced`)

A guard decision on a task stream is only as good as its ordering against the project
stream, and the single-process writer lane is not a fence across gateway processes. So
before a guarded task loop event is appended, the door commits its decision by
compare-and-appending a `project.fenced` record at the project stream's current durable
sequence (`Stream-Seq`), citing the task stream and the exact offset the event will
occupy. A human pause racing for that sequence from any other process makes the fence
conflict; the door re-reads and refuses with the winning state's reason. The project
stream is therefore one linear history in which no fence — hence no task loop event —
follows an accepted pause at that pause's sequence. Fences replay as `fences` and never
move `head`, so `expectedOffset` citations stay stable. Eight lost races refuse
`project/fence-contention` (fail closed). Clients cannot dispatch `project.fenced`.

## The loop guard

`guardLoopAction(status, action)` admits every loop action in `building` and refuses
every one otherwise: `project/paused`, `project/complete`, `project/invalid-loop`. It runs
for `loop.launch.requested` on the project stream and, through `guardTaskLoopAction`,
before the task validator for `task.started`, `task.claimed`, `task.refuted`,
`task.rework-started`, and `task.verified` on `issue:<org>/<repo>/<task>`. A refusal
cites the project stream, its head offset, and the status decided at
(`error.project`), and leaves every stream head byte-identical.

`loop.launch.requested` is the guarded loop action. It has no runtime yet (the agent
runner is E6-T07/E6-T11); this task freezes the event (`by`, `expectedOffset`, `run`)
and the guard so a launch outside `building` is impossible from the day the runtime
exists. Accepted launches are replayed as `launches` / `lastLaunch`.

`GET /api/repos/<org>/<repo>/project` returns the replayed state, its digest, and the
projection bytes.
