---
id: E6-T01
epic: 6
title: "Task event model: an issue with evidence and builder/critic verdicts"
priority: 601
status: implemented
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
