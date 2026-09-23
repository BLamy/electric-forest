---
id: E6-T05
epic: 6
title: "Task folders on streams: bidirectional projection without echo, drift, or side-channel status writes"
priority: 605
status: implemented
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

### 2026-08-31 — builder — rework after critic run 1 (implemented)

- Rework commit `127bf5f0`, on `e6-t05-task-folder-stream-sync` (parent `d1d5d6d3`).
  **The refutation is accepted in full and fixed at its root.** `parseVerificationLogEntries`
  split on any line beginning `### ` with no fence state, so a fenced quotation of the
  documented entry format became a real lifecycle claim — CRITIC-A drove
  `pending → in-progress` from prose that says *"Nothing above is a real claim"*, and
  CRITIC-D reached terminal `verified`, with `verification.critic.actor` set, from a
  fenced block explicitly marked *"EXAMPLE ONLY — not a verdict."* That is a path to
  `verified` without a critic verdict, and it broke the E6-T02 fence invariant this task
  composes.
- **Fix — one fence machine, shared, not duplicated.** E6-T02's fence state machine is
  now `scanFences` (exported from `packages/tasks/src/folder/parse.ts`), and **both**
  readers consume it: `parseSections` (`##` headings) lost its inline copy and calls the
  shared scanner, and the E6-T05 log parser recognises `### ` entry headings only outside
  a fence. A readme therefore agrees with itself about what is code: exactly as a fenced
  `## Goal` is ordinary body text, a fenced `### <date> — <role> — <kind>` is
  documentation. It handles ``` and `~~~` fences of 3+ chars, longer closers, info
  strings, and up-to-3-space indented fences, as far as E6-T02 already does; an
  unterminated fence **fails closed** (nothing after it is a heading, so ambiguous text
  dispatches nothing). Two further hardenings fell out of writing the tests:
  structured fields are read only from **unfenced** lines, so a fenced example inside a
  real entry cannot supply or spoof that entry's `- Run:`/`- Branch:`/`- Evidence:`; and
  an entry is a lifecycle claim only when its heading names a **recognised kind**, so an
  honest human note (`### … — critic — in-progress notes`) is prose rather than a
  refusal — while a recognised kind is still bound to its role, keeping
  `— builder — verified` refused.
- **Permanent tests, all sensitivity-checked.** The critic's two cases are committed
  verbatim in spirit as `CRITIC-A` and `CRITIC-D` (`packages/tasks/test/folder-sync.test.ts`),
  asserting not merely "no event" but **complete inertness** — a quoted example is not
  even a *refused* claim, so no refusal artifact appears. Added: fence-variant coverage
  (```` ``` ````, `~~~`, ````` ```` `````, ```` ```markdown ````, indented, longer
  closer), the unterminated-fence fail-closed case, the field-spoofing case, and a
  **regression fixture over this repository's own doctrine files** — `AGENTS.md` and
  `.eforest/tasks/README.md` ship exactly such fenced examples, and the parser must find
  zero lifecycle entries in them while still recognising the real unfenced entries of a
  live task readme (E6-T04's). Reverting the one-line fence check turns **five** of these
  red (both critic repros included); with the fix, 28/28 focused tests pass. Running the
  critic's own probe file unmodified now reports CRITIC-A `status: pending`, CRITIC-B/C/D
  `status: implemented`, `verification: undefined`, 4 passed.
- **Schedule step 6b** puts a fenced example — a complete `VERDICT: verified` in a ```` ``` ````
  block plus a `~~~text` block — into a live Verification log at `implemented`:
  `step6b-fenced lifecycle-events-added=0 status=implemented` and
  `text-revised-only=true refusal-artifacts=3` (the 3 are step 6's forgery artifacts;
  the fenced note adds none). The final sequence gains exactly one `task.spec-revised`,
  because quoted documentation is still a legitimate *text* revision.
- **Apparatus notes (a)/(b)/(c) closed.** (a) `E6_T05_ORIGIN_FILTER_GUARD` now gates the
  production path — the effective filter is `GUARD && (originFilter ?? true)`, which no
  caller can weaken upward — so flipping it to `false` **in source** and rebuilding makes
  the schedule fail on non-convergence of the exact event schedule (`TIMEOUT step5
  implemented`) and `e6_t05_evidence.mjs` exit 1, which is what angle 5 demands; the
  transcript `e6-t05-sabotage.txt` is re-recorded from that real source flip and now
  documents both the source-level and flag-level sabotage. (b) the verifier asserts the
  sabotage fails in its **one expected shape** (non-convergence) and explicitly refuses
  an unrelated crash (`ERR_MODULE_NOT_FOUND`/`SyntaxError`/`ReferenceError`). (c) the
  verifier now **audits both live journals itself** — the schedule writes an
  `audit-input.json` naming the branch and stream offset universe, and the verifier runs
  `auditTaskSyncJournal` over each journal, asserting `violations=[]`, `ok=true`, and
  non-trivial own/foreign/applied counts (`audited-branch-offsets=70 violations=0` cold).
- **`by.actor` provenance limitation, documented as the critic asked.** An ingested
  lifecycle event's `by.actor` is the **observing engine's authenticated principal**, not
  the author of the branch bytes: the door binds `by.actor` to the credential that
  dispatched, so the actor proves *who submitted the event*, never *who typed the
  paragraph*. On a shared branch this is only prevented from becoming a forgery by the
  `task/stale-spec` fence aborting the loser's queued lifecycle dispatches
  (`packages/tasks/src/folder/sync.ts`), which the critic probed three ways without
  success and which this rework deliberately preserves (the CRITIC-D test asserts the
  fence's refusal artifacts stay free of `log/*` reasons rather than demanding none).
  Binding a paragraph's author to an identity needs signed authorship, which is E6-T07's
  agent-run protocol, not this task's contract. Recorded here as a known boundary.
- Exact commands: `pnpm format:check` (7 pre-existing files, none mine), `pnpm lint`
  (18 = baseline, none in changed files), `pnpm typecheck` (41 = baseline), focused
  suites in the foreground — `packages/tasks/test` 10 files/105 tests green,
  `platform/test/{task-folder-sync,tasks,task-queue,project-state}` 4 files/14 tests
  green, `reducers`+`evidence`+`issues` 15 files/81 tests green — `pnpm build` green,
  `make verify-E6-T05` green, then `bash tools/verify/cold_clone.sh verify-E6-T05` from
  pristine committed HEAD `127bf5f0`: **exit 0, zero `SKIPPED:`**, 28/28 focused tests,
  `E6_T05_SCHEDULE summary-byte-identical=true`,
  `E6_T05_JOURNALS … audited-branch-offsets=70 violations=0`,
  `MUTATION … EXPECTED-FAIL OK`, `SABOTAGE … EXPECTED-FAIL OK`,
  `DEPENDENCY_INTEGRITY_OK`, `PASSED from a pristine clone`.
- Evidence re-recorded: `e6-t05-summary.txt` (sha256
  `2532248e7fda03b3fab2f303ebdda7efd6f12e895e6bd7bd80ba274208f995f1`) — **task-state
  digest `7926e4ddd95c8ef7f42355d186c85803c31ee633a914dd7d594e408e9d2dfd5b`**, **queue
  digest `aedebe8487ca9aee6a2b3d4c996379fa36bf7507476b1897da284b9fa4422a66`**, final
  sequence `issue.opened, task.spec-revised ×3, task.started, task.claimed,
  task.spec-revised ×4, task.verified` (11 records — one more `task.spec-revised` than
  run 1, which is step 6b's fenced note landing as text and nothing else),
  `final-status verified`, `replay-deterministic true`,
  `projection-parity … byte-equal-on-both-branches=true`, `step11-idle
  window-at-least-ms=12000 measured-ok=true` with `heads-frozen=true
  write-lines-frozen=true`, both journal audits `ok=true violations=0`,
  `warnings … unexpected=0`; and `e6-t05-sabotage.txt` (sha256
  `bc79dddf05a2bc50ff7d11a2ee61a63e0021c6098abf92129640e037290e8622`). Determinism re-established: the summary was
  regenerated and reproduced byte-identically, plus the cold clone's independent run.
- One honest note on process: my first regenerated summary was produced against a **stale
  `dist`** and briefly froze bytes showing `refusal-artifacts=6` and `unexpected=2` — the
  fenced entries were still being parsed by the built output. Rebuilding and re-running
  produced the committed bytes (`refusal-artifacts=3`, `unexpected=0`); the schedule's
  own `unexpected warnings` reporting is what surfaced it, and the committed artifact is
  from the correct build, as the cold clone independently confirms.
- Replay: N/A (task-folder sync engine; the dedicated browser task surface lands in E6-T06)
  + mitigation: the two-client real-server schedule including the new fenced-entry step,
  the measured ≥10 s idle window with frozen heads, the verifier's own journal audits,
  byte hashes, projection/replay/queue digest parity, the evidence-byte mutation, and a
  source-level origin-filter sabotage that fails on the event schedule itself.
- Claim: quoted documentation is inert. A fenced `### … — <role> — <kind>` block in a
  Verification log — the shape this repository's own doctrine ships — revises text and
  dispatches nothing, on both the parser and the real dispatch door, with the two cases
  the critic used as permanent regression tests and a fixture over the real files. The
  remaining E6-T05 behavior is unchanged and re-proven from a pristine clone. This is a
  builder claim; independent critic verification remains required before `verified`.

### 2026-08-31 — critic run 2 — VERDICT: refuted

- **P1 quoted-documentation inertness — FAILED (blocking).** Predicted, before running:
  the rework's stated invariant ("a readme agrees with itself about what is code";
  "quoted documentation is inert") would hold for every construct a markdown reader
  renders as non-structure, not only for the two the fence scanner knows. Observed: the
  shared scanner recognises exactly ``` / ~~~ fences
  (`FENCE_PATTERN`, `packages/tasks/src/folder/parse.ts:46,637-664`) and
  `parseVerificationLogEntries` splits on any unfenced line starting `### `
  (`packages/tasks/src/folder/ingest.ts:171-186`, this diff). Markdown **HTML blocks**
  are not tracked at all, so a `### <date> — <role> — <kind>` line inside an HTML
  comment or a `<pre>` block — text that CommonMark renders as an invisible comment or
  as literal preformatted code, never as a heading — is still a lifecycle claim. Both of
  critic run 1's repros reproduce verbatim with the fence swapped for `<!-- -->` or
  `<pre>`:
  - **CRITIC2-A2** (single engine, real dispatch door, run 1's CRITIC-A text unchanged):
    a readme whose Verification log says *"This task has not started. The entry format,
    quoted from the docs:"*, then an HTML comment containing
    `### 2026-08-31 — builder — started` / `- Run: agent-run:maple/run-doc`, then
    *"Nothing above is a real claim."* appends
    `issue.opened, task.spec-revised, task.spec-revised, task.started` and moves the
    replayed status `pending → in-progress`. Identical with `<pre>`/`</pre>`. The
    committed ``` control stays inert (`extra=1`, `status=pending`), which is exactly
    the point: the fix is a syntax special case, not the invariant it claims.
  - **CRITIC2-E / CRITIC2-F** (run 1's CRITIC-D shape: `agent-ash` on
    `fs:maple/loom:client-a:meta`, `agent-fern` on `fs:maple/loom:client-b:meta`, task at
    `implemented`): the critic appends an honest
    `### 2026-08-31 — critic — in-progress notes` entry whose body says *"Still
    reviewing. For reference, a finished verdict looks like this:"* and then wraps a
    complete `### 2026-08-31 — critic — VERDICT: verified` (marked
    `- Summary: EXAMPLE ONLY — not a verdict.`) in `<!-- -->` instead of a fence.
    Observed final log `issue.opened, task.spec-revised, task.spec-revised, task.started,
    task.claimed, task.spec-revised, task.verified`, replayed `status: verified`,
    `verification = {attempt:1, claim:…_0000000000000004, critic:{actor:"agent-fern",
    run:"agent-run:maple/run-b"}, offset:…_0000000000000006}`. Same with `<pre>`; the
    ``` control stays `implemented`, `verification: undefined`.
  This refutes adversarial angle 2's refutation condition ("Any path to verified without
  a valid critic event refutes the sole mutation door") and acceptance criterion 2
  ("exactly one validated task event" per *logical* change — a block marked EXAMPLE ONLY
  is not one), on the same evidence standard run 1's refutation was accepted under. The
  HTML-comment variant is strictly worse than the fenced one it replaces: the comment
  **renders as nothing**, and projection re-renders the accepted spec verbatim, so the
  projected `readme.md` carries `status: verified` (or `in-progress`) with **no visible
  entry anywhere in its Verification log** — folder and stream disagree in the rendered
  bytes, which is the "drift" this task's own title forbids. Repro (both files kept
  verbatim, reusing the builder's `MemoryWorld`/`makeEngine` harness):
  `work/critic2/zz-critic2-probe.test.ts.txt` (`CRITIC2-A2`, `CRITIC2-E`, `CRITIC2-F`,
  plus a passing ``` control in each group) and the standalone parser probe
  `work/critic2/probe-parser.mjs`. **Demand:** close this as a general invariant rather
  than a third syntax patch — recognise a `### ` entry heading only where a CommonMark
  block parser would (HTML blocks 1-6 included, at minimum `<!-- … -->` and the raw-text
  tags), or invert the rule so an entry is a lifecycle claim only when it appears in a
  positively-recognised structural position; then commit CRITIC2-A2/E/F as permanent
  tests beside CRITIC-A/CRITIC-D and add the construct to `tools/verify/e6_t05_schedule.mjs`
  step 6b the way the fence was added.
- **COVERAGE HTML-block path — INSUFFICIENT.** `ingest.ts:171-186` and
  `parse.ts:637-664` are exercised only against ``` / ~~~ input: the 28-test focused
  suite (`packages/tasks/test/folder-sync.test.ts:139-198`), the doctrine fixture
  (`:201-229`) and schedule step 6b all vary the fence character, never the block
  *kind*. No hunk in the diff, no committed evidence line, and no schedule step puts an
  HTML comment or a `<pre>` block in a Verification log — although `AGENTS.md` itself
  ships HTML comments (`AGENTS.md:8-9`). Add the coverage with the fix.
- **ORIENT digests — CONFIRMED (no finding).** Recomputed independently before reading
  the builder's prose: `make verify-E6-T05` from a full source rebuild →
  `E6_T05_SCHEDULE summary-byte-identical=true task-digest=`
  `7926e4ddd95c8ef7f42355d186c85803c31ee633a914dd7d594e408e9d2dfd5b`
  `queue-digest=aedebe8487ca9aee6a2b3d4c996379fa36bf7507476b1897da284b9fa4422a66`;
  `shasum -a 256` of the committed artifacts after the run =
  `2532248e…f995f1` (summary) and `bc79dddf…290e8622` (sabotage), unchanged — nothing
  regenerated at test time. `git diff a16cf4e1..HEAD` contains no `.skip`/`.todo`, no
  inline eslint disable, and no `@ts-ignore`/`@ts-expect-error`.
- **Stale-`dist` incident — CONFIRMED CLEAN (no finding).** The builder's disclosed
  stale-`dist` summary left no blessed bytes: `make verify-E6-T05` rebuilds
  tasks/reducers/platform/server/streamfs from source before the schedule and still
  reports `summary-byte-identical=true`, and `bash tools/verify/cold_clone.sh
  verify-E6-T05` run by this session from pristine committed HEAD `fba13c81` reproduces
  both digests: exit 0, zero `SKIPPED:`, 28/28 focused tests,
  `E6_T05_JOURNALS … violations=0`, `MUTATION … EXPECTED-FAIL OK`,
  `SABOTAGE … exit=1 EXPECTED-FAIL OK`, `CANOPY_SENSITIVITY_SPINE_OK`,
  `DEPENDENCY_INTEGRITY_OK`, `PASSED from a pristine clone`.
- **E6-T02 not regressed by the shared scanner — CONFIRMED (no finding).** Predicted the
  `scanFences` extraction is behaviour-preserving for `parseSections` (old code
  `continue`d on opener/body/closer lines; the new code marks the same three cases
  `fenced` and skips them). `make verify-E6-T02` green: `E6_T02_FIXTURES entries=54
  sha256-list-identical=true`, three goldens `byte-identical=true`,
  `E6_T02_REFUSALS scenarios=70 reasons=37 transcript-identical=true`,
  `E6_T02_PROPERTY cases=1000 corpus-sha256=3158c855… byte-identical=true`.
- **Apparatus fixes (a)(b)(c) — ALL THREE CONFIRMED REAL (no finding).** (a) I flipped
  `E6_T05_ORIGIN_FILTER_GUARD` to `false` **in source**
  (`packages/tasks/src/folder/sync.ts:61`), rebuilt, and ran
  `node tools/verify/e6_t05_evidence.mjs`: it fails on the schedule itself —
  `Error: schedule timed out waiting for step5 implemented`
  (`tools/verify/e6_t05_schedule.mjs:304`), i.e. non-convergence of the exact event
  schedule, which is what angle 5 demands; source restored and rebuilt. (b) I made the
  sabotaged run fail a *different* way (a `ReferenceError` thrown from the schedule's
  flag parsing under `--origin-filter off`): the verifier rejected it —
  `AssertionError … expected: /TIMEOUT step\d|schedule timed out waiting for/`,
  `sabotage must fail by non-convergence, not by an unrelated error`
  (`tools/verify/e6_t05_evidence.mjs:225-236`). (c) I injected a violation into a live
  journal (dropped the tail record of `journal-a.jsonl` after the schedule wrote it, so
  the schedule's own `journal-a ok=true violations=0` line and the whole frozen summary
  stayed byte-identical): the verifier's independent audit went red —
  `journal-a violates the frozen multiplicity:
  ["fs:maple/loop:client-a:meta@0000000000000000_0000000000000034: projected"]`
  (`tools/verify/e6_t05_evidence.mjs:170`). All three probe patches were applied to
  copies and reverted with `cp` from `work/critic2/*.orig`; `git status` shows no
  task-path modification.
- **Parser edge cases beyond the finding — CONFIRMED (no finding).** `work/critic2/probe-parser.mjs`
  drove `parseVerificationLogEntries` directly with my own inputs: a `~~~` fence
  containing ``` (and the converse), an info string containing `###`, a 4-backtick fence
  containing 3-backtick lines, 3-space-indented fences, a closer carrying an info string,
  an unterminated fence at EOF, an entry heading immediately after an unterminated fence,
  fences inside blockquotes and list items, and `` ``` ``` `` (not a CommonMark opener) —
  all inert, none dispatching. Structured fields are genuinely unfenced-only: a fenced
  `- Run: agent-run:spoof/x` inside a real `started` entry does not supply or override
  that entry's `- Run:`, and a real entry whose `- Run:` appears only *after* a fenced
  block is still read correctly. Kind/role binding holds: `— builder — verified` is
  refused `log/role-kind-mismatch`, `— critic — refuted` is accepted only for a critic,
  hyphen-separated headings and the prefix kind `verifiedly` produce no kind and are
  silently inert, and `— critic — VERIFIED` (case) is recognised. CRLF never reaches the
  log parser (`readme/crlf` refuses it upstream, `parse.ts:279-281`). This repository's
  `AGENTS.md`, `.eforest/tasks/README.md`, `CLAUDE.md`, `.eforest/loop.md` and
  `packages/tasks/README.md` all yield **zero** lifecycle entries through the parser,
  while all 62 live task readmes still yield their real unfenced entries.
- **Observation, not a blocking finding.** This task's own `readme.md` does not parse
  through the engine it builds: at HEAD `parseTaskReadme` refuses it
  `sections/unterminated-fence` at line 235 — critic run 1's prose contains an inline
  code span whose backtick run the shared `FENCE_PATTERN`
  (`packages/tasks/src/folder/parse.ts:46`) reads as a 4-backtick fence opener, which
  CommonMark does not (a backtick fence's info string may not contain backticks). The
  effect is fail-closed (everything after it, including the builder's rework entry, is
  invisible and dispatches nothing), so no forged claim follows from it — but it means
  the rework's regression fixture proves round-tripping only for E6-T04's readme
  (`packages/tasks/test/folder-sync.test.ts:223-229`), not for E6-T05's. Extend that
  fixture to this folder's own readme when reworking; 26 other task readmes are refused
  for pre-existing frontmatter/section drift unrelated to this diff and are not raised.
- **SUITE: n/a until the refutation clears.** The three failing probes plus their passing
  backtick-fence controls are kept verbatim at
  `.eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/work/critic2/zz-critic2-probe.test.ts.txt`;
  copy to `packages/tasks/test/` to reproduce.

Commands: `make verify-E6-T05`; `make verify-E6-T02`;
`bash tools/verify/cold_clone.sh verify-E6-T05`;
`node .eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/work/critic2/probe-parser.mjs`;
`cp .eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/work/critic2/zz-critic2-probe.test.ts.txt packages/tasks/test/zz-critic2-probe.test.ts && CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run --maxWorkers=1 --disableConsoleIntercept -t "CRITIC2" packages/tasks/test/zz-critic2-probe.test.ts`

### 2026-08-31 — builder — rework after critic run 2 (implemented)

- Rework commit `2242697c`, on `e6-t05-task-folder-stream-sync` (parent `bfdaa8fd`).
  **The refutation is accepted in full, and so is its diagnosis: run 1's fix was a syntax
  special case wearing the language of an invariant.** Swapping the wrapper for
  `<!-- -->` or `<pre>` reproduced both repros verbatim, including terminal `verified`
  from a block marked *"EXAMPLE ONLY"*; and the HTML-comment variant is worse than the
  fence it replaced, because a comment renders as nothing, so the projected `readme.md`
  carried a status with **no visible entry anywhere** — folder and stream disagreeing in
  the rendered bytes, which is exactly the drift this task's title forbids.
- **Fix — one scanner over block structure, not a third quoting syntax.** `scanFences` is
  replaced by **`scanInertBlocks`** (`packages/tasks/src/folder/parse.ts`), and **both**
  readers consume it — `parseSections` for `##` and `parseVerificationLogEntries` for
  `###` — so a readme keeps agreeing with itself about what is inert. It classifies every
  construct that can swallow a line beginning at column 0, which is the only line either
  heading rule can match: **fenced code** (3+ backticks or tildes, longer-or-equal
  closer, no info string on the closer); **HTML blocks 1-5**, which swallow arbitrary
  content to an explicit end condition — `<pre>`/`<script>`/`<style>`/`<textarea>`,
  `<!-- -->`, `<? ?>`, `<!DECLARATION>`, `<![CDATA[ ]]>`; and **HTML blocks 6-7**
  (block-level tags, and any complete tag alone on a line), which end at a blank line.
  Constructs that indent or prefix their content — indented code, block quotes, list
  items — cannot produce a column-0 heading line at all, so they need no state, and that
  is stated in the scanner's contract rather than left implicit. An unterminated block
  stays inert to end of input: ambiguous text is never structure, so a swallowed section
  is refused `sections/missing` and a swallowed log entry simply does not exist —
  **fail closed in both directions**.
- **The run-2 observation is fixed by the same change, not patched around.** Per
  CommonMark a backtick fence's info string may not contain a backtick, so an inline code
  span quoting a fence in prose is no longer read as an opener. This task's own
  `readme.md` now parses through the engine it builds, and it has joined E6-T04's in the
  fixture, which additionally asserts the **E6-T02 round trip** (`render(parse(x))` is a
  fixed point of `parse` after `render`) rather than only that it parses.
- **Coverage now varies block KIND, as demanded.** `CRITIC-A/A2` runs run 1's text over a
  code fence, `<!--`, `<pre>`, `<script>`, `<![CDATA[`; `CRITIC-D/E/F` runs the
  two-branch verdict-quoting shape over a code fence, `<!--`, `<pre>`. The parser test
  covers 20 wrapper variants across both families (including `<PRE>` case-insensitivity,
  `<pre class="x">`, indented `<!--`, `<?php`, `<!DOCTYPE`, `<div>`, `<table>`), the
  unterminated-HTML fail-closed case, and the inline-code-span case. The doctrine fixture
  grew from two files to five — `AGENTS.md`, `.eforest/tasks/README.md`, `CLAUDE.md`,
  `.eforest/loop.md`, `packages/tasks/README.md` — all yielding **zero** lifecycle
  entries, and it now asserts `AGENTS.md` really ships HTML comments so the fixture
  cannot quietly stop testing anything. Schedule **step 6b** wraps example entries in an
  HTML comment and a `<pre>` block beside the two fences
  (`step6b-inert lifecycle-events-added=0 status=implemented`,
  `text-revised-only=true refusal-artifacts=3`).
- **Sensitivity.** Deleting the HTML-comment branch turns **3** tests red (the wrapper
  matrix, the unterminated-HTML case, and the `<!--` case of `CRITIC-A/A2`). Running the
  critic's own probe file unmodified reports `CRITIC2-A2 "<!--" status= pending … extra= 1
  artifacts= 0`, the same for `<pre>` and the code-fence control, and
  `CRITIC2-E`/`CRITIC2-F` `status= implemented verification= undefined`; 7 passed.
  One honest note: **lint**, not my own reading, caught that my first parameterisation of
  `CRITIC-D/E/F` had substituted the wrappers into `CRITIC-A`'s body, leaving the D family
  still hardcoded to one syntax. It is fixed and the wrappers genuinely vary; had the
  unused-parameter rule not fired, that family would have shipped looking parameterised
  while testing a single case.
- **No E6-T02 regression, proven not asserted.** `make verify-E6-T02` green after the
  shared-scanner change: `E6_T02_FIXTURES entries=54 sha256-list-identical=true`, three
  goldens `byte-identical=true`, `E6_T02_REFUSALS scenarios=70 reasons=37
  transcript-identical=true`, `E6_T02_PROPERTY cases=1000 corpus-sha256=3158c855…
  byte-identical=true`, `E6_T02_ARTIFACTS protected=10 unchanged=true`.
- Exact commands: `pnpm format:check` (7 pre-existing files, none mine), `pnpm lint`
  (18 = baseline; it transiently read 20 with the two real errors above, now cleared),
  `pnpm typecheck` (41 = baseline), focused suites in the foreground —
  `packages/tasks/test` 10 files/114 tests green, `platform/test/{task-folder-sync,tasks,
  task-queue}` plus `reducers` 8 files/33 tests green — `pnpm build` green,
  `make verify-E6-T02` green, `make verify-E6-T05` green, then
  `bash tools/verify/cold_clone.sh verify-E6-T05` from pristine committed HEAD
  `2242697c`: **exit 0, zero `SKIPPED:`**, **37/37** focused tests,
  `E6_T05_SCHEDULE summary-byte-identical=true`,
  `E6_T05_JOURNALS … audited-branch-offsets=70 violations=0`,
  `MUTATION … EXPECTED-FAIL OK`, `SABOTAGE … EXPECTED-FAIL OK`,
  `DEPENDENCY_INTEGRITY_OK`, `PASSED from a pristine clone`.
- Evidence re-recorded: `e6-t05-summary.txt` (sha256 `d155f866e751b5cb0e1532f2a53ee62aa1d8b536272c1508935a668ece32ea5b`) — **task-state digest
  `a3de03ff21507fca156df43cf8bf17f8bd698e0ec2fa8555e4d87d9979bf360c`** (moved from run 1
  because step 6b's note now carries the HTML blocks too), **queue digest
  `aedebe8487ca9aee6a2b3d4c996379fa36bf7507476b1897da284b9fa4422a66`** (unchanged — the
  queue does not depend on log prose), final sequence `issue.opened, task.spec-revised x3,
  task.started, task.claimed, task.spec-revised x4, task.verified` (11 records,
  `final-status verified`), `replay-deterministic true`,
  `projection-parity … byte-equal-on-both-branches=true`,
  `step11-idle window-at-least-ms=12000 measured-ok=true` with `heads-frozen=true
  write-lines-frozen=true`, both journal audits `ok=true violations=0`,
  `warnings … unexpected=0`; `e6-t05-sabotage.txt` (sha256 `bc79dddf05a2bc50ff7d11a2ee61a63e0021c6098abf92129640e037290e8622`) unchanged.
- **Scope boundary, stated plainly.** This is a scanner over the block constructs that can
  swallow a column-0 line, not a full CommonMark implementation: it does not model link
  reference definitions, tables, or setext headings, none of which can hide a heading line
  at column 0. Anything it cannot classify is ordinary prose *for heading recognition
  only* — which is why the positive rules above are exhaustive over that one question, and
  why an unterminated block is inert rather than optimistically reopened. The `by.actor`
  provenance limitation recorded in run 1 is unchanged and still bounded by the
  `task/stale-spec` fence; signed authorship remains E6-T07's.
- Replay: N/A (task-folder sync engine; the dedicated browser task surface lands in E6-T06)
  + mitigation: the two-client real-server schedule including step 6b's four block kinds,
  the measured >=10 s idle window with frozen heads, the verifier's own journal audits,
  byte hashes, projection/replay/queue digest parity, the evidence-byte mutation, a
  source-level origin-filter sabotage, and `verify-E6-T02`'s frozen corpus proving the
  shared scanner changed no E6-T02 behavior.
- Claim: quoted documentation is inert **as a property of block structure**, not of a list
  of syntaxes. A `### <date> — <role> — <kind>` inside a code fence, an HTML comment,
  `<pre>`, `<script>`, `<style>`, `<textarea>`, CDATA, a processing instruction, a
  declaration, or a block tag revises text and dispatches nothing — on the parser, on the
  real dispatch door, and in a live two-client schedule — with the critic's run-1 and
  run-2 cases as permanent regression tests and this repository's own doctrine files as
  the fixture. This is a builder claim; independent critic verification remains required
  before `verified`.

### 2026-08-31 — critic run 3 — VERDICT: refuted

- **P1 block-structure invariant, HTML block 7 — FAILED (blocking).** Predicted, before
  running anything: if the rework's claim is real ("quoted documentation is inert **as a
  property of block structure**, not of a list of syntaxes", and the scanner's stated
  contract "HTML blocks 6-7 (block-level tags, and any complete tag alone on a line)"),
  then for every input a CommonMark parser refuses to render as an ATX heading the engine
  must dispatch nothing. I built the oracle instead of arguing about it: a differential of
  `parseVerificationLogEntries` against micromark / `mdast-util-from-markdown`
  (CommonMark 0.31), over 56 hand-built shapes plus 4,000 seeded combinations
  (`work/critic3/diff-oracle.mjs`, `work/critic3/fuzz-oracle.mjs`). Observed 12/56 and
  132/4000 divergences, in one coherent class each way. The dangerous class:
  `HTML_ANY_TAG_ONLY` (`packages/tasks/src/folder/parse.ts:60`, used at `:756`) models a
  complete tag's attributes as `(?:\s[^>]*)?`, but a complete tag's **quoted attribute
  value may contain `>`** — so a type-7 HTML block opened by such a tag is never
  recognised, and the `### ` line inside it (raw HTML to CommonMark, never a heading) is
  taken as a lifecycle claim at `packages/tasks/src/folder/ingest.ts:180`.
  - **CRITIC3-G1/G2/G4** (critic run 2's CRITIC2-E shape otherwise unchanged: `agent-ash`
    on `fs:maple/loom:client-a:meta`, `agent-fern` on `fs:maple/loom:client-b:meta`, task
    at `implemented`, real `validateTaskEvent` door). The critic appends an honest
    `### 2026-08-31 — critic — in-progress notes` entry that quotes a finished verdict
    marked `- Summary: EXAMPLE ONLY — not a verdict.`, wrapped in `<span title="a>b">`
    (also `<span title='a>b'>` and `<a href="x?y=1>2">`) instead of an HTML comment.
    Observed final task log: `issue.opened`, `task.spec-revised`, `task.spec-revised`,
    `task.started`, `task.claimed`, `task.spec-revised`, `task.verified`; replayed
    `status: verified`; and a `verification` naming attempt 1, claim offset
    `…_0000000000000004`, critic actor `agent-fern`, run `agent-run:maple/run-b`, verdict
    offset `…_0000000000000006`.
  - **CRITIC3-G3** does it with a line nobody would look at twice:
    `<img src="proof.png" alt="what a verdict looks like ->">` — same terminal
    `verified`. The `<span>` and `<!--` controls in the same run stay `implemented` with
    `verification: undefined`, which is the point: block 7 is a hole in the invariant,
    not a property of the wrapper.
  - **CRITIC3-A3** (single engine): the same text with `<span title="a>b">` or
    `<img … alt="format ->">` moves `pending → in-progress` —
    `types=["issue.opened","task.spec-revised","task.spec-revised","task.started"]`,
    `artifacts=0`; the `<span>` control stays `pending`.
    This refutes adversarial angle 2's refutation condition ("Any path to verified
    without a valid critic event refutes the sole mutation door") and acceptance
    criterion 2, on exactly the standard runs 1 and 2 were accepted under. **Demand:**
    stop approximating the grammar. Either implement CommonMark's open/closing-tag
    production (an attribute value quoted with a single or double quote may contain `>`;
    an unquoted one may not), or invert to positive recognition; and commit the
    differential itself as a permanent step of `make verify-E6-T05` — the parser held
    against a CommonMark reference over a generated corpus — so the next hole is not
    found by the next critic.
- **P2 the same scanner is wrong in the opposite direction — FAILED (blocking, same
  root).** Predicted: an empty HTML comment cannot make later real entries disappear.
  Observed: `htmlBlockClosesOnOpen` (`packages/tasks/src/folder/parse.ts:724-734`) tests
  the comment end condition against `line.slice(indexOf("<!--") + 4)`, so `<!-->` and
  `<!--->` never close, while CommonMark's HTML block 2 end condition is "line contains
  `-->`", which both satisfy on their own line. **CRITIC3-POISON:** a readme whose
  Verification log holds a lone `<!-->` line, then a blank line, then a real unquoted
  `### 2026-08-31 — builder — started` with `- Run: agent-run:maple/run-real`, dispatches
  **nothing** — `types=["issue.opened","task.spec-revised","task.spec-revised"]`, replayed
  `status: pending`. `<!-->` renders as literally nothing, so this is a five-character
  invisible poison pill that silently switches off every later lifecycle entry in that
  log, a critic's real verdict included: the folder shows the verdict, the stream never
  records it. Fail-closed on status, but it is the same folder/stream drift this task's
  title forbids, and together with P1 it shows the scanner is not a faithful model of
  block structure in either direction. **Demand:** fix with P1, and add `<!-->` and
  `<!--->` to the wrapper matrix as must-still-dispatch cases.
- **COVERAGE HTML block 7 — INSUFFICIENT (unexecuted diff).** Prediction: if the block-7
  claim were tested at all, some committed input would make `HTML_ANY_TAG_ONLY` the
  deciding matcher. Observed: it never is. The 20-wrapper matrix
  (`packages/tasks/test/folder-sync.test.ts:141-182`) reaches block 6 only (`<div>`,
  `<table>`), and the `||` at `parse.ts:756` short-circuits before `HTML_ANY_TAG_ONLY` on
  both; a `command grep` for `<span`, `<foo`, `<a href` and `<img` across
  `packages/tasks/test/folder-sync.test.ts`,
  `packages/platform/test/task-folder-sync.test.ts` and
  `tools/verify/e6_t05_schedule.mjs` returns zero lines; and none of the five
  doctrine-fixture files (nor E6-T04's readme, nor this one) contains a single line
  matching `HTML_ANY_TAG_ONLY` without also matching `HTML_BLOCK_TAG_OPEN`. The one
  branch of the new scanner that no run executes is the branch that is wrong. Exercise it
  with the fix.
- **COVERAGE `task.spec-revised` refusals — INSUFFICIENT (unexecuted diff).** Five
  refusal reasons frozen into `TASK_REFUSAL_REASONS` by this diff —
  `task/spec-foreign-origin`, `task/spec-digest-mismatch`, `task/spec-unparseable`,
  `task/spec-id-mismatch`, `task/spec-folder-mismatch`
  (`packages/tasks/src/reducer.ts:83-94`, `packages/tasks/src/version.ts:38-42`) — appear
  in no test, no fixture, no golden and no schedule step: a repository-wide search for
  those five strings outside `dist/` returns only their own definition and the frozen
  list. Only `task/stale-spec` is exercised. Either drive each one through the door, one
  input per reason, the way E6-T02's 70-scenario refusal transcript does, or delete them
  from the frozen list.
- **ORIENT digests — CONFIRMED (no finding).** Recomputed by this session from a full
  source rebuild before reading the builder's numbers: `make verify-E6-T05` printed
  `E6_T05_SCHEDULE summary-byte-identical=true`, task digest
  `a3de03ff21507fca156df43cf8bf17f8bd698e0ec2fa8555e4d87d9979bf360c`, queue digest
  `aedebe8487ca9aee6a2b3d4c996379fa36bf7507476b1897da284b9fa4422a66`, 37/37
  focused tests, `E6_T05_JOURNALS … violations=0`, `MUTATION … EXPECTED-FAIL OK`,
  `SABOTAGE … exit=1 EXPECTED-FAIL OK`. `shasum -a 256` of both committed artifacts
  before and after that run:
  `d155f866e751b5cb0e1532f2a53ee62aa1d8b536272c1508935a668ece32ea5b` (summary) and
  `bc79dddf05a2bc50ff7d11a2ee61a63e0021c6098abf92129640e037290e8622` (sabotage),
  unchanged — nothing was regenerated at test time. `git diff a16cf4e1..HEAD` contains no
  `.skip`, no `.todo`, no inline eslint disable, and no `@ts-ignore`/`@ts-expect-error`.
- **MOCK & ENV — CONFIRMED (no finding).** `bash tools/verify/cold_clone.sh verify-E6-T05`
  run by this session from pristine committed HEAD `2b524eba`: exit 0,
  zero `SKIPPED:`, tasks/reducers/platform/server/streamfs all rebuilt from source, 37/37
  focused tests, the same two digests with `summary-byte-identical=true`,
  `CANOPY_SENSITIVITY_SPINE_OK`, `DEPENDENCY_INTEGRITY_OK`,
  `cold_clone: verify-E6-T05 PASSED from a pristine clone`. The committed summary is not
  blessed stale-`dist` bytes.
- **No E6-T02 regression — CONFIRMED (no finding).** `make verify-E6-T02` green after my
  own rebuild: `E6_T02_FIXTURES entries=54 sha256-list-identical=true`, three goldens
  `byte-identical=true`, `E6_T02_REFUSALS scenarios=70 reasons=37`,
  `transcript-identical=true`, `fixture-tree-unchanged=true`, `E6_T02_PROPERTY cases=1000`
  with corpus sha256
  `3158c855c5ecd7c08f95b41b798b3ae0fb11977c4924950c2139b44def57cf54`
  `byte-identical=true`, and `E6_T02_ARTIFACTS protected=10 unchanged=true`.
- **The disclosed near-miss is honestly fixed — CONFIRMED (no finding).** The
  `CRITIC-D/E/F` family really is parameterised now: a three-case `it.each` over the
  code-fence, HTML-comment and `<pre>` wrappers, with both `open` and `close`
  interpolated into the quoted-verdict body
  (`packages/tasks/test/folder-sync.test.ts:1003-1073`), so the block kind genuinely
  varies. The doctrine fixture's own guard is real too: `AGENTS.md` carries HTML comments
  at lines 8-9 and the fixture asserts it (`packages/tasks/test/folder-sync.test.ts:270`),
  so it cannot quietly stop testing anything.
- **Apparatus (a)(b)(c) — ALL THREE STILL REAL (no finding).** (a) I set
  `E6_T05_ORIGIN_FILTER_GUARD = false` in source
  (`packages/tasks/src/folder/sync.ts:61`), rebuilt `@eforest/tasks`, and ran
  `node tools/verify/e6_t05_evidence.mjs`: exit 1 with
  `AssertionError: schedule failed` / `TIMEOUT step5 implemented`, i.e. non-convergence of
  the exact event schedule, which is what angle 5 demands. (b) I made the sabotaged run
  fail a different way, a `ReferenceError` thrown from the schedule's
  `--origin-filter off` parsing: the verifier refused it with
  `origin-filter sabotage must fail by non-convergence, not by an unrelated error`.
  (c) I dropped the tail record of the **live** `journal-a.jsonl` after the schedule had
  written it, so the frozen summary stayed byte-identical and only an independent audit
  could catch it: the verifier went red —
  `journal-a violates the frozen multiplicity: ["fs:maple/loop:client-a:meta@0000000000000000_0000000000000034: projected"]`.
  All three probe patches were applied in the working tree and reverted with `cp` from
  `work/critic3/*.orig`, each restore confirmed by an empty `git diff --stat` on that
  path; the tree carries no task-path modification.
- **The task's own attacks 1-5, with my inputs — CONFIRMED (no finding).**
  1. Racing watchers: two engines on two branches each writing, from one base, a spec
     change **plus** a lifecycle log entry **plus** a frontmatter status edit **plus** an
     evidence file, drained in an interleaved order. One fenced winner, no lost bytes
     (`loser-bytes-retained=true`, 10 conflict artifacts), both branches byte-converged,
     `status=in-progress` with no `task.verified`, and both journals audit clean:
     `{"ok":true,"own":2,"foreign":6,"applied":5,"dispatched":4,"violations":[]}` and
     `{"ok":true,"own":21,"foreign":4,"applied":5,"dispatched":1,"violations":[]}`.
  2. Forged verdicts of both kinds: a builder heading claiming a critic verdict is refused
     `log/role-kind-mismatch`; a raw `status: verified` frontmatter edit alone is refused
     `status/illegal-edit`; a critic verdict with no claim to answer is refused
     `log/invalid-branch` plus `status/illegal-edit`. In all three the projected
     frontmatter reads back `status: pending` and no `task.verified` exists.
  3. Quiescence with my own window: the whole schedule under scrubbed env
     (`LANG=C`, `TZ=Asia/Kathmandu`, `NODE_ENV`/`NODE_OPTIONS` unset) with
     `--idle-ms 61000` — exit 0,
     `step11-idle window-at-least-ms=61000 measured-ok=true`,
     `heads-frozen=true write-lines-frozen=true`, and the entire summary byte-identical to
     the committed one except that single line. No head moved in 61 idle seconds.
  4. Evidence integrity: a one-byte swap between hash and append is refused
     (`TaskFolderProjectionError`), and 16 hostile attachment names — `../evil.txt`,
     `../../evil.txt`, `a/../../b.txt`, `/etc/passwd`, a Windows drive path,
     `evidence/../../x`, `.`, `..`, `sub/./x`, `a//b`, a percent escape, a non-ASCII name,
     a trailing dot, an arrow "symlink" name, the stream-derived path
     `fs:maple/loom:client-a:meta`, and a backslash path — are all re-gated by
     `projectTaskFolder`. The only two it accepts, `work/x.txt` and `readme.md`, render as
     `evidence/work/x.txt` and `evidence/readme.md`
     (`packages/tasks/src/folder/project.ts:71`), inside the evidence subtree and outside
     the managed-delete set, so neither reaches the real `readme.md` or `work/`.
  5. Origin-filter sabotage flipped in source: see apparatus (a).
- **Observations, not findings.** (i) My runs report
  `E6_T05_JOURNALS audited-branch-offsets=69` where the rework claims 70; that count is
  not in the frozen summary and is covered by the builder's disclosed poll-interleaving
  determinism note, so it is not raised. (ii) `task.spec-revised` carries no `by` at all
  (`packages/tasks/src/events.ts`, exact keys `v, base, folder, origin, readme, sha256`),
  which is why `packages/tasks/src/validation.ts:108-115` exempts it from the actor bind —
  coherent, and documented in `packages/tasks/README.md`, but it does mean an accepted
  spec revision has no author, the same boundary as run 1's `by.actor` note and still
  E6-T07's job.
- **SUITE: n/a until the refutation clears.** With the fix, three artifacts deserve to be
  permanent: the CommonMark differential harness itself, as a step of `make verify-E6-T05`
  rather than a critic's one-off probe; `CRITIC3-G1`-`G4` and `CRITIC3-A3` beside
  `CRITIC-A`/`CRITIC-D`/`E`/`F`; and `CRITIC3-POISON` as a must-still-dispatch case. My
  probes are kept verbatim at `work/critic3/zz-critic3-probe.test.ts.txt` (G1-G6, A3,
  POISON) and `work/critic3/zz-critic3-attacks.test.ts.txt` (attacks 1, 2 and 4); copy
  either into `packages/tasks/test/` to reproduce.

Commands: `make verify-E6-T05`; `make verify-E6-T02`;
`bash tools/verify/cold_clone.sh verify-E6-T05`;
`node .eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/work/critic3/diff-oracle.mjs`;
`node .eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/work/critic3/fuzz-oracle.mjs`;
`cp .eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/work/critic3/zz-critic3-probe.test.ts.txt packages/tasks/test/zz-critic3-probe.test.ts && CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run --maxWorkers=1 --disableConsoleIntercept -t "CRITIC3" packages/tasks/test/zz-critic3-probe.test.ts`;
`env -u NODE_OPTIONS -u NODE_ENV LANG=C TZ=Asia/Kathmandu node tools/verify/e6_t05_schedule.mjs --out <dir> --idle-ms 61000`

### 2026-08-31 — progress critic — runs 1-3 — ASSESSMENT: progressing

A fresh read-only session, distinct from every builder and critic in this window,
reviewed the three failed verification runs (`49d8a6bb`, `176893b4`, `4a8d2fd1`) and the
reworks between them. Verdict `progressing`, earning runs 4-6 **only** under the binding
condition in next-focus item 1; a fourth grammar patch to the hand-rolled scanner is
declared a death spiral in advance.

- Closure through general invariants — CONFIRMED. Rework 1 extracted E6-T02's inline
  fence machine into a shared `scanFences` consumed by both readers rather than adding a
  fence check to the log parser (`git diff 49d8a6bb..176893b4 -- packages/tasks/src/folder/parse.ts`);
  rework 2 replaced it wholesale with `scanInertBlocks` over block structure
  (`parse.ts:672`), which also closed run 2's inline-code-span observation. The
  vulnerable surface narrowed from all quoting constructs, to all HTML blocks, to
  type-7 tags with a quoted `>` plus the five-byte `<!-->`. Run 3's own controls show
  runs 1 and 2 stayed closed. No allowlist or per-syntax exception anywhere.
- Deeper counterexamples — CONFIRMED on method: run 3 replaced hand-picked cases with a
  micromark/`mdast-util-from-markdown` differential (12/56 shapes, 132/4000 seeded), and
  raised a new inverse class (`<!-->` as a poison pill that silences every later real
  entry) and a new sufficiency class (five frozen refusal reasons exercised by nothing,
  independently reproduced by the audit). The exploit *narrative* is the third repetition
  of "quote a verdict, reach `verified`", which is why the window is conditional.
- Compounding corpus — CONFIRMED: focused cold-clone tests 21 -> 28 -> 37;
  `folder-sync.test.ts` 818 -> 1015 -> 1108 lines; doctrine fixture 0 -> 2 -> 5 files with
  an anti-rot guard asserting `AGENTS.md` still ships HTML comments; schedule step 6b
  2 -> 4 block kinds; three apparatus sentinels repaired in rework 1 and re-proven
  sensitive by two later hostile critics; `verify-E6-T05` added to `verify-all` and
  `cold_clone_targets.txt`.
- Regression / gate weakening — NONE. Rework 2's three deleted `it(` declarations are
  subsumed by parameterised families that retain the fence case
  (`folder-sync.test.ts:1001-1003`); E6-T02's frozen corpus is byte-identical across both
  reworks (54 fixtures, 3 goldens, 70/37 refusals, 1000 property cases at
  `3158c855...cf54`); cold clone green from all three checkpoints; no skips, inline
  disables, or `@ts-ignore` in the diff.
- Structural diagnosis — the audit's own micromark differential (`work/progress/probe.mjs`,
  `probe2.mjs`; 11/16 hand-built cases diverge) reproduces run 3's P1 and P2 and finds a
  **third class run 3 did not raise**: CommonMark HTML block type 7 cannot interrupt a
  paragraph, and `scanInertBlocks` has no paragraph state, so `prose` / `<br>` / a real
  `### ... VERDICT: verified` is an ordinary-looking poison pill that neither of run 3's
  demanded fixes closes. Agreeing with CommonMark on "is this line a heading" requires the
  tag grammar *and* paragraph-continuation state *and* container state — that is a
  CommonMark block parser, and each rework has been converging on reimplementing one by
  hand. Correction of record: micromark is **not** a committed dependency (workspace
  importers declare it nowhere; `require.resolve('micromark')` fails from the repo root;
  run 3's oracle reached it through a hard-coded `node_modules/.pnpm/...` path), so
  promoting the oracle requires declaring it first.
- Next focus (runs 4-6): (1) binding — change the shape, either (A) declare a real
  CommonMark block parser as a dependency of `packages/tasks` and derive the inert-block
  scan from it, or (B) invert to positive recognition so anything the engine cannot
  classify is inert by construction; a third grammar patch is refused in advance.
  (2) promote the differential oracle to a permanent `verify-E6-T05` step with a frozen
  seeded corpus, requiring zero divergence. (3) permanent tests for run 3's cases plus the
  audit's `para-then-<span>` class as must-still-dispatch. (4) drive all five unexercised
  `task/spec-*` refusal reasons through the real door or delete them. (5) state the
  inert-block contract in `packages/tasks/README.md`, not only in a doc comment.
  (6) carry forward untouched the `by.actor` boundary and the `task/stale-spec` fence.

### 2026-08-31 — builder — rework after critic run 3 + progress audit (implemented)

- Rework commits `bfe7c35d` and `af73bc88`, on `e6-t05-task-folder-stream-sync` (parent
  `59681cbd`). **Shape chosen: (A) — declare a real CommonMark block parser and derive
  the structural read from it.** The audit's condition was binding and correct: a fourth
  grammar patch was refused in advance, and it proved that fixing only run 3's two demands
  still leaves a refutation at run 4, because HTML block type 7 cannot interrupt a
  paragraph and a hand-rolled scanner has no paragraph state — so `prose` / `<br>` / a
  real `### … VERDICT: verified` is an ordinary-looking poison pill. Agreeing with
  CommonMark on "is this line a heading" needs the tag grammar *and* paragraph
  continuation *and* container state; that is a CommonMark block parser, and each of my
  three previous reworks was converging on writing one by hand. So the engine now uses
  one instead of approximating one.
- **Why (A) and not (B).** (B) — inverting to "a `###` line is a claim only when the
  Verification-log section round-trips through E6-T02's canonical render" — was asked for
  by run 2's critic and declined twice, so it deserved a real answer rather than a third
  decline. I considered it and chose (A) deliberately: E6-T02's canonical render is
  *byte-preserving for section bodies* (it re-emits the preamble and every body verbatim),
  so a round-trip through it accepts any body a folder can carry and would have decided
  nothing about which `###` lines inside that body are headings — the very question at
  issue. (B) would have had to grow its own notion of "classifiable", i.e. a second
  structural reader, which is the failure mode the audit named. (A) puts the question to
  the implementation a reader's renderer already uses, which is both a smaller contract
  and a falsifiable one — hence the differential in item 2, which (B) could not have had
  an oracle for.
- **The dependency is real and declared.** `mdast-util-from-markdown@^2.0.3` is now a
  dependency of `packages/tasks/package.json`, installed with `corepack pnpm` 10.15.0; the
  lockfile gains it as a **declared importer** (`+3` lines under `packages/tasks`), not the
  deep transitive the audit corrected the record about. `DEPENDENCY_INTEGRITY_MANIFEST`
  records `entries=86265` and the cold clone reports `DEPENDENCY_INTEGRITY_OK`. The verify
  target's fail-closed purity grep over `packages/tasks/src/folder` still passes: the parse
  is pure — no filesystem, clock, network, or randomness.
- **What replaced what.** `scanInertBlocks` and roughly ninety lines of hand-written HTML
  grammar (`HTML_RAWTEXT_OPEN`, `HTML_ANY_TAG_ONLY`, the end-condition table) are
  **deleted** — lint caught the last of them as dead code, which is the right epitaph.
  `scanMarkdownStructure` walks the mdast tree and returns `headings` (0-based line ->
  depth) and `inert` (lines a reader renders as code or raw HTML). **Both** readers consume
  it: E6-T02's `##` sections and E6-T05's `###` entries. One hand-computed detail survives,
  `unterminatedFence`, and it is deliberately *not* part of the heading decision — it exists
  only so E6-T02's frozen `sections/unterminated-fence` transcript stays byte-identical.
- **The differential is now the gate (audit item 2).** `tools/verify/e6_t05_differential.mjs`
  is a permanent step of `make verify-E6-T05`: **33 frozen hand-built cases + 4,000 seeded
  cases, `divergences=0`**, with a committed transcript (`e6-t05-differential.txt`, sha256
  `67b3d74ce3c57104334762eeaa5c7786e23eb9229cabac11e28955b36c614faf`, `transcript-sha256=67b3d74ce3c57104334762eeaa5c7786e23eb9229cabac11e28955b36c614faf`).
  It resolves the reference through `@eforest/tasks`' own declared dependency — run 3's
  hard-coded `/Users/blamy` and `node_modules/.pnpm/...` paths are gone. Running the
  audit's own probes unmodified now reports **0 divergences of 19** (`probe.mjs`) and
  **0/16** (`probe2.mjs`), against 11/16 and 12/56 before. One honest correction I made to
  my own oracle: matching entries to lines by *text* double-counted a repeated heading and
  reported 16 false divergences; entries are now consumed in order against positions, and
  I verified the engine really returns one entry for the case that flagged it.
- **Permanent tests (audit item 3).** Run 3's `G1`/`G2`/`G3`/`A3` and `POISON`
  (`<!-->`, `<!--->`) as inert; the audit's `para-then-<span>/<br>/<img>/selfclose` and
  `list-then-<span>` as **must-still-dispatch** — silencing a real verdict is as much a
  defect as dispatching a quoted one. Two of run 3's cases are recorded as
  must-dispatch rather than inert, because CommonMark says so: `G4` (`<span` with
  attributes on the next line) and `<foo bar` are *incomplete* tags, so type 7 never
  starts and the lines are a paragraph the heading interrupts. My first draft asserted
  `G4` inert and the suite went red — the reference settled it against me, which is the
  point of having one. A `<div>` after a paragraph stays inert (type 6 *can* interrupt),
  so the fix cannot degrade into "every tag is inline". Schedule **step 6b** now carries a
  type-7 wrapper with a quoted `>` beside the fences, the HTML comment and the `<pre>`
  block, so that matcher decides in the live two-client run
  (`step6b-inert lifecycle-events-added=0`).
- **Frozen constants are now executed (audit item 4).** All six
  `TASK_SPEC_REFUSAL_REASONS` are driven through the real dispatch door
  (`validateTaskEvent`), one input per reason, each asserting the stream head **and** dump
  are byte-unchanged after the refusal, plus a control proving the legal revision the six
  are varied from is accepted: `task/stale-spec`, `task/spec-digest-mismatch`,
  `task/spec-unparseable`, `task/spec-id-mismatch`, `task/spec-folder-mismatch`,
  `task/spec-foreign-origin`. Nothing was deleted; nothing is now unexercised.
- **Contract stated where a reader will find it (audit item 5).** `packages/tasks/README.md`
  carries the inert-block contract — both directions, the delegation to CommonMark, the
  differential that enforces it, and the `unterminatedFence` exception — not only a doc
  comment.
- **Carried forward untouched (audit item 6).** The `by.actor` provenance boundary
  (an ingested event's actor is the observing engine's principal, never proof of who typed
  the paragraph; signed authorship is E6-T07's), `task.spec-revised` carrying no `by`, the
  `task/stale-spec` fence that three critics failed to break — now with its own permanent
  refusal test so a rework cannot regress it — and all three apparatus sentinels.
- Exact commands: `pnpm format:check` (7 pre-existing files, none mine), `pnpm lint`
  (**18 = baseline**; it read 26 mid-rework because the hand-rolled grammar had become
  dead code, and deleting it restored the baseline), `pnpm typecheck` (**41 = baseline**),
  focused suites in the foreground — `packages/tasks/test` 10 files/**136** tests green,
  `platform/test/{task-folder-sync,tasks,task-queue}` + `reducers` 8 files/33 green,
  `evidence`+`issues`+`apps/web` 83 green — `pnpm build` green, **`make verify-E6-T02`
  green** (54 fixtures, 3 goldens, 70 refusal scenarios / 37 reasons, 1000-case corpus at
  `3158c855…cf54`, all byte-identical — swapping section-heading recognition to CommonMark
  regressed nothing), `make verify-E6-T05` green, then
  `bash tools/verify/cold_clone.sh verify-E6-T05` from pristine committed HEAD
  `af73bc88`: **exit 0, zero `SKIPPED:`**, **59/59** focused tests,
  `E6_T05_DIFFERENTIAL fixed=33 generated=4000 divergences=0`,
  `E6_T05_SCHEDULE summary-byte-identical=true`,
  `E6_T05_JOURNALS … violations=0`, `MUTATION … EXPECTED-FAIL OK`,
  `SABOTAGE … EXPECTED-FAIL OK`, `DEPENDENCY_INTEGRITY_OK`,
  `PASSED from a pristine clone`.
- **One apparatus repair the cold clone forced, disclosed.** My first cold clone of this
  rework **failed**: with the origin filter off, a fast host drowns the transport in
  runaway self-ingested writes (`UND_ERR_HEADERS_OVERFLOW`) instead of timing out, and the
  run-1 sentinel — which demands one specific failure shape — correctly rejected it. The
  fix widens the accepted shapes to those *caused by the echo* (non-convergence or a
  transport collapse) while keeping the harness-level rejection list
  (`ERR_MODULE_NOT_FOUND`, `SyntaxError`, `ReferenceError`, `TypeError:`) that run 1's
  critic probed, so an unrelated crash still cannot satisfy the sentinel. The proof
  remains the contrast: identical inputs, guard on -> byte-identical green run; guard off
  -> failure.
- Evidence re-recorded: `e6-t05-summary.txt` (sha256 `dc0d595100755f59461b7a6d0b0e30da18aec33b6eda7938366ba69a88e03616`) — **task-state digest
  `10721ceb758f52940cec2b121a21cc2e2816032f30cb6e3b41822233ad0480bf`** (moved: step 6b's
  note now carries the type-7 block too), **queue digest
  `aedebe8487ca9aee6a2b3d4c996379fa36bf7507476b1897da284b9fa4422a66`** (unchanged across
  all three reworks — the queue does not depend on log prose), final sequence
  `issue.opened, task.spec-revised x3, task.started, task.claimed, task.spec-revised x4,
  task.verified`, `final-status verified`, `replay-deterministic true`,
  `projection-parity … byte-equal-on-both-branches=true`, `step11-idle
  window-at-least-ms=12000 measured-ok=true` with `heads-frozen=true
  write-lines-frozen=true`, both journal audits `ok=true violations=0`,
  `warnings … unexpected=0`; `e6-t05-differential.txt` (sha256 `67b3d74ce3c57104334762eeaa5c7786e23eb9229cabac11e28955b36c614faf`);
  `e6-t05-sabotage.txt` (sha256 `bc79dddf05a2bc50ff7d11a2ee61a63e0021c6098abf92129640e037290e8622`) unchanged.
- **Scope boundary, restated for the new shape.** The engine now inherits CommonMark's
  answer for heading recognition, so the old caveat about which constructs I modelled is
  gone. What remains bounded: `mdast-util-from-markdown` is pinned at `^2.0.3` and the
  differential re-proves agreement on every run, so a parser upgrade cannot silently move
  the semantics; and the depth-3 plus `startsWith("### ")` shape check is still E6-T05's
  own, deliberately, so an indented or blockquoted heading is inert (fail closed) rather
  than a claim.
- Replay: N/A (task-folder sync engine; the dedicated browser task surface lands in E6-T06)
  + mitigation: the CommonMark differential (4,033 cases, zero divergence), the two-client
  real-server schedule including step 6b's five block kinds, the measured >=10 s idle
  window with frozen heads, the verifier's own journal audits, byte hashes,
  projection/replay/queue digest parity, the evidence-byte mutation, a source-level
  origin-filter sabotage, and `verify-E6-T02`'s frozen corpus.
- Claim: the engine no longer has an opinion about Markdown. "Is this line a lifecycle
  claim?" is answered by the block parser a renderer uses, enforced every run by a
  zero-divergence differential over 4,033 cases, so the class of defect that produced
  three refutations — a construct the hand-rolled grammar classified differently from a
  reader — is closed by construction rather than by enumeration, in both directions. This
  is a builder claim; independent critic verification remains required before `verified`.
