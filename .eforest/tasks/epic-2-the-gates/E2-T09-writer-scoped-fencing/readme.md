---
id: E2-T09
epic: 2
title: "Writer-scoped application fencing above global Stream-Seq ordering"
priority: 209
status: implemented
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
