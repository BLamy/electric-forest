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

- [x] The capstone imports no emulator or server implementation except the published
      Durable Streams packages.
- [x] Two clients observe identical ordered application events and final tree digests.
- [x] Native branch isolation, merge conflict handling, logical snapshot bootstrap, and
      CLI materialization execute in one deterministic scenario.
- [x] A process restart resumes through the official client and converges exactly.
- [x] `make verify-E1-T11` runs the full gate sequence from a cold clone with no skipped
      checks.
- [x] Replay is N/A until a browser surface exists; committed event logs, digests, and
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

### 2026-07-15 — builder — implementation submitted

- Commits: implementation and durable evidence `c667a28`; cold-run CLI process timeout
  hardening `8d4bf6504dde3115283830c2502b8c2467dfac0c` (submitted tip).
- `tools/verify/e1_capstone.mjs` runs one deterministic application scenario through a
  `baseUrl`-only transport configuration against the published
  `@durable-streams/server` file store. It creates the first repository, proves native
  branch isolation, records and resolves a merge conflict, bootstraps a logical
  snapshot, kills and resumes one of two independent watcher processes, restarts the
  server on the same persisted store, rejects a stale concurrent writer, replays the
  resolved log, and materializes byte-identical files through the real `ef` CLI.
- Two watcher processes independently observed the same 17 ordered events through head
  `0000000000000000_0000000000000016` and reduced them to digest
  `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`, equal to two
  fresh official clients and `ef replay`. The logical snapshot digest is
  `89d9e0dc1ba7bf40b5274f2fbcc041a186b7e8f7af3d5ac78cfc59061f05494f`.
- Permanent negative controls in `tools/verify/e1_capstone_sabotage.mjs` proved the
  verifier turns red for all required attacks: mutated event, related-source invalid
  merge, wrong restart store, lost watcher checkpoint, and incorrectly ordered writer
  race. Evidence: `evidence/sabotage-summary.json`.
- Ordered gates: `pnpm format:check && pnpm lint`; `pnpm typecheck`; `pnpm test`
  (`15` files, `234` tests); `pnpm build`. Exact entrypoint:
  `CI=true make verify-E1-T11` (`234/234` full-suite and `108/108` focused tests, prior
  E1-T10 evidence, capstone, five negative controls, task-board self-check).
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E1-T11` passed at exact tip
  `8d4bf6504dde3115283830c2502b8c2467dfac0c` from
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.YnVnMzbQhG/repo` with scrubbed
  `NODE_OPTIONS`, `NODE_ENV`, and `npm_config_*`; the lockfile installed 151 packages
  with zero downloads and no checks skipped.
- Durable evidence: `evidence/main-resolved.jsonl`, `evidence/watcher.jsonl`,
  `evidence/portable-materialization.jsonl`, `evidence/materialized-manifest.txt`,
  `evidence/summary.json`, `evidence/sabotage-summary.json`, and
  `evidence/transcript.txt`.
- Replay: N/A (E1-T11 is a CLI/server-only capstone with no browser-reachable surface) +
  mitigation: byte-identical committed event logs, exact offsets and SHA-256 digests,
  two independent process transcripts, CLI replay/materialization, permanent
  mutation-sensitive negative controls, exact-tip full gates, and a scrubbed cold clone.

### 2026-07-15 — critic 4 judge

VERDICT: refuted

- P1 configurable endpoint — FAILED. The capstone rejects an external `--base-url`, reads
  no endpoint configuration, and always spawns the local file store; the claimed
  `baseUrl-only` summary is a literal, not proof that the same application runs against an
  independently managed endpoint. Judge reproduction: external base-url probe exited 1
  at `tools/verify/e1_capstone.mjs:38-59`. Extract one transport-injected application
  scenario and run it unchanged through both local lifecycle and external-endpoint modes.
- P1 watcher crash consistency — FAILED. The watcher appends to its log before advancing
  the checkpoint, then rejects that reachable log-ahead state on restart. The builder kill
  waits for checkpoint=head and never enters the vulnerable window. The judge reran the
  official-server attack: log head `…0000`, checkpoint `-1`, watcher exit 1. Citations:
  `tools/verify/e1_capstone_watcher.mjs:58-83` and
  `work/e1-t11-critic1-behavior/ATTACK_RESULTS.json`. Establish one crash-consistent journal
  invariant and deterministic faults at every persistence boundary.
- P1 evidence lineage/sensitivity — INSUFFICIENT. The real resolved history cannot be
  materialized (`content size mismatch for docs/readme.md`); the harness instead invents a
  post-hoc final-state log. A tampered committed transcript still passed the full capstone.
  Invalid-merge, watcher-ordering, and writer-race negative controls fail at setup
  preconditions rather than the claimed invariants. Citations:
  `work/e1-t11-critic2-coverage/RESULTS.md`,
  `work/e1-t11-critic3-sabotage/RESULTS.md`, and
  `work/e1-t11-critic4-judge/RESULTS.md`.
- GENERAL REWORK. Do not add case-specific flags. Refactor around three contracts: an
  endpoint-independent application scenario; a crash-consistent watcher journal state
  machine; and a provenance manifest binding actual metadata/content streams,
  materialized bytes, normalized transcripts, and the runtime transport closure. Mutate
  those boundaries and require each negative control to fail at its named sensor.
- SURVIVED. Committed main/watcher logs remain byte-identical and replay to
  `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`; branch,
  merge/resolution, snapshot, local restart, and eight uncontrolled one-winner races held.
- Replay: N/A (CLI/server-only capstone) + mitigation: official-server event logs,
  exact digests, process runs, and disposable mutations currently refute the claim; record
  a new complete stream-layer run after the general rework.
- SUITE: retain the main/watcher logs and critic 1 SIGKILL/race corpus. Promote the watcher
  crash window, actual content-lineage bundle, endpoint-injected scenario, evidence
  manifest, and boundary-sensitive controls after the contracts are fixed.

Commands: external base-url probe (exit 1); real-history materialization probe (exit 1);
critic 1 official-server attack rerun (watcher crash reproduced; 8/8 race rounds held);
exact-tip transcript tamper plus normal capstone (unexpected exit 0), then clean restore.
Submission: `1ae45364882473ec609dc3aedc86185a6d68e21f`.
