---
id: E6-T01
epic: 6
title: "Task event model: an issue with evidence and builder/critic verdicts"
priority: 601
status: verified
depends_on: [E5]
estimate: M
capstone: false
---

## Goal

`packages/tasks` defines and registers the durable-stream task entity: it reuses the
E5 issue workflow and attachment reference contracts, adds the builder/critic events
`task/claimed`, `task/refuted`, and `task/verified`, and reduces every task to one
canonical `TaskState`. Illegal transitions are rejected at dispatch, only a critic
verdict can produce `verified`, and replay of the task log is the sole source of task
status.

## Context

Epic 6 starts from ROADMAP.md's identity: **a task is an issue with evidence**. This
task freezes that identity rather than creating a parallel ticket system. It builds on
E5-T01's issue reducer, E5-T09's attachments, and the E5 capstone's proven multi-entity
stream model. Later tasks parse `.eforest` folders into this entity, schedule it, and
run agents against it.

The frozen lifecycle is `pending -> in-progress -> implemented -> verified`, with the
rework branch `implemented -> refuted -> in-progress`: `task/refuted` produces the
observable `refuted` state and `task/rework-started` begins the next attempt.
`task/claimed` is the only event that produces `implemented`; `task/verified` is the
only event that produces `verified`. Every claim and verdict references an agent-run
stream, task-branch stream, head offset, and attachment ids. Offsets remain opaque
strings.

## Deliverables

- `packages/tasks/src/events.ts`, `reducer.ts`, `validation.ts`, and `version.ts` with
  versioned event schemas and a registered `tasks/v1` reducer.
- `packages/tasks/src/state.ts` defining canonical `TaskState`, attempt history,
  evidence references, claim linkage, and verdict linkage without duplicating E5 issue
  or evidence types.
- Dispatch validation for actor role, legal predecessor state, current-claim linkage,
  and append-only attempt history.
- Frozen valid and invalid JSONL fixtures plus property tests over transition sequences.
- `Makefile` target `verify-E6-T01` producing a task-log dump and canonical digest.

## Acceptance criteria

- [ ] `make verify-E6-T01` exits 0 from `tools/verify/cold_clone.sh` with zero
      `SKIPPED:` lines and replays the committed valid fixture twice to byte-identical
      `tasks/v1` state digests.
- [ ] The valid fixture follows pending -> in-progress -> claimed/implemented ->
      refuted -> rework-started/in-progress -> claimed/implemented -> verified,
      preserves both attempts, and its final `verified` state references exactly the
      second claim offset and its critic run; the exact state and digest are committed
      as frozen artifacts.
- [ ] Dispatching `task/verified` as a builder, before a claim, against a stale claim,
      or after terminal verification is refused before append; the task stream head and
      digest remain byte-identical in every refusal transcript.
- [ ] A `task/refuted` event carries at least one finding with a stable fingerprint and
      evidence citation, and replay retains the complete finding instead of only the
      status change.
- [ ] Existing issue comments, labels, workflow metadata, and E5 attachment references
      round-trip through `TaskState`; no second attachment schema or database-backed
      task record is introduced.
- [ ] The reducer is total over fuzzed well-formed events and deterministically refuses
      unknown versions/types; 1,000 generated legal sequences replay identically in
      two fresh processes.
- [ ] Browser evidence is declared `Replay: N/A (task reducer and dispatch contract;
      no browser surface in this task)`; mitigation is the frozen task log, refusal
      transcripts, independent replay, and digest/sensitivity proof above.

## Adversarial verification

1. Generate transition sequences that try every status edge, duplicate each event, and
   reorder claim/refute/verify records. One illegal append accepted, one legal append
   refused, or one different final digest refutes the lifecycle.
2. Forge a critic verdict pointing to a claim from another task or an older attempt.
   Acceptance, head movement, or state mutation refutes claim linkage.
3. Mutate one byte in each frozen event kind and replay. A mutation that neither fails
   validation nor changes the digest refutes the measuring apparatus.
4. Remove the critic-role guard in a scratch worktree and prove `verify-E6-T01` goes red
   specifically on the builder-verifies refusal. A green sabotage run refutes coverage.
5. Scan the diff and dependency graph for a task table, KV sidecar, or duplicate issue /
   evidence model. Any authoritative state outside replay of the task stream refutes the
   architectural contract.

## Verification log

### 2026-08-30 — builder — implemented, not yet verified

- Implementation commit `903390a2` (branch `e6-t01-task-event-model`). **A task is an
  issue with evidence, literally:** the task stream is the issue stream
  `issue:<org>/<repo>/<taskId>`; the loop family `task.started` / `task.claimed` /
  `task.refuted` / `task.rework-started` / `task.verified` (envelope `v: 1`; the spec's
  `task/x` prose names these dot-typed events, `task/<reason>` names refusals) rides that
  stream beside the frozen E5-T01 issue actions, and evidence lives on the task's E5-T10
  attachment list `evidence:<org>/<repo>/issue/<taskId>`. No second attachment schema, no
  task table, no KV sidecar: `TaskState` is `replay(log)` under the registered `tasks/v1`
  reducer (`packages/tasks/src/{version,events,state,reducer,validation,generate}.ts`),
  and the `issue` projection of the same log is unchanged (E5 goldens untouched; the
  issue reducer and board skip the sibling family as deterministic no-ops, the precedent
  being `streamfs` + `history` over one `fs:` meta stream). The E5-T01 workflow validator
  core moved to `@eforest/issues` (`validateIssueWorkflowEvent`) so the task validator
  reuses it instead of duplicating it; platform `validateIssueEvent` wraps it unchanged.
- Dispatch contract (`packages/platform/src/gateway.ts` `validateTaskDispatch`,
  `packages/platform/src/validation.ts` `registerTaskValidators`): actor role per event,
  `by.actor` bound to the authenticated identity, legal predecessor state, current-claim
  linkage (claim offset + branch head + task stream), builder/critic separation per claim,
  append-only attempt history, attachment existence on the task's attachment list, and a
  `task/not-opened` pre-check before the writer lane. Only `task.claimed` yields
  `implemented`; only `task.verified` yields `verified`; `task.refuted` carries 1–64
  findings with a stable slug fingerprint and an evidence citation, and replay retains
  every finding (`attempts[0].verdict.findings`, 2 entries in the golden state).
- Exact commands: `pnpm format:check` (7 pre-existing files flagged on main, none mine),
  `pnpm lint` (18 errors, byte-identical to the main baseline list modulo one shifted
  line number), `pnpm typecheck` (41 errors = 47 baseline − 6 duplicate-declaration
  errors in `packages/cli/src/replay-command.ts` that broke `tsc -b` on main and were
  removed), `pnpm test` (116 files: 113 passed; 3 failures pre-existing and untouched —
  `packages/meadow/test/links.plan.test.ts` README drift, `packages/platform/test/issues.test.ts`
  7-vs-8 workflow keys since E5-T07, `packages/pr/test/pr-property.fuzz.test.ts` 120 s
  timeout under load), `pnpm build` (green; it was red on main because of the CLI
  duplicates), `make verify-E6-T01` (green, zero `SKIPPED:` lines).
- Evidence (all in `evidence/`, hashed before/after by the verifier so nothing regenerates
  at test time): `e6-t01-task.jsonl` — the 10-event frozen valid log produced through the
  real `/api/dispatch` door with distinct bearer identities (builder-ash / critic-fern /
  builder-birch), byte-identical to the in-memory door's log; `e6-t01-task.state.json` +
  `e6-t01-task.digest` = `e1ac70aecfaa6ad41df98885a8c62d65504b1a0fe2cf8a0c243197ca7062d0be`
  (status `verified`, two attempts preserved, `verification.claim` = offset
  `0000000000000000_0000000000000008` = the second claim, `verification.critic.run` =
  `agent-run:maple/E6-T01-golden-run-4`); `e6-t01-invalid.jsonl` — 25 frozen refusal
  scenarios covering all 15 `TASK_REFUSAL_REASONS` plus 422/404 cases;
  `e6-t01-refusals.txt` — the 25 real-door transcripts, every `before` equal to `after`
  (head offset + dump SHA-256), including builder-verifies → `task/wrong-role`,
  verify-before-claim → `task/no-claim`, verify-stale-claim → `task/stale-claim`,
  verify-after-terminal → `task/terminal`, foreign-claim → `task/foreign-claim`;
  `e6-t01-property.txt` — seed `e6010000`, 1,000 generated legal sequences,
  corpus SHA-256 `ec93258099eeec1f53a99e7e59dba8cf710d8f344f42f04ba01a21fdd69d8d41`;
  `e6-t01-sabotage.txt` — with `E6_T01_CRITIC_ROLE_GUARD` removed, exactly the
  builder-verifies checks go red (real door 202-instead-of-409, pure validator silent),
  27 other checks still pass.
- `make verify-E6-T01` = `tools/verify/e6_t01_evidence.mjs` + focused suites (5 files,
  46 tests): dumps the task log, replays the fixture in two fresh `ef replay --digest
  --reducer tasks/v1 --stream-id …` processes (foreign cwd + `Pacific/Kiritimati` vs
  repo cwd + UTC) to the frozen digest, re-executes the 25 refusals against the pure
  validator and holds every transcript to identical head/dump, runs the 1,000-sequence
  corpus in two fresh processes to byte-identical output matching the frozen corpus
  digest, and prints eight `MUTATION … EXPECTED-FAIL OK` sentinels — one byte changed in
  every frozen event kind (`issue.opened/labeled/commented`, all five `task.*`) changes
  the digest. Purity grep over `packages/tasks/src` (no clock, RNG, env, fs, net) and
  `self_check`/`verify-list` close the target. Cold clone: see the next entry.
- Replay: N/A (task reducer and dispatch contract; no browser surface in this task) +
  mitigation: the frozen task log, real-door refusal transcripts, two-process independent
  replay, property corpus, digest/sensitivity proof, and sabotage transcript above are the
  evidence layer.
- What the run demonstrates: replay of the task's own issue stream under `tasks/v1` is the
  sole source of task status; the door refuses every illegal transition, role, identity,
  and stale/foreign linkage before append without moving the log; the frozen lifecycle
  reaches `verified` only through a critic verdict against the current (second) claim;
  and the measuring apparatus is sensitive to a single byte and to the removal of the
  critic-role guard. Environment note: `pnpm-lock.yaml` was regenerated by the pinned
  `pnpm@10.15.0` (the committed lockfile's `patchedDependencies` format predated it and
  `--frozen-lockfile` refused on a pristine clone of main); `corepack enable` was run to
  expose `pnpm` for `cold_clone.sh`.

### 2026-08-30 — builder — cold-clone verification

- `bash tools/verify/cold_clone.sh verify-E6-T01` passed from pristine committed HEAD
  `9a11b336` (exit 0, zero `SKIPPED:` lines, `DEPENDENCY_INTEGRITY_OK`): frozen-lockfile
  hydration from the lockfile-verified store, package builds, purity grep, 5 focused test
  files / 46 tests, `E6_T01_DIGEST e1ac70ae…d0be`, two-process replay and property
  corpus byte-identical, eight `MUTATION … EXPECTED-FAIL OK` sentinels, `self_check`,
  `verify-list`, and `verify-E6-T01: OK`. Replay: N/A (task reducer and dispatch
  contract; no browser surface in this task) + mitigation as above. Status stays
  `implemented` for a fresh critic.

### 2026-08-30 — critic — VERDICT: verified

- ORIENT digest — HELD. Predicted `ef replay evidence/e6-t01-task.jsonl --digest --reducer tasks/v1
  --stream-id issue:maple/reading-room/E6-T01-golden` = `e1ac70ae…d0be`; observed exactly that
  from the rebuilt CLI before reading any evidence. Sweeps: no `.skip/.todo/.only`, no inline
  lint disables, no blessed golden in `git diff 7a485671..HEAD`.
- AC1 cold clone — HELD. Predicted exit 0 with zero `SKIPPED:`; observed `cold_clone: verify-E6-T01
  PASSED` from pristine HEAD `4a6f9596` (46 tests, `DEPENDENCY_INTEGRITY_OK`, two-process replay
  byte-identical, eight `MUTATION … EXPECTED-FAIL OK`), 0 `SKIPPED:` lines (work/cold_clone.log).
- AC2 lifecycle linkage — HELD. Predicted `verification.claim` = offset `…0008`, critic run
  `agent-run:maple/E6-T01-golden-run-4`, two attempts, attempt 1 keeping both findings; observed
  in `evidence/e6-t01-task.state.json` (replayed canonically equal, cold_clone.log step 1).
- AC3/attack 2 forged verdicts at the REAL `/api/dispatch` door — HELD (work/attack2_door.mjs,
  org `oak/grove`, my own actors b1/b2/c1/c2): verdict citing another task's claim →
  `task/foreign-claim`; attempt-1 claim after rework → `task/stale-claim`; future offset →
  `task/stale-claim`; right offset + attempt-1 branch, and right branch + head off by one →
  `task/stale-claim`; bearer c2 with `by.actor` c1 → `task/actor-mismatch`; attempt-2 builder as
  critic → `task/self-verdict`; other task's evidence list → `task/foreign-evidence`; unlinked id
  → `task/unknown-attachment`; nonexistent evidence stream → `task/unknown-attachment`; task
  event on `pr:` stream → 404; unopened task → `task/not-opened`; duplicate fingerprints → 422;
  client-supplied `payload.actor/writer` → 400 `client_actor_forbidden` (earlier than predicted);
  six concurrent `task.claimed` → exactly 1 accepted; rework after `verified` → refused. Head
  offset and dump SHA-256 identical before/after in all 17 checks; a legitimate verdict still
  landed afterwards (door not wedged).
- Attack 1 reorder/duplicate fuzz — HELD (work/attack1_fuzz.mjs, seeds `0xc41710`+300, 7,624
  mutant sequences, 75,272 accepted / 14,486 refused events): 0 legal generated sequences
  refused, 0 illegal edges accepted, 0 accepted-but-no-op events, 0 door-vs-replay digest
  splits, attempt history never rewritten.
- Attack 3 one-byte mutations (my fields) — HELD for every payload field, `by.role`, `v`,
  `claim.*`, `refutation.offset`, `branch.*`, `evidence.*`, finding citation, and the envelope
  `offset` of claim/refutation records (work/attack3_mutate.mjs: all change the digest or are
  refused). NOTE, not refuting: the envelope `ts` of `task.*` records (offsets 3, 4, 9) is
  neither validated nor reduced into `TaskState`, so a `ts` byte flip leaves `e1ac70ae…` intact —
  identical to the frozen E5-T01 `issue.labeled` `ts` (offset 1) behaviour; the model's clock is
  the stream offset (`startedAt`, `claim.offset`, `verdict.offset`) and the purity grep forbids
  wall clocks. Demand: state this blind spot in `packages/tasks/README.md` in the next E6 task
  that touches the package; the dump SHA-256 in refusal transcripts already covers `ts`.
- Attack 4 sabotage — HELD (work/sabotage.sh, three detached worktrees, offline frozen install):
  removing `E6_T01_CRITIC_ROLE_GUARD` reddens exactly `builder-verifies` (2 tests + evidence
  script `AssertionError: builder-verifies`); my own sabotages — neutralising the claim-offset
  half of the stale-claim check (lifecycle no-op test red, target red) and removing the
  self-verdict guard (2 tests + evidence script red) — both turn `verify-E6-T01` red. Coverage
  note: the frozen `verify-stale-claim` scenario also changes the branch, so it did not catch the
  offset-only sabotage; promoted a claim-offset-only forgery (below).
- Attack 5 side stores — HELD. Diff scan of `packages/` and `tools/` for sqlite/postgres/kv/
  fs writes/`new Map` stores: none outside tests and the verifier; `packages/tasks` has no
  state beyond `replay(events)`; board materializer is a derived cache and a cold gateway
  rebuild equals the hot board byte-for-byte after loop events (work/attack6_board.mjs).
- Extra attack (board projection) — HELD: issue state, labels, and comments survive interleaved
  `task.*` events; `issues/board` hot == cold; task events never enter issue-board columns.
- COVERAGE: `packages/tasks/src/*`, `platform/src/validation.ts`, `gateway.ts` task lane
  (`validateTaskDispatch`, not-opened pre-check, non-issue 404, 404/422/409 mapping,
  `resolveStream` not-found branch), `issues/{validate,issueReducer,board}.ts`,
  `issues/board-store.ts` sibling path, `envelope.ts`, reducers registry — executed by the
  focused suites plus my attacks. WAIVED: `gateway.ts` `assertIssueDeclared` catch →
  `repo-issues/migration-required` (defensive, needs a corrupted board catalog); `cli/
  replay-command.ts` deletion of duplicate declarations (dead code; fixed `tsc -b`); Makefile,
  tsconfig/package/lockfile/vitest config (config); `.claude/scheduled_tasks.lock` churn in
  `9a0db6cf` (session lock, unrelated — keep it out of future task commits).
- Gates (my run): `pnpm test` 116 files / 3 failed = baseline (`pr-property.fuzz` timeout,
  `issues.test` workflow-matrix key count, `meadow links.plan` README drift); `pnpm lint` 18
  errors = baseline; `pnpm typecheck` 41 errors (baseline 47 − 6 CLI duplicates); `pnpm
  format:check` 5 pre-existing files; `pnpm build` green; `make verify-E6-T01` OK with the
  promotion (6 files / 49 tests).
- SUITE: promoted `packages/tasks/test/critic-attacks.test.ts` (fresh-seed duplicate/swap/
  relocate fuzz with edge, no-op, and digest-parity invariants; claim-offset-only forgery →
  `task/stale-claim` and replay no-op; foreign evidence list and rework-builder self-verdict);
  it runs inside `verify-E6-T01` via the `packages/tasks/test` glob. Scratch attack scripts stay
  in `work/`.

Commands: `node packages/cli/dist/src/bin.js replay evidence/e6-t01-task.jsonl --digest --reducer
tasks/v1 --stream-id issue:maple/reading-room/E6-T01-golden`; `bash tools/verify/cold_clone.sh
verify-E6-T01`; `node work/attack1_fuzz.mjs`; `node work/attack2_door.mjs`; `node
work/attack3_mutate.mjs`; `bash work/sabotage.sh`; `node work/attack6_board.mjs`; `pnpm test`;
`pnpm lint`; `pnpm typecheck`; `pnpm format:check`; `make verify-E6-T01`.
