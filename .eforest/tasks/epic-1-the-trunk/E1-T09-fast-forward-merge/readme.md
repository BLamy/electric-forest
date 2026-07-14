---
id: E1-T09
epic: 1
title: "Official-substrate consolidation and fast-forward merge"
priority: 109
status: implemented
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
