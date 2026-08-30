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

## Task-folder contract (`TaskFolderV1`, E6-T02)

`packages/tasks/src/folder/` parses a `.eforest/tasks/<epic>/<id>-<slug>/` tree into a
versioned `TaskFolderV1` and renders it back deterministically. It is syntax-level only
(no lifecycle state; that is the `tasks/v1` reducer above) and pure: a folder is parsed
from an inert `TaskFolderSnapshot` (`{ folderName, entries[] }`, each entry a path, a
kind, and bytes), so the same contract applies to a disk directory today
(`@eforest/tasks/disk` → `readTaskFolderSnapshot` / `writeRenderedTaskFolder`, the one
`node:fs` boundary, kept outside `src/`) and to a stream-fs tree in E6-T05.

- **Frontmatter** is a flat YAML _subset_ read by a hand-written parser, not a YAML
  library: exactly the keys `id`, `epic`, `title`, `priority`, `status`, `depends_on`,
  `estimate`, `capstone`, all required, any order on input, canonical order on output.
  Values are bare scalars or a double-quoted `title` (escapes `\"` and `\\` only);
  `depends_on` is the only list and must be inline (`[E1-T01, E2]`, no duplicates).
  Blank lines and `#` comments are accepted and dropped on render. Refused: duplicate
  keys, `&anchors`, `*aliases`, `<<:` merge keys, `!tags`, block lists/scalars, flow
  maps, nested lists, unknown keys, tabs, single quotes, `priority` with leading or
  trailing zeros, an `id` that does not match the folder name, an `epic` that does not
  match the id.
- **Sections**: exactly `## Goal`, `## Context`, `## Deliverables`,
  `## Acceptance criteria`, `## Adversarial verification`, `## Verification log`, in that
  order, each recognised only as an exact `## <Name>` line outside a code fence. Any
  other H2 (including `## Goal ` with a trailing space or an indented `   ## Goal`) is
  refused; `#`/`###` headings, `---` rules, and fenced `## Goal` lines are ordinary body
  text. An unterminated fence is refused (it would swallow every later heading). Bodies,
  the preamble before `## Goal`, and an empty Verification log are preserved verbatim
  with 1-based inclusive line spans and 0-based half-open UTF-8 byte spans.
- **Evidence** (`evidence/**`) is byte-addressed: `{ path, size, sha256 }` sorted by path,
  nested paths allowed, bytes carried on the value so render reproduces them exactly.
- **Work** (`work/**`) is a workshop inventory only: listed with sizes and hashes, never
  rendered, never in the durable digest. `taskFolderDigest` = SHA-256 of the canonical
  JSON of `{ v, folderName, frontmatter, readmeSha256, evidence manifest }`.
- **Paths**: every entry path is `seg(/seg)*` with ASCII `[A-Za-z0-9._-]` segments; refused
  are absolute paths (`/…`, `C:…`, `\…`), `.`/`..`, empty segments, backslashes, any `%`
  (percent escapes), non-ASCII, trailing `.`, segments over 255 bytes, symlinks (never
  followed by the reader; refused by the parser), special files, exact duplicates,
  file/directory clashes, and case-folded collisions (`Log.txt` vs `log.txt`). Only
  `readme.md`, `work/`, and `evidence/` may exist at the folder root.
- **Refusals** return `{ ok: false, refusal: { reason, path, line, column, message } }`
  with `reason` from the frozen `TASK_FOLDER_REFUSAL_REASONS`; nothing is rendered and
  nothing is written. `parseTaskFolder` never throws for malformed input.
- **Canonical round trip**: `render(parse(x))` is a fixed point of `parse ∘ render`, and
  `parse(render(parse(x)))` equals `parse(render(parse(render(parse(x)))))`; frozen
  fixtures and 1,000 generated folders (`generateTaskFolder(seed)`) are held to this in
  `make verify-E6-T02`.

The loop ledger keys that `work-queue` appends to some readmes in this repository
(`verification_run_ceiling`, …) are outside the README contract and are refused as
unknown keys; E6-T03/E6-T04 decide where that ledger lives as events.

## Queue projection (`queue/v1`, E6-T04)

`packages/tasks/src/queue/` derives a repository's ordered task queue from its streams
alone: `projectQueue({ catalog, tasks })` replays the issue catalog
`repo-issues:<org>/<repo>` and every task stream it lists under `tasks/v1`, orders the
members, decides "what is next", and cites every source head it consumed. There is no
queue table: `GET /api/repos/<org>/<repo>/queue` rebuilds the projection on every call
and returns `{ streamId, offset, digest, projection, proof, markdown }`. Deleting every
derived artifact (`queue.json`, `QUEUE.md`, `queue.digest`, `proof.json`) loses nothing
that replay of the sources does not rebuild byte-for-byte, in any per-stream-consistent
fetch order (`make verify-E6-T04` rebuilds in three fresh processes, two of them shuffled).

- **Membership** is E6-T03's: an issue is a task once any `task.*` event exists on it or
  it has ever carried the `task` or `capstone` label. A plain issue is not a task.
- **Spec** (`epic`, `priority`, `title`, `depends_on`, `capstone`) is the E6-T02 task
  readme carried in the issue body, parsed by `parseTaskReadme`. The body's frontmatter
  `status` is text, never authority: **status is the replayed `tasks/v1` state**. The
  readme's `capstone` flag must agree with the `capstone` label (`capstone/label-disagrees`).
- **Order** is ascending numeric priority (exact decimal comparison, no floats), then id.
- **Dependencies**: `E<n>-T<nn>` is satisfied only by a `verified` task; a bare `E<n>` only
  by that epic's unique `verified` capstone (`E6_T04_BARE_EPIC_GUARD`). Everything else
  blocks with an exact reason on the task: `dep/unverified` (+ the dependency's status),
  `dep/missing`, `dep/duplicate-ref`, `dep/epic-missing`, `dep/epic-no-capstone`,
  `dep/epic-multiple-capstones`, `dep/epic-capstone-unverified`, `status/not-startable`.
- **Decision** (`projection.decision`): `eligible {nextEligible}` when no task is active;
  `in-flight {inFlight}` while one task is `in-progress`/`implemented` (or `refuted` with
  unmet dependencies) — no second task is ever eligible; `rework` when the one active
  task is `refuted` with its dependencies verified (it is the next task, exactly as
  `build_queue.py`'s current gate); `exhausted` only when every member is `verified`; and `invalid
{violations}` — deliberately without a `nextEligible` key — for cycles (`dep/cycle`, every member listed; a bare `E<n>` reference is an edge to each capstone of that epic, so a cycle through an epic — or a capstone depending on its own epic — is a cycle), a deadlock (`dep/deadlock`: nothing active, nothing startable, work still `pending` — a queue that can never advance is never reported as "nothing left"), missing task/epic references, duplicate ids, more than one active
  task, more than one capstone in an epic, a capstone that is not its epic's final task,
  a completed epic with no capstone, a fractional priority without a `Queue-jump reason:`
  line in the Context section, an unparseable spec, an id mismatch, or a corrupt catalog.
- **Proof** (`queueProof(projection)`): `{ v, queue: {stream, offset}, heads[], tasks[]
({id, status, capstone}: E6-T03's `ProjectProofTask`), finalCapstone, digest, decision }`.
  `checkQueueProof(proof, sources)` re-derives from the current sources and refuses a
  moved head as `queue/stale-proof` (naming the stream, the cited and the current offset)
  before anything else, and a forged digest/decision as `queue/false-proof`;
  `admitSelection(proof, id, sources)` additionally requires the fresh, valid proof to name
  `id` as `nextEligible` (`queue/not-eligible`, `queue/invalid`).
- **Markdown** (`renderQueueMarkdown`) is `QUEUE.md`-shaped: for a valid graph it is
  byte-identical to what `tools/build_queue.py` writes for the same tasks, generator line
  aside (links are the stream-side `epic-<n>/<id>/readme.md`). An invalid queue renders
  its violations in place of the gate/next-up/unlocks sections.
- **Differential**: `QueueGraph` fixtures (`evidence/fixtures/graphs/*.json`) feed both
  implementations — `queueSourcesFromGraph` builds the streams, `graphReadme` the folder
  tree — and `tools/verify/queue_differential.py` runs the unmodified `build_queue.py`
  over that tree and normalizes its `QUEUE.md`; `normalizeQueueDecision` is the
  TypeScript side. `generateQueueGraph(seed, {cyclic})` is the seeded graph fuzzer.

### Seams against `tools/build_queue.py` (documented, not hidden)

- Python cannot represent an invalid proof: on a cycle or a deadlock it prints an empty
  "Next up" and selects nothing. Invalid frozen graphs are therefore held to the decision
  the spec requires (`invalid`) and are not compared to Python; the tuples still agree.
- Python parses priorities as `float`, so two legal priorities that collapse to one double
  (`101.10000000000000001` vs `101.1`) tie there and fall back to path order, while the
  projector compares the decimals exactly. Parity holds for every priority representable
  as a double.
- Python strips everything after `#` in a frontmatter value, so a title containing ` #`
  (`Fix regression #12`) is truncated in its `QUEUE.md` line; ids, statuses, priorities,
  and dependencies still agree. The differential criterion is the decision and the ordered
  task/status/dependency tuples, so this only affects markdown byte parity.

Frozen artifacts and the verifier live in
`.eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/` (`make verify-E6-T04`).
