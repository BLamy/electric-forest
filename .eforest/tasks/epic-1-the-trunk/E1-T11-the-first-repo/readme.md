---
id: E1-T11
epic: 1
title: "Capstone: the first repository on Electric Durable Streams"
priority: 111
status: in-progress
depends_on: [E1-T07, E1-T10]
estimate: L
capstone: true
---

## Goal

From a cold clone, start Electric's published reference server, create a repository,
write and patch a tree, watch it from two independent clients, create a native branch,
edit both sides, merge, snapshot, replay, and materialize identical final state. The same
application must run against Electric Cloud by changing configuration only.

## Acceptance criteria

- [ ] The capstone imports no emulator or server implementation except the published
      Durable Streams packages.
- [ ] Two clients observe identical ordered application events and final tree digests.
- [ ] Native branch isolation, merge conflict handling, logical snapshot bootstrap, and
      CLI materialization execute in one deterministic scenario.
- [ ] A process restart resumes through the official client and converges exactly.
- [ ] `make verify-E1-T11` runs the full gate sequence from a cold clone with no skipped
      checks.
- [ ] Replay is N/A until a browser surface exists; committed event logs, digests, and
      process transcripts are the mitigation.

## Adversarial verification

Kill one watcher mid-run, race writers, mutate one committed event, attempt an invalid
merge, restart the server with the documented storage option, and prove the verification
apparatus turns red for each sabotage.

## Verification log

### 2026-07-14 — builder start

- Selected as the highest-priority eligible task after independent verification of
  E1-T10 at `7a9c03bc74dac3fd8d3e187a361195cc1fcebdfc`.
- Builder branch: `codex/e1-t11-the-first-repo`, stacked directly on the verified
  E1-T10 tip and eventual PR #25.
- Planned proof: one deterministic published-server scenario covering two watchers,
  branch isolation, divergent edits and conflict merge, snapshot/bootstrap, process
  restart, replay, and CLI materialization; permanent sabotage sensors for watcher death,
  writer race, event mutation, invalid merge, and restart storage.
- Replay: N/A (CLI/server capstone has no browser-reachable surface) + mitigation:
  committed event logs, exact offsets/digests/materialized bytes, process transcripts,
  mutation-sensitive verifier, exact-tip gates, and scrubbed cold clone.
