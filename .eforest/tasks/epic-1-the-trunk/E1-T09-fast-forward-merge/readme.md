---
id: E1-T09
epic: 1
title: "Official-substrate consolidation and fast-forward merge"
priority: 109
status: in-progress
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
