---
id: E6-T05
epic: 6
title: "Task folders on streams: bidirectional projection without echo, drift, or side-channel status writes"
priority: 605
status: refuted
depends_on: [E6-T01, E6-T02, E6-T04]
estimate: L
capstone: false
---

## Goal

`packages/tasks` joins `.eforest` task folders to task streams: valid local specification
and Verification-log edits become validated task events through dispatch, while accepted
task/attachment events materialize deterministic `readme.md` and `evidence/` bytes on the
project branch. A provenance journal prevents projection echo, `work/` remains ephemeral,
and task status can never change by bypassing the task transition validator.

## Context

Epic 6 must preserve the folder users and agents work in while making replayed streams
authoritative. E6-T01 owns lifecycle semantics, E6-T02 owns syntax and bytes, and E6-T04
owns the queue projection. This task composes them into the same full-duplex pattern
proven by Epic 4: origin-tagged events, a total journal, measured quiescence, and exact
tree/log digest parity.

A local change to prose/spec fields dispatches `task/spec-revised`; an appended builder
or critic log entry dispatches its corresponding lifecycle event only when its structured
fields validate. Raw frontmatter status edits are requests, not authority, and are
rejected unless backed by the legal event/actor. Evidence files become E5 attachment
content streams before their references append to the task. Projected writes carry a
sync origin and may not re-dispatch themselves.

## Deliverables

- `packages/tasks/src/folder/sync.ts`, `ingest.ts`, `project.ts`, and `journal.ts` with a
  frozen canonical provenance-journal format.
- stream-fs watcher integration for task folder creation, spec revision, verification-log
  append, evidence add/remove, and deterministic projection back to the task branch.
- Refusal/conflict artifacts for malformed folders, stale spec edits, illegal status
  edits, hash mismatch, and concurrent prose edits.
- Real-server, two-client integration tests and `Makefile` target `verify-E6-T05`.

## Acceptance criteria

- [ ] `make verify-E6-T05` exits 0 cold with zero skips; its mixed local/remote schedule
      ends with task state, rendered folder, evidence manifest, and derived queue at heads
      whose canonical digests byte-equal the independently replayed streams.
- [ ] A valid local task folder creation and prose revision each append exactly one
      validated task event; projection of those events does not append an echo, proven by
      exact logical-change/event counts and a frozen head over at least 10 idle seconds.
- [ ] Editing `status: verified` locally without a critic verdict is refused, leaves the
      task and queue stream heads unchanged, and restores/projects the authoritative
      status with a stable conflict artifact naming the refusal.
- [ ] Adding arbitrary binary evidence creates one content stream whose SHA-256 matches
      the local bytes and one task attachment reference; removing a reference does not
      delete shared content, and replay reconstructs the same evidence bytes.
- [ ] Changes under `work/` cause zero task, evidence, queue, or project events and do not
      change any durable digest.
- [ ] Two clients concurrently revising the same spec from one base cannot silently
      overwrite: one fenced append wins and the loser receives a deterministic conflict
      file retaining its bytes; replay/project after resolution is identical on both.
- [ ] Every accepted input/output is represented in the provenance journal exactly once
      in its frozen disposition, and deleting derived folders then projecting from the
      streams recreates exact readme/evidence bytes.
- [ ] Browser evidence is declared `Replay: N/A (task-folder sync engine; the dedicated
      browser task surface lands in E6-T06)`; mitigation is the two-client schedule,
      measured quiescence, journal audit, byte hashes, and replay/tree digest parity.

## Adversarial verification

1. Run two independent folder watchers with racing spec, status, log, and evidence edits.
   Lost bytes, two accepted stale edits, divergent final digests, or an unjournaled action
   refutes synchronization.
2. Forge a builder Verification-log paragraph claiming a critic verdict and directly
   edit frontmatter. Any path to verified without a valid critic event refutes the sole
   mutation door.
3. Delay projected stream-fs writes beyond batching windows and leave the system idle for
   60 seconds. Any head movement after quiescence refutes provenance echo suppression.
4. Replace an evidence file after hashing but before append, and attempt symlink/path
   escapes. A reference whose digest does not match replayed content, or an outside read,
   refutes evidence integrity.
5. Disable origin filtering in a scratch worktree. The verify target must fail on exact
   event count or quiescence; green refutes sensitivity.

## Verification log

### 2026-08-31 — builder — implemented, not yet verified

- Implementation commits `452cf0d2` (engine) and `e815658b` (cold-clone target fix), on
  branch `e6-t05-task-folder-stream-sync`, stacked on the verified E6-T04 tip `a16cf4e1`.
  **The folder is the stream, both ways.** `packages/tasks/src/folder/{sync,ingest,project,journal}.ts`
  join the `.eforest/tasks` subtree of one StreamFS branch to the task streams;
  `packages/tasks/io/sync-node.ts` (`@eforest/tasks/sync-node`, beside `io/disk.ts`) is
  the only node/network boundary, so the engine core stays free of `node:fs`, sockets,
  clocks, and timers (the target greps for it fail-closed).
  **Ingest** classifies every foreign branch record under the root and turns a parseable
  folder change into validated events through the dispatch door: creation =
  `issue.opened` (body = canonical readme) + one `task.spec-revised` (base `-1`); any
  later readme write = exactly one `task.spec-revised` fenced on the revision the branch
  bytes descend from, carrying the E6-T02 canonical render, the folder path, and its
  provenance (`origin` = branch stream + fs offset); evidence files diff by path into E5
  content uploads + `evidence.attached`/`evidence.detached` (content stream addressed by
  the bytes' SHA-256; a removed reference never deletes shared content); a new
  Verification-log entry with a structured heading dispatches its lifecycle event **only**
  when the fields parse *and* the transition is legal on the simulated state.
  **`task.spec-revised`** joins the E6-T01 family versioned (`v: 1`, exact keys
  `base, folder, origin, readme, sha256`), refusing `task/stale-spec`,
  `task/spec-digest-mismatch`, `task/spec-unparseable`, `task/spec-id-mismatch`,
  `task/spec-folder-mismatch`, `task/spec-foreign-origin`; the E6-T04 queue projector now
  reads the accepted revision as the spec (`task.spec?.readme ?? issue.body`).
  **Projection** (`projectTaskFolder`) is a pure function of replayed `tasks/v1` state +
  live attachment list + content bytes: the readme is the accepted spec re-rendered with
  `status` forced to the replayed status, `evidence/**` is exactly the live content
  attachments, and every rendered path re-passes `checkRelativePath` before any writer
  sees it — closing the E6-T02 run-2 critic's observation that `writeRenderedTaskFolder`
  trusts its input (a hostile attachment name `../../evil.txt` is refused, with a test).
  **Echo suppression is provenance only:** a projected write's receipt offset is journaled
  `projected` before any later tail batch is processed, and the tail suppresses exactly
  those offsets. No debounce, mtime, or content-recency heuristic participates;
  `E6_T05_ORIGIN_FILTER_GUARD` is the sabotage sentinel. **Refusals** are stable
  artifacts under `work/.sync/{refused,conflicts}/<offset>-<n>.json` (+ `.retained`
  bytes) for malformed folders, illegal status edits, forged verdicts, and stale
  concurrent revisions.
- **Frozen provenance-journal format** (`TaskSyncJournal`, v1 canonical JSON lines, one
  SHA-256 checksum per line, contiguous `seq`): a branch offset under the root is
  `ingested` exactly once when foreign, or exactly twice (`projected` then `suppressed`)
  when own; a task/evidence record is `applied` once, plus `dispatched` once when the
  engine itself appended it. `auditTaskSyncJournal` refuses any offset outside that
  multiplicity, and any journaled offset absent from the streams. Content streams are
  digest-bound through `evidence.attached` (sealed SHA-256 = attachment SHA-256 = folder
  bytes), so they are audited by digest parity rather than per-record lines — stated as a
  deliberate scope line in `journal.ts`.
- Exact commands: `pnpm format:check` (7 pre-existing files flagged, none mine),
  `pnpm lint` (18 errors = baseline, none in changed files), `pnpm typecheck` (41 =
  baseline), `pnpm test` in foreground groups (`vitest run --maxWorkers=1`):
  protocol/client/identity/issues/evidence/streamfs/workspace/server 27 files 248 tests
  green; tasks+reducers 126 tests (the single red was `critic-attacks.test.ts` timing out
  at 1071s under host saturation — it passes solo in 662ms, 3/3); cli 229/229 green;
  apps/web 30/30 green; meadow/browser-verify/sync-harness/seed/web-hooks 67/68 (the one
  red is the pre-existing `meadow/test/links.plan.test.ts` README drift); pr 55/56 (the
  pre-existing `pr-property.fuzz.test.ts` 120s timeout); platform 248/249 (the
  pre-existing `issues.test.ts` workflow key count). Exactly the three known baseline
  failures, nothing new. `pnpm build` green. `make verify-E6-T05` green three consecutive
  runs, then `bash tools/verify/cold_clone.sh verify-E6-T05` from pristine committed HEAD
  `e815658b`: **exit 0, zero `SKIPPED:`**, `DEPENDENCY_INTEGRITY_OK`,
  `E6_T05_SCHEDULE summary-byte-identical=true`, `MUTATION … EXPECTED-FAIL OK`,
  `SABOTAGE guard=E6_T05_ORIGIN_FILTER_GUARD … EXPECTED-FAIL OK`, `verify-E6-T05: OK`,
  `PASSED from a pristine clone`. The first cold clone (against `452cf0d2`) **failed**
  and caught a real gap — the schedule imports the published server and StreamFS from
  `dist`, which no build step in the target produced from a pristine checkout; `e815658b`
  adds those two builds and is the commit the passing run is bound to.
- Evidence (in `evidence/`, hashed before/after by the verifier so nothing regenerates at
  test time): `e6-t05-summary.txt` (sha256
  `d3c211723fda5f03c368ee9d5bcb0eddbd3cf3dd53a1721a87a3ae9b0f3b2541`, 28 lines) — the
  frozen two-client schedule summary, and `e6-t05-sabotage.txt` (sha256
  `08e9bfc82ec4b0c6a9c653d65171f114a50fbcc927128397a593088a97b97aa3`) — the red
  origin-filter run. Key frozen facts inside the summary: the complete event sequence is
  exactly **`issue.opened, task.spec-revised ×3, task.started, task.claimed,
  task.spec-revised ×3, task.verified`** (10 records; one validated event per logical
  change, no echo); `final-status verified`; **task-state digest
  `c414054b6e2df7b1f3f38a1262923d43f028b0854107d030b5ad0c6b89ec505e`**; **queue digest
  `167a4f73c76dee8ec49b112f26b88d36ce7cb595ecd87bfb066ef6012043e5b3`** with
  `queue-independent-replay-equal true`; `replay-deterministic true`;
  `projection-parity files=2 byte-equal-on-both-branches=true`; evidence manifest
  `[{"name":"run.bin","sha256":"9a76b8af…43af"}]`;
  `step6-forgery` ends at `task.spec-revised` with **no `task.verified`** and
  `step6-artifacts count=3 reasons=log/role-kind-mismatch,status/illegal-edit`;
  `step7-workshop task-events-unchanged=true evidence-events-unchanged=true`;
  `step8-loser conflict-artifacts=2 retained-has-loser-bytes=true`;
  `step10-restore readme-byte-equal=true evidence-byte-equal=true detach-events=1`;
  `step11-idle window-at-least-ms=12000 measured-ok=true` with
  `heads-frozen=true write-lines-frozen=true`; `journal-a ok=true violations=0` and
  `journal-b ok=true violations=0`; `warnings … unexpected=0`.
- `make verify-E6-T05` = builds tasks/reducers/platform/server/streamfs; a fail-closed
  purity grep over `packages/tasks/src/folder` (`command grep …; test $? -eq 1`: no clock,
  RNG, env, fs, net, child_process, **or timers** — suppression may not smuggle in a
  debounce); the focused suite (21 tests in 2 files: 20 deterministic in-memory engine /
  ingest / journal / projection tests, 1 real-server two-client integration test); then
  `tools/verify/e6_t05_evidence.mjs`, which (1) re-runs the whole two-client schedule in a
  **fresh scrubbed process** (`LANG=C`, `TZ=Pacific/Kiritimati`, `NODE_ENV`/`NODE_OPTIONS`
  unset) against real servers and holds its stdout byte-for-byte to the committed summary,
  printing a line-by-line diff on drift; (2) re-asserts the load-bearing lines
  structurally; (3) parses both live journals under the frozen v1 format; (4) flips **one
  byte** of the staged evidence and requires the evidence digest and manifest to move
  (`MUTATION … EXPECTED-FAIL OK`); (5) runs the schedule with the origin filter **off**
  and requires red — either a moved event sequence/broken audit or a non-zero exit; and
  (6) re-hashes both committed artifacts to prove verification regenerated nothing.
  The schedule (`tools/verify/e6_t05_schedule.mjs`) is a mixed local/remote script over
  two branches and two principals: creation with non-canonical frontmatter → remote
  revision from B → binary evidence → a second evidence file added then removed (proving
  detach leaves the content stream sealed and its bytes reconstructable) → builder
  `started`+`claimed` in one append → the forged critic paragraph plus a raw
  `status: verified` frontmatter edit → a `work/` write → two clients revising from one
  base → the real critic verdict from B → deleting the derived folder on B → the idle
  window. Each step ends at a **quiescence barrier** (both engines settled, every branch
  record terminally journaled, two identical consecutive observations), which is what
  makes the summary deterministic: 8 consecutive identical runs (3 concurrent, 5
  sequential with scrubbed env) plus the cold clone.
- Determinism note, stated rather than hidden: raw branch head offsets and the per-client
  `own`/`foreign` journal counts depend on poll interleaving (how many intermediate
  projections client B observes), so the frozen summary asserts their **invariants** —
  heads frozen across the idle window, audits `ok=true violations=0` — not their raw
  values; the exact per-client counts go to stderr. Transient long-poll hiccups under host
  contention are likewise reported to stderr and excluded from the frozen warnings line:
  they are retried on the next tick and cannot hide misbehavior, because a missed
  projection would redden the parity, digest, and audit lines.
- Replay: N/A (task-folder sync engine; the dedicated browser task surface lands in E6-T06)
  + mitigation: the two-client real-server schedule, the measured ≥10 s idle window with
  frozen heads and frozen journal write-lines, the total journal audit under a frozen
  multiplicity, byte hashes on every evidence file and readme, projection/replay/tree
  digest parity across both branches and an independent replay, the derived-queue digest,
  the evidence-byte mutation, and the origin-filter sabotage sentinel.
- Claim: task folders and task streams are one thing in both directions. A valid local
  creation or prose revision appends exactly one validated event and its projection
  appends no echo; a Verification-log paragraph produces a lifecycle event only when its
  structured fields validate and the transition is legal, so a builder claiming a critic
  verdict — with or without a matching raw frontmatter edit — cannot reach `verified` and
  is refused with a stable artifact while authority is projected back; binary evidence
  becomes one SHA-256-addressed content stream plus one attachment reference, and removing
  the reference leaves the content replayable; `work/` moves nothing durable; two clients
  revising from one base produce one fenced winner and a deterministic conflict file that
  retains the loser's bytes, after which both branches and an independent replay agree
  byte-for-byte; every accepted input and output appears in the provenance journal exactly
  once in its frozen disposition; and deleting the derived folder and projecting from the
  streams recreates the exact readme and evidence bytes. This is a builder claim;
  independent critic verification remains required before `verified`.

### 2026-08-31 — critic — VERDICT: refuted

- **P2/P3 fenced-code-block log entries — FAILED (blocking).** Predicted, before running:
  `parseVerificationLogEntries` would track fence state the way E6-T02's section parser
  does ("fenced `## Goal` lines are ordinary body text", packages/tasks/README.md), so a
  ```` ``` ````-fenced quotation of the documented entry format inside `## Verification
  log` would be ordinary prose and dispatch nothing. Observed: it splits on any line
  starting with `### ` with no fence state at all —
  `packages/tasks/src/folder/ingest.ts:162-176` (this diff) — so quoted documentation
  becomes a real lifecycle event.
  - **CRITIC-A** (single engine, real `validateTaskEvent` door): a readme whose
    Verification log contains only the prose *"This task has not started. The entry
    format, quoted from the docs:"* followed by a fenced block containing
    `### 2026-08-31 — builder — started` / `- Run: agent-run:maple/run-doc`, then
    *"Nothing above is a real claim."*, appends
    `issue.opened, task.spec-revised, task.spec-revised, task.started` and moves the
    replayed status `pending → in-progress`.
  - **CRITIC-D** (the builder's own two-branch / two-principal shape: `agent-ash` on
    `fs:maple/loom:client-a:meta`, `agent-fern` on `fs:maple/loom:client-b:meta`): with
    the task at `implemented`, the critic appends a *`### … — critic — in-progress
    notes`* entry whose body says *"Still reviewing. For reference, a finished verdict
    looks like this:"* and then quotes, inside a fence, a complete
    `### 2026-08-31 — critic — VERDICT: verified` entry marked
    `- Summary: EXAMPLE ONLY — not a verdict.` Observed final task log
    `issue.opened, task.spec-revised, task.spec-revised, task.started, task.spec-revised,
    task.claimed, task.spec-revised, task.verified`, replayed `status: verified`,
    `verification = {attempt:1, claim:…_0000000000000005, critic:{actor:"agent-fern",
    run:"agent-run:maple/run-b"}, offset:…_0000000000000007}`. The task reached the
    terminal state from text that explicitly declares itself an example, with no verdict
    having been made.
  This refutes acceptance criterion 2 ("exactly one validated task event" per *logical*
  change — a quoted example is not one) and adversarial angle 2's refutation condition
  ("Any path to verified without a valid critic event refutes the sole mutation door"),
  and it breaks the E6-T02 fence invariant this task composes. **Demand:** make
  `parseVerificationLogEntries` fence-aware (track ```` ``` ````/`~~~` openers exactly as
  `parse.ts` does for `## ` headings, including an unterminated fence), re-record, and
  add both cases above as permanent tests — the existing forgery test
  (`packages/tasks/test/folder-sync.test.ts:184`) only covers an unfenced
  `— builder — verified` heading, and neither the 21-test focused suite nor
  `tools/verify/e6_t05_schedule.mjs` ever puts a code fence in a Verification log.
- **COVERAGE fence path — INSUFFICIENT.** `ingest.ts:162-176` and the whole
  `entryOf`/`buildLifecycleEvent` path are executed only against unfenced bodies. No
  hunk in the diff, no committed evidence line, and no schedule step exercises a readme
  whose Verification log contains a code fence, although this repository's own doctrine
  (`AGENTS.md`, `.eforest/tasks/README.md`) ships exactly such fenced examples. Add the
  coverage with the fix.
- **ORIENT digests — CONFIRMED (no finding).** Recomputed independently before reading
  the builder's prose: `node tools/verify/e6_t05_evidence.mjs` → task-state digest
  `c414054b6e2df7b1f3f38a1262923d43f028b0854107d030b5ad0c6b89ec505e`, queue digest
  `167a4f73c76dee8ec49b112f26b88d36ce7cb595ecd87bfb066ef6012043e5b3`,
  `summary-byte-identical=true`; committed artifacts re-hash to
  `d3c21172…b2541` / `08e9bfc8…7aa3` unchanged. `git diff a16cf4e1..HEAD` contains no
  `.skip`/`.todo`, no inline lint disable, no `@ts-ignore`, and no golden regenerated at
  test time.
- **MOCK & ENV — CONFIRMED (no finding).** `bash tools/verify/cold_clone.sh
  verify-E6-T05` run by this session from pristine committed HEAD `ebaf4c5c`: exit 0,
  zero `SKIPPED:`, 21/21 focused tests, `E6_T05_SCHEDULE summary-byte-identical=true`
  with the same two digests, `MUTATION … EXPECTED-FAIL OK`, `SABOTAGE … exit=1
  EXPECTED-FAIL OK`, `CANOPY_SENSITIVITY_SPINE_OK`, `DEPENDENCY_INTEGRITY_OK`,
  `verify-E6-T05 PASSED from a pristine clone` (2m45s). The `e815658b` fix is real, not
  target-narrowing.
- **APPARATUS (non-blocking, fix while reworking).** (a) The origin-filter sentinel is
  exercised only through the schedule's `--origin-filter off` flag
  (`tools/verify/e6_t05_schedule.mjs:52,201`), which the schedule always passes
  explicitly; flipping `E6_T05_ORIGIN_FILTER_GUARD` to `false` in source therefore does
  not move the schedule at all, and `verify-E6-T05` goes red only on
  `assert.equal(E6_T05_ORIGIN_FILTER_GUARD, true)`
  (`tools/verify/e6_t05_evidence.mjs:160`) — not "on exact event count or quiescence" as
  angle 5 requires. (b) `tools/verify/e6_t05_evidence.mjs:178` accepts *any* nonzero exit
  as sabotage success, so an unrelated crash satisfies the sentinel. (c)
  `tools/verify/e6_t05_evidence.mjs:140` imports `auditTaskSyncJournal` and only asserts
  it is a function — the live journals are parsed but never audited by the verifier
  itself. Not raised as blocking: the flag drives the identical branch
  (`packages/tasks/src/folder/sync.ts:299`) and the frozen summary pins the audits.
- **Observation, not a finding.** `packages/tasks/src/folder/ingest.ts:273` builds every
  ingested lifecycle event's `by.actor` from the *observing engine's* principal, not from
  the author of the branch bytes, so a verdict's actor is not provenance for who wrote
  the entry. I attempted three exploits (two watchers sharing one branch, both drain
  orders, and a shared-tail pair) and all three were stopped by the `task/stale-spec`
  fence aborting the loser's queued lifecycle dispatches
  (`packages/tasks/src/folder/sync.ts:466-468`). Recorded so the rework does not
  regress that fence; no refutation claimed.
- **SUITE: n/a until the refutation clears.** The two failing probes are kept verbatim
  (reusing the builder's `MemoryWorld`/`makeEngine` harness) at
  `.eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/work/critic/zz-critic-probe.test.ts.txt`;
  copy to `packages/tasks/test/` to reproduce.

Commands: `node tools/verify/e6_t05_evidence.mjs`;
`bash tools/verify/cold_clone.sh verify-E6-T05`;
`cp work/critic/zz-critic-probe.test.ts.txt packages/tasks/test/zz-critic-probe.test.ts && CI=true pnpm exec vitest run --maxWorkers=1 --disableConsoleIntercept -t "CRITIC" packages/tasks/test/zz-critic-probe.test.ts`
