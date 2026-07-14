---
id: E1-T09
epic: 1
title: "Official-substrate consolidation and fast-forward merge"
priority: 109
status: verified
depends_on: [E1-T04, E1-T06, E1-T08]
estimate: L
capstone: false
---

## Goal

Make Electric's published Durable Streams client and server the only transport substrate
in electric-forest, then prove StreamFS fast-forward merge on that substrate. Remove the
repo-owned HTTP server, stores, transport client, protocol conformance package, reducer
HTTP routes, and verification harnesses whose subject was that duplicate implementation.

StreamFS remains product code. Its canonical JSON items carry deterministic application
offsets while Electric owns transport cursors, persistence, live reads, writer
coordination, and native forks. A fast-forward merge appends exactly one
`fs.branch.merge` application event when the target is still at the source's fork point;
the source remains unchanged and later source writes remain invisible to the target.

## Deliverables

- `@eforest/client` is a typed adapter around `@durable-streams/client` only.
- `@eforest/server` launches and re-exports `@durable-streams/server` only.
- `@eforest/streamfs` has no transport selector and no calls to repo-owned HTTP routes.
- Local and CI integration tests start `DurableStreamTestServer` and prove CRUD,
  deterministic reduction, SSE watch delivery, logical snapshots, native head forks,
  branch isolation, fast-forward merge, typed refusals, and concurrent-writer fencing.
- `ef snapshot` and `ef merge --ff-only` use StreamFS APIs over the same substrate.
- Architecture, roadmap, Makefile, and E2-T02 enforce the same ownership boundary.
- Active task contracts are audited for retired custom-server packages, endpoints, and
  hook names; the generated queue shows the current critic gate and immediate unlock.
- No Durable Streams fork or submodule is added. `vendor/emulate` remains the pinned
  Auth0 emulator source; a future Durable Streams entry there may only wrap the
  published server.

## Acceptance criteria

- [ ] No source or verification path defines a second Durable Streams HTTP server,
      store, read protocol, dispatch route, or transport client.
- [ ] `rg` finds no transport selector or alternative server path in product packages.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`
      all pass from the same final tree.
- [ ] `make _v-official-streamfs` passes against the published reference server.
- [ ] A concurrent same-base write race has one committed metadata mutation and one
      typed stale-base refusal; orphaned content appends are invisible because metadata
      is the commit record.
- [ ] A fast-forward merge makes target and source digests equal at the adopted range,
      leaves the source dump byte-identical, and freezes the adopted range against later
      source writes.
- [ ] An advanced target refuses merge with `fs/merge-not-fast-forward` without changing
      either stream.
- [ ] Browser evidence is `Replay: N/A` because this task changes protocol, CLI, and
      server internals only; official-server integration output is the mitigation.
- [ ] `pnpm task-board:check` passes and regeneration shows E1-T09 as the current
      independent-critic gate with E1-T10 as its immediate unlock.

## Adversarial verification

- Search the full tree for removed server symbols and direct calls to removed routes.
- Run the official integration suite with a real loopback server, not a mocked fetch.
- Race independent StreamFS instances from the same base and verify exactly one winner.
- Fork, write, merge, write the source again, and prove the target retained the merged
  value rather than following the source.
- Advance the target before merge and verify both dumps remain unchanged after refusal.
- Check the package graph and lockfile so production packages depend only on the official
  boundary they use.

## Verification log

### 2026-07-13 — builder — implemented

- Implementation commit: `9aee35c` (`refactor: standardize on official Durable Streams`).
- Gates, rerun from the top after the final orchestration fix: `pnpm format:check`,
  `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `make _v-official-streamfs`, `bash tools/verify/self_check.sh`, and
  `make verify-list` — all exited 0.
- Full suite: 10 files, 88 tests. Official-substrate suite: 4 files, 12 tests against
  Electric's published `DurableStreamTestServer`, including CLI snapshot/merge,
  StreamFS CRUD/watch/snapshot/native-fork/merge, advanced-target refusal, and a
  concurrent same-base writer race with one winner and one stale-base refusal.
- Durable evidence:
  `evidence/e1-t09-official-substrate.txt` records the package versions, exact final
  commands, counts, and behaviors. Static removal audit found no repo-owned server
  symbols, transport selector, conformance package reference, or direct call to a
  removed route in product packages or verification tooling.
- Claim: the recorded command sequence demonstrates that electric-forest now has one
  Durable Streams substrate — the published Electric packages locally and Electric
  Cloud in deployment — while retaining StreamFS as deterministic application logic
  above it. Fast-forward merge and concurrent-writer refusal both execute on that
  substrate.
- Replay: N/A (protocol, CLI, and server-internal consolidation with no browser
  surface) + mitigation: real loopback integration against the published reference
  server, deterministic reducer/digest assertions, and the committed evidence summary.

### 2026-07-13 — builder — task-board architecture follow-up

- Follow-up commit: `c10da85` (`docs: realign task queue with official streams`).
- Reorganized active Epic 2 around the authenticated platform gateway,
  `vendor/emulate` Auth0, official-client access, application writer lanes, and
  provider-owned global `Stream-Seq`. Reorganized Epic 3 around
  `useStreamReducer` and authorized application-event bootstrap/follow instead of
  server-materialized reducer endpoints.
- Updated every active future ticket that still named a retired custom route, package,
  hook, local persistence implementation, or stub transport. Added
  `pnpm task-board:check` as a standing gate and demonstrated sensitivity by feeding
  it a pending ticket containing `packages/stream-server`; the audit exited nonzero
  and cited the exact line.
- Regenerated `.eforest/tasks/QUEUE.md`: 101 tasks, 21 verified; E1-T09 is the current
  independent-critic gate, no new task is eligible, and E1-T10 is the direct unlock.
  Updated `.eforest/project.json` to report the same state.
- Final checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test` (10 files, 88 tests), `pnpm build`, `pnpm task-board:check`,
  `make verify-list`, and `git diff --check` all passed. The integration tests were
  run with loopback permission because the sandbox correctly refused local bind with
  `EPERM`.
- Replay: N/A (task planning, queue generation, and a static architecture gate) +
  mitigation: deterministic queue output, full repository gates, official-server
  integration tests, and the negative task-audit sensitivity run.

### 2026-07-14 — critic — VERDICT: refuted

- P1 concurrent-writer orphan neutrality — FAILED. Predicted that when writer A's full
  content append lands first but writer B wins the metadata race, B remains readable and
  A receives a stale-base refusal. Two independent `DurableStreamTestServer` attacks
  forced that order; the metadata winner was recorded, but `readFile("race.txt")` threw
  `ContentIntegrityError: recorded size or SHA-256 does not match bytes` at
  `packages/streamfs/src/fs.ts:713`. The losing content record shifted the ordinal
  reconstruction at `packages/streamfs/src/fs.ts:663-675`, contradicting the
  invisibility claim at `packages/streamfs/src/fs.ts:709-711`. Make metadata identify
  the committed content record unambiguously, then re-record this ordering.
- COVERAGE concurrent-writer ordering — INSUFFICIENT. The permanent race at
  `packages/streamfs/test/durable-streams.integration.test.ts:94-116` launches two
  writes but never forces loser-content-first/winner-metadata-second, so it passed while
  the acceptance criterion failed. Promote the deterministic gated-fetch interleaving
  as a regression test that asserts the winner's exact bytes and the typed stale-base
  loser.
- COVERAGE advanced-target neutrality — INSUFFICIENT. The permanent refusal check at
  `packages/streamfs/test/durable-streams.integration.test.ts:82-91` asserts only the
  rejection. A compiling mutant that appended `fs.branch.merge` before throwing still
  left the focused tests green; independent before/after raw-dump assertions caught the
  target advancing to offset `0000000000000000_0000000000000012`. Commit exact target
  and source dump-plus-digest neutrality assertions so a mutate-then-reject regression
  cannot pass.
- EVIDENCE legacy merge artifacts — UNCHECKED. Seventeen files under this task's
  `evidence/` have zero references from the task log, Makefile, packages, or current
  verification tools after their generator scripts were deleted. Delete those artifacts
  as dead, or restore runnable checks that reproduce and validate them; committed files
  without a consumer do not prove the current implementation.
- COVERAGE process entrypoints — NEEDS-EVIDENCE. This task changed the real server
  process path at `packages/server/src/bin.ts:19-44` and CLI parsing/process paths at
  `packages/cli/src/bin.ts:1-15` and `packages/cli/src/cli.ts:45-64`, while
  `packages/cli/src/official.integration.test.ts:1-58` imports helper functions directly.
  Add process-level runs for the changed binaries/parsing, or explicitly waive each hunk
  with a reason it cannot affect the acceptance claim.
- Survived: the pristine `verify-E1-T09` target (88 tests; 12 official-server tests),
  official-only package/static audits, fast-forward source invariance and frozen-range
  behavior, byte-identical advanced-target refusal, and the task-board negative
  sensitivity probe.
- SUITE: n/a until the refutation is fixed; the deterministic loser-content-first race
  must become a permanent test during rework.
- Replay: N/A (protocol, CLI, and server-internal task) + mitigation: two independent
  real-loopback race reproductions plus pristine-clone and deterministic stream checks.

Commands: `CI=true make verify-E1-T09`; `CI=true tools/verify/cold_clone.sh
verify-E1-T09`; `CI=true pnpm exec vitest run
packages/streamfs/test/critic-orphan-race.test.ts --reporter=verbose`; `CI=true pnpm exec
vitest run packages/streamfs/test/critic-merge-invariants.test.ts --reporter=verbose`;
`EFOREST_TASKS_ROOT=<critic-fixture> pnpm task-board:check`.

### 2026-07-14 — builder — rework implemented

- Implementation commit: `b56ff4f` (`fix: reconstruct committed StreamFS content`).
- Full writes retain the v2 event payload and now reconstruct content by scanning
  forward for the bytes whose SHA-256 and size match the metadata commit record.
  Read and snapshot paths both skip losing orphan appends while carrying committed
  expectations through patches, renames, deletes, and branch copy-on-write handoffs.
- The permanent gated-fetch race forces content order `base, A, B` with only B in
  metadata, a typed stale-base refusal for A, exact B bytes from a fresh reader, and
  exact B bytes from snapshot fallback materialization. The official client adapter
  normalizes the published client's sequence-conflict `FetchError` into the retry path
  so the application-level stale-base type remains observable.
- Advanced-target refusal now asserts exact target/source dump and digest neutrality.
  A controlled append-then-reject mutant added `fs.branch.merge` at offset `...0022`
  and made the target-dump assertion fail; the restored implementation passed the same
  targeted test.
- Process coverage builds and spawns the real server and `ef` binaries with ephemeral
  file-backed state and port, then proves snapshot output, exact merge-parser refusal,
  successful fast-forward output, source invariance, and frozen-range behavior.
- Gates: `pnpm format:check && pnpm lint`, `pnpm typecheck`, `pnpm test` (10 files,
  88 tests), `pnpm build`, and `CI=true make verify-E1-T09` (official suite: 4 files,
  12 tests; self-check and verify-list included) all exited 0.
- Evidence: `evidence/e1-t09-official-substrate.txt`. Seventeen legacy artifacts whose
  generators and consumers were removed are deleted; the cited evidence file now names
  every final command and permanent assertion.
- Claim: on Electric's published Durable Streams substrate, metadata is again the sole
  commit record for file bytes; losing full-content appends are invisible to readers and
  snapshots, fast-forward merge/refusal is process-tested, and every refuted coverage
  gap has a deterministic permanent check.
- Replay: N/A (protocol, CLI, and server-internal rework with no browser surface) +
  mitigation: real loopback server/CLI processes, deterministic orphan-order and
  snapshot checks, exact dump/digest neutrality, sensitivity proof, and full gates.

### 2026-07-14 — fresh critic — VERDICT: verified

- P1 official-substrate ownership — PASSED. Predicted no second server, store, client,
  dispatch/read route, transport selector, fork, or submodule beyond the pinned Auth0
  emulator; full-tree searches, package manifests, `pnpm-lock.yaml`, and `.gitmodules`
  showed only `@durable-streams/client@0.2.6`, `@durable-streams/server@0.3.7`, their
  thin `@eforest` adapters, and `vendor/emulate`. `pnpm task-board:check` also exited 0.
- P2 loser-content-first race — PASSED. Predicted content order `base, A, B`, two
  committed metadata writes, a typed `stale-base` loser, and exact B bytes from a fresh
  reader and no-reader snapshot fallback. The deterministic gate at
  `packages/streamfs/test/durable-streams.integration.test.ts:142-207` observed exactly
  those values on the published server. A separate behavior arm repeated the race with
  fresh values, distinguished the published client's sequence-conflict `FetchError`
  from non-conflicts, and found no contradiction. The reworked digest/size selector is
  anchored at `packages/streamfs/src/fs.ts:650-796` and
  `packages/streamfs/src/snapshot.ts:217-230`.
- P3 merge and process invariants — PASSED. Predicted an advanced target would reject
  without changing either dump or digest, while a valid fast-forward would equalize the
  adopted digests, preserve the source dump byte-for-byte, and freeze target bytes after
  a later source write. The official integration assertions at
  `packages/streamfs/test/durable-streams.integration.test.ts:120-139` and the real
  server/`ef` process assertions at `packages/cli/src/official.integration.test.ts:121-178`
  observed those outcomes, including exact missing-`--ff-only` status/usage and a clean
  server exit. The fresh behavior arm independently repeated refusal, success, source
  freezing, argv parsing, and process startup; its orphan-matcher and refusal-predicate
  mutants both made the permanent tests red.
- COVERAGE snapshot reconstruction — PASSED after promotion. Predicted the new
  no-reader fallback would correctly execute inherited-patch sizing, branch COW handoff,
  rename tracking, owned-patch application, and delete/recreate reset. The independently
  derived regression at
  `packages/streamfs/test/durable-streams.integration.test.ts:210-255` exercised all of
  `packages/streamfs/src/snapshot.ts:249-360` and asserted exact bootstrapped bytes plus
  digest. Removing expected-content rename tracking produced
  `SnapshotIntegrityError: expected <digest>, got missing` at `snapshot.ts:303`; the
  restored code passed. Promoted suite commit: `4325b97`.
- COVERAGE diff audit — PASSED. `durable.ts:161-167`, `fs.ts:650-796`, and
  `snapshot.ts:217-372` execute in the forced race, CRUD/patch/rename/delete/COW, and
  promoted no-reader scenarios. CLI/server entrypoint hunks execute in spawned processes.
  Test-only harness hunks are measuring apparatus; task/evidence/project/queue hunks are
  metadata or generated-output waivers; deletion-only legacy evidence is dead-artifact
  removal. No product hunk remains unexecuted or unclassified, and the diff contains no
  skip/only/todo, lint/type suppression, or self-computed golden.
- EVIDENCE identity and cold clone — PASSED. Rework `b56ff4f` plus submission
  `bf7dc2d` are the exact audited implementation/evidence commits; all 17 uncited legacy
  artifacts are absent and the sole surviving evidence file is named in this log.
  `CI=true tools/verify/cold_clone.sh verify-E1-T09` cloned committed `4325b97` with a
  scrubbed environment, installed 151 frozen-lockfile packages with zero downloads, and
  passed 10 files/89 tests, 4 official files/13 tests, build, self-check, verify-list,
  and `verify-E1-T09: OK`.
- SUITE: promoted the deterministic no-reader snapshot fallback regression in `4325b97`;
  discarded the separate equal-size orphan/refusal scratch case as duplicative after the
  existing forced race, fresh behavior arm, and exact neutrality assertions survived.
- Replay: N/A (protocol, CLI, server-internal, and verification-test changes with no
  browser surface) + mitigation: real loopback published-server and real process runs,
  deterministic stream bytes/digests/dumps, two mutation sensitivity checks, the
  promoted fallback regression, full gates, and a pristine scrubbed cold clone.

Commands: `pnpm format:check && pnpm lint`; `pnpm typecheck`; `pnpm test` (10 files,
89 tests); `pnpm build`; `CI=true make verify-E1-T09` (4 official files, 13 tests);
`pnpm task-board:check`; `CI=true tools/verify/cold_clone.sh verify-E1-T09`.
