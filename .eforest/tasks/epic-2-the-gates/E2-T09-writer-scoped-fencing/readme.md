---
id: E2-T09
epic: 2
title: "Writer-scoped application fencing above global Stream-Seq ordering"
priority: 209
status: verified
depends_on: [E2-T07]
estimate: M
capstone: false
---

## Goal

Authenticated writers get independent application sequence lanes without changing
Electric's `Stream-Seq` semantics. Each dispatched event carries a server-stamped
writer subject and monotonically increasing writer sequence. The platform replays the
stream to validate that lane, then appends through the official client using the one
global lexicographic `Stream-Seq` required by Durable Streams.

Two users can therefore interleave valid writes without fencing each other out. A stale
sequence from the same user is refused before append. Concurrent races are resolved by
the official global append fence; a loser replays and retries only if its application
precondition still holds.

## Deliverables

- Versioned writer-lane fields in the application event envelope.
- A pure writer-lane reducer and typed stale-writer refusal.
- Dispatch coordination that combines application-lane validation with official
  `Stream-Seq` compare-and-append.
- Deterministic two-writer and same-writer race fixtures.
- Golden event logs proving per-writer monotonicity and global total order.

## Acceptance criteria

- [x] Independent writers can interleave sequences `1, 1, 2, 2` while the transport
      receives one globally increasing `Stream-Seq`.
- [x] Repeating or decreasing one writer's application sequence is refused and appends
      nothing.
- [x] In a same-base concurrent race exactly one global append wins; retry cannot bypass
      StreamFS or reducer preconditions.
- [x] Actor and writer sequence are stamped/validated by the platform, never trusted from
      an arbitrary payload.
- [x] No code changes the published server, invents identity-scoped transport headers,
      or maintains a second stream store.
- [x] `make verify-E2-T09` passes with seeded race schedules.

## Adversarial verification

1. Interleave three subjects with duplicate and out-of-order lane sequences.
2. Race two requests from one subject and two from different subjects at the same global
   head; classify every outcome by application and transport fence.
3. Forge another subject in the event body; any accepted actor mismatch refutes the task.
4. Search for per-identity state in the Durable Streams launcher/server boundary.

## Verification log

(appended by builder and critic)

### 2026-07-23 — builder — reconciled implementation claim

- Reconciled E2-T09 onto verified E2-T08 head
  `b5330b5aa6563db8fdc6f012bcde66040e49b669` without restoring the stale runtime-close
  path. E2-T08's verified projector and `NamespaceRuntime.terminate()` semantics remain
  intact.
- The platform stamps authenticated actors and writer sequences, replays the complete
  writer-lane history before operation recovery, and appends only through the official
  global `Stream-Seq` fence. The committed interleave is `1,1,2,2`, with two writes each
  for `auth0|alice` and `auth0|bob`.
- Exact verified implementation/evidence head:
  `068eb466a30b4dc32af16be318275046d3679ee3`. Commands:
  `make verify-E2-T09`; `tools/verify/cold_clone.sh verify-E2-T09`.
- Results: 58 focused E2-T09 tests; six attributable expected-red writer-lane mutations;
  399 root tests; the full inherited E2-T08/E2-T07/E2-T06, identity, gateway, storage,
  provenance, meta, and official-stream closure. The official integration target is
  serialized with `--maxWorkers=1`, preserving its 20-second per-test budget while
  removing cross-file contention; it passed 9 files and 113 tests.
- Stream evidence: `evidence/e2-t09-interleave.jsonl`, SHA-256
  `2542e31fea156673a4b1c8b5091773562ca192cc9c8d2b31c75714acef73f8ae`.
  Cold-clone evidence: `evidence/e2-t09-cold-clone.txt`; the pristine clone emitted
  `verify-E2-T09: OK` and
  `cold_clone: verify-E2-T09 PASSED from a pristine clone`.
- Replay: N/A (protocol/server-internal writer fencing with no browser-facing behavior) +
  mitigation: deterministic official-stream interleave log, official-server race tests,
  six sabotage controls, full inherited verification, and exact-head cold-clone proof.

### 2026-07-23 — critic — VERDICT: refuted

- P1 exact-head inherited attestation — FAILED. Predicted
  `make verify-E2-T09` would reproduce the committed exact-head/cold-clone success.
  The focused 58 tests, canonical interleave digest
  `2542e31fea156673a4b1c8b5091773562ca192cc9c8d2b31c75714acef73f8ae`,
  six E2-T09 expected-red mutations, 399 root tests, E2-T08's 23 tests and eight
  attributed sabotages, E2-T07's 35 tests and three attributed sabotages, and E2-T06's
  26 tests all passed. The target then failed E2-T06's exact no-database evidence check:
  the committed attestation says `files-scanned=150`
  (`../E2-T06-stream-namespaces/evidence/e2-t06-no-database.txt:3`), while an
  independent disposable worktree at submission head
  `b5e92ca37210bb31058bfe3cfc2d3ea11847fdd9` regenerated exactly one change,
  `files-scanned=151`. This contradicts the cited transcript's `verify-E2-T09: OK` and
  pristine-clone pass
  (`evidence/e2-t09-cold-clone.txt:3-4,15-21`). Demand: refresh the inherited E2-T06
  no-database attestation at the final implementation head, rerun the complete
  `make verify-E2-T09`, then replace the cold-clone transcript with a new pristine-clone
  run whose recorded head contains that refreshed attestation.
- P2 writer-lane behavior — SURVIVED. Before inspection, predicted three subjects could
  interleave `1,1,1,2,2,2`, a duplicate Bob sequence would append nothing, and an
  actor/writer mismatch would corrupt replay. An independent six-event in-memory run
  observed lanes `{alice:2,bob:2,carol:2}`, log-neutral stale refusal, and typed forged
  actor rejection. The official focused suite separately exercised two-gateway
  different-writer and same-writer races, operation recovery, and precondition replay:
  4 files, 58 tests passed.
- P3 sensitivity — SURVIVED. Predicted replacing the replay fold's prior sequence with
  zero would make the lane sensor red. In a separate disposable worktree, the unchanged
  built probe first emitted `E2_T09_PROBE_OK`; after that one mutation it exited 1 at
  `case=lane-replay` with `WriterLaneCorruptionError` on record 1. The committed
  apparatus also caught all six named mutations.
- COVERAGE — source writer-lane, gateway stamping/refusal, grant recovery, production
  recovery wiring, exports, focused tests, evidence probe, and sensitivity hunks executed
  in the focused/root runs. Inherited evidence/provenance refreshes were re-read by the
  inherited closures; the stale E2-T06 attestation above refutes sufficiency. The
  Makefile's `--maxWorkers=1` official-suite hardening is structurally present at
  `Makefile:39-40`, but the complete critic run correctly stopped at the earlier
  attestation failure; the only claimed execution is therefore inside the contradicted
  cold-clone transcript and must be re-earned after the fix. Type-only exports and
  task/queue metadata are waived as non-runtime.
- MOCK/ENV — the authoritative run required host permission only because the managed
  sandbox refused all localhost listeners with `EPERM`; rerunning unchanged with local
  bind permission cleared those failures. The reproduced attestation drift occurred in a
  detached exact-head worktree and did not depend on warm stream state.
- SUITE: no promotion while the exact-head verification target is red.

Commands: `make verify-E2-T09`;
`node tools/verify/e2_t09_evidence.mjs`; independent three-subject dispatcher probe;
detached-worktree `node tools/verify/e2_t06_no_database.mjs --update-evidence`;
detached-worktree control/mutated `node tools/verify/e2_t09_probe.mjs
packages/platform/dist/src/index.js`.

### 2026-07-23 — builder — run-2 exact-head attestation rework claim

- Closed the critic's sole refutation by regenerating the inherited E2-T06 no-database
  attestation after the E2-T09 transcript file already existed. The implementation head
  `746fdf7d94a7e27ad4d8d4ef8360fffbe8755f76` records
  `files-scanned=151`, `unallowlisted=0`, and `stale=0`.
- Complete host-permission `make verify-E2-T09` passed from clean exact head `746fdf7`:
  58 focused writer-lane tests, six attributable expected-red mutations, 399 root tests,
  the full E2-T08/E2-T07/E2-T06 and identity/provenance closure, 11 storage/runtime
  sensitivity attacks, and 9 official-stream files with 113 tests. The target emitted
  `verify-E2-T09: OK`.
- `tools/verify/cold_clone.sh verify-E2-T09` then cloned the same exact head `746fdf7`,
  checked out pinned emulate commit `82eb835947c97fcf6e0596a4377acbb01ca13ede`,
  hydrated from the frozen lockfile with a scrubbed environment, reproduced the
  151-file attestation, and emitted both `verify-E2-T09: OK` and
  `cold_clone: verify-E2-T09 PASSED from a pristine clone`.
- Proof transcript commit: `1ba6851`. The transcript was updated in place, so it added no
  file to the attestation scope. A subsequent non-mutating
  `node tools/verify/e2_t06_no_database.mjs` reproduced `files-scanned=151`,
  `unallowlisted=0`, and `stale=0` after the transcript update.
- Stream evidence remains `evidence/e2-t09-interleave.jsonl`, canonical SHA-256
  `2542e31fea156673a4b1c8b5091773562ca192cc9c8d2b31c75714acef73f8ae`.
  Cold-clone evidence is `evidence/e2-t09-cold-clone.txt`.
- Replay: N/A (protocol/server-internal writer fencing with no browser-facing behavior) +
  mitigation: deterministic official-stream interleave log, official-server race tests,
  six sabotage controls, full inherited verification, refreshed exact-tree storage
  attestation, and exact-head pristine-clone proof.

### 2026-07-23 — critic — VERDICT: verified

- P1 prior-refutation seam — PASSED. Predicted final submission head
  `d1f04fd7890e5061cd1207f9859efa047b43497e` would independently regenerate the
  inherited E2-T06 no-database proof byte-identically with exactly
  `files-scanned=151`, `unallowlisted=0`, and `stale=0`. Both check-only and
  update-evidence runs produced those values, retained SHA-256
  `55580ce9e18f44ab3cbccb6931af3aa97a42e4b20413e1cdb6937dd5388ba5c6`,
  and left the tree clean. The complete acceptance run reproduced the same
  values before its sensitivity phase.
- P2 transcript/head binding — PASSED. Predicted the refreshed attestation would exist
  at the claimed implementation/evidence head and later commits would not change its
  scan scope. `git show 746fdf7:.eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces/evidence/e2-t06-no-database.txt`
  has the same `55580c...` digest; `1ba6851` changes only
  `evidence/e2-t09-cold-clone.txt`, whose recorded head is exactly `746fdf7`, and
  `d1f04fd` changes only this task readme plus the generated queue. The transcript
  records both `verify-E2-T09: OK` and the pristine-clone success marker.
- P3 writer-lane behavior — PASSED. Predicted an independent nonalternating
  three-subject schedule `ada:1,lin:1,grace:1,grace:2,ada:2,lin:2` would reduce to
  `{ada:2,lin:2,grace:2}`, stamp over forged client actors, allocate six distinct
  global offsets `0..5`, and reject a duplicate Grace sequence with no append.
  Observed exactly those lanes and offsets with `staleAppendDelta=0`. The official
  focused run separately passed 58 tests covering same- and different-writer races,
  recovery/precondition replay, forged metadata, and typed refusal; the committed
  interleave remained canonical with SHA-256
  `2542e31fea156673a4b1c8b5091773562ca192cc9c8d2b31c75714acef73f8ae`.
- P4 sensitivity — PASSED. In a detached disposable worktree at exact submission head,
  the rebuilt control emitted `E2_T09_PROBE_OK`. Replacing only the replay fold's prior
  sequence with zero rebuilt successfully, then exited 1 at `case=lane-replay` with
  `WriterLaneCorruptionError` on record 1. The committed apparatus independently caught
  all six named E2-T09 mutations.
- P5 complete verifier and official serialization — PASSED. A first host run reached
  398/399 root tests before the pre-existing CLI payload-byte sweep exceeded its
  30-second timeout under contention; that unchanged test passed alone in 24.36 seconds.
  A clean whole-target rerun then passed 58 focused tests, six E2-T09 sabotages, 399 root
  tests, E2-T08's 23 tests and eight attributed attacks, E2-T07's 35 tests and three
  attacks, E2-T06's 26 tests and 11 storage/runtime attacks, the identity/gateway/
  provenance/meta closures, and the official suite as 9 files/113 tests. The invoked
  Makefile recipe includes `--maxWorkers=1`, and the run ended with
  `verify-E2-T09: OK`.
- COVERAGE — the focused, root, inherited, evidence, and sensitivity runs exercise the
  writer reducer, platform stamping/refusal, transport-conflict retry, operation recovery,
  grant recovery, production wiring, gateway mappings, official-suite serialization, and
  refreshed evidence/provenance readers. No added `.skip`, `.todo`, lint disable, or
  type-error suppression exists in the task diff. Type-only exports and task/queue
  metadata are waived as non-runtime.
- MOCK/ENV — sandbox-only localhost `EPERM` was reproduced before the unchanged target
  passed with host-local bind permission. The final proof used fresh official stores;
  the prior attestation was also regenerated at the final submission head, and sensitivity
  used a detached exact-head worktree, so no warm service or builder worktree state was
  authoritative.
- SUITE: retain the committed 58-test focused suite, six attributable sabotages, canonical
  interleave golden, inherited exact-tree attestation, and cold-clone transcript. The
  critic's three-subject input is discarded as a redundant one-off schedule over the
  already-promoted reducer/dispatcher invariants.

Commands: `node tools/verify/e2_t06_no_database.mjs --check-only`;
`node tools/verify/e2_t06_no_database.mjs --update-evidence`;
independent three-subject `WriterLaneDispatcher` probe; detached-worktree control and
mutated `node tools/verify/e2_t09_probe.mjs packages/platform/dist/src/index.js`;
isolated CLI payload-byte sweep; `make verify-E2-T09`.
