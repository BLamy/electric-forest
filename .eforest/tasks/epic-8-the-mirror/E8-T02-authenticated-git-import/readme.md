---
id: E8-T02
epic: 8
title: "Authenticated git import: resumable plan execution creates a stream-native repository and proves source-to-server digest parity"
priority: 802
status: pending
depends_on: [E8-T01]
estimate: L
capstone: false
---

## Goal

`ef import-git` executes a verified `ImportPlanV1` through the authenticated platform
dispatch door and produces a new stream-native repository whose `main` tree digest is
byte-equal to the plan's expected digest. Namespace creation, branch genesis, and every
file mutation use existing E2/E1 events; there is no store bypass. The command persists
an import receipt outside the source tree under `$EF_HOME/imports/<planDigest>.json`,
including destination ids, accepted action indexes/offsets, server head, and final
digest. If interrupted, `--resume <receipt>` reads server state and continues at the
first unacknowledged action without duplicating accepted events. A completed plan is
idempotent: resume performs zero appends and returns the same receipt.

## Context

E8-T01 proved that a canonical plan represents the selected Git tree. This task is the
only bridge writer and proves that executing that plan produces the same state on the
real platform. It reuses E4-T02's authenticated namespace/tree-upload primitives where
their contracts fit, E0-T11's validated dispatch door, E2 authorization and namespace
rules, and E1 stream-fs replay. It may not introduce an import-only append endpoint or a
second filesystem reducer.

Crash atomicity across many append-only streams is expressed as resumability rather than
rollback: accepted events are honest history, and the receipt plus server offsets say
exactly which actions landed. A failed import does not claim completion and cannot be
cut over by E8-T03. The server records an `import.prepared { v: 1, planDigest,
sourceCommit, expectedTreeDigest, destination }` event on the project stream before tree
actions and one `import.completed { v: 1, planDigest, mainHead, actualTreeDigest }`
after independent server replay proves parity. These provenance events do not mutate the
tree and are versioned here.

## Deliverables

- `packages/import-git/src/execute.ts` — authenticated ordered execution, per-action
  acknowledgement, server-state reconciliation, and typed errors for destination
  collision, receipt mismatch, changed server prefix, and final digest mismatch.
- `packages/import-git/src/receipt.ts` — canonical `ImportReceiptV1` parser/writer with
  atomic local replacement; receipt fields are sufficient to audit or resume without
  reading Git again.
- `packages/import-git/src/events.ts` and server validators for `import.prepared` and
  `import.completed`; completion is legal exactly once and only when the server-replayed
  main digest equals the prepared expected digest.
- `packages/cli` wiring for `ef import-git ... --execute`, `--resume <receipt>`, and
  `--json`; credentials and typed exit behavior reuse E2-T05.
- Integration tests against the real file-backed server: successful import, unauthorized
  refusal, kill/restart after multiple action boundaries, duplicated response after an
  accepted append, tampered receipt, occupied destination, and final-digest fault.
- `Makefile` target `verify-E8-T02`; committed plan, receipt, project/meta/content dumps,
  per-stream digests, request/offset timeline, and sensitivity transcript in `evidence/`.

## Acceptance criteria

- [ ] `make verify-E8-T02` exits 0 from a cold clone with a fresh file-backed server,
      fresh `$EF_HOME`, scrubbed environment, and zero skips; transcript committed as
      `evidence/e8-t02-transcript.txt`.
- [ ] A real authenticated import creates exactly one project/repo/main destination,
      appends only validated dispatch events, and produces a server-replayed main tree
      digest byte-equal to the E8-T01 plan's expected digest and an independently
      materialized source digest; offsets and all three values are in
      `evidence/e8-t02-digests.txt`.
- [ ] The project provenance stream contains exactly one `import.prepared` followed by
      exactly one `import.completed`; their plan/source/tree fields byte-equal the plan
      and receipt, and completion's `mainHead` is the actual meta-stream head.
- [ ] Killing the importer after branch genesis, after a content write, and after the
      final tree action but before completion, then restarting the server and running
      `--resume`, reaches the same event dumps and final digest as an uninterrupted run.
      The transcript shows no duplicate logical file event at any acknowledged index.
- [ ] Running resume again after completion sends zero append requests and emits a
      receipt byte-identical to the completed receipt; the project/main head offsets and
      dump digests are unchanged before and after.
- [ ] No credentials, revoked credentials, and a credential without destination write
      grant are refused with E2's exact class/status before `import.prepared`; project
      registry and all destination stream enumerations remain byte-identical.
- [ ] A tampered plan, receipt plan-digest mismatch, receipt naming another destination,
      occupied repo name, and fault-injected final tree mismatch each exit nonzero with
      a pinned typed error and never append `import.completed`.
- [ ] Every mutation observed in the server request trace targets the existing dispatch
      endpoint; a source scan and request assertion find zero direct store calls or
      import-only mutation routes.
- [ ] Sensitivity: drop one accepted-action acknowledgement and replay the same response,
      and separately corrupt one server content event before completion. The first must
      remain duplicate-free; the second must refuse completion on digest mismatch. The
      observed red/green boundaries are committed in `evidence/e8-t02-sensitivity.md`.
- [ ] `ef clone` of the imported main branch into an empty directory produces a tree
      digest byte-equal to the plan and contains `.eforest/` while containing no `.git/`.
- [ ] Root gates and `make verify-E8-T01`, the applicable E1 branch/stream-fs targets,
      and E2 authorization targets re-run green unchanged.

## Adversarial verification

1. Interrupt execution at critic-chosen action indexes, including between a server
   acceptance and client receipt write. Resume each against a restarted file-backed
   server. Duplicate events, missing bytes, or final digest drift refutes resumability.
2. Forge receipts: reorder acknowledgements, advance the last index, change destination,
   swap plan digest, or point at a different server. Any completion based on receipt trust
   rather than server reconciliation refutes the task.
3. Revoke the token mid-import. Events accepted before revocation may remain, but every
   later dispatch must be refused and completion absent. A hidden store append or a
   completed receipt after revocation is a finding.
4. Race two executions of the same plan and two different plans into the same destination.
   Exactly one prepared import may own it; neither race may create mixed tree state that
   can complete.
5. Sabotage final verification so it compares the expected digest with itself, then
   corrupt one content event. The target must go red. A green run refutes the independent
   server-replay instrument.
6. Audit the entire request timeline and implementation diff. Any mutation path other
   than validated dispatch, or any changed writer branch not exercised by recorded
   evidence, is needs-evidence or dead code under AGENTS.md.

## Verification log
