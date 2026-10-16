---
id: E11-T01
epic: 11
title: Restore an application fork from its exact code artifact and authoritative stream boundary
priority: 1101
status: pending
depends_on: [E10]
estimate: M
capstone: false
---

## Goal

`@eforest` restores an application fork into an empty environment from the immutable
manifest produced by the verified E10 workflow. The restore selects the exact code
artifact and authoritative application-stream offsets and reproduces their recorded
state digests; browser recordings are observational evidence and never replace the
platform streams as application-state authority.

## Context

The whitepaper's lifecycle depends on replayable application forks whose code and
authoritative state can be reconstructed together. This task establishes that primitive
before comparison or incident replay can be trusted. Restore consumes the existing
Electric Forest stream substrate and E10 manifest contract; it does not add a Durable
Streams transport, infer missing state from a browser recording, or apply unrecorded
commands. A restore runs without production credentials or live external effects.

The restore manifest's versioned schema, required artifact references, stream boundary
semantics, and digest algorithm are frozen here. Missing retained history is a typed
failure; the implementation must never silently substitute a current head or warm local
cache.

## Deliverables

- A versioned application-fork restore contract and implementation using the E10 manifest.
- A restore command/service that materializes an isolated environment from a clean root.
- Frozen valid, malformed, truncated, missing-offset, wrong-artifact, and digest-mismatch
  fixtures under the task's evidence or permanent fixture corpus.
- `make verify-E11-T01` and a committed restore transcript, manifest, and before/after
  digest report under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T01` exits 0 from a cold clone with a fresh data directory and
      scrubbed environment; `evidence/e11-t01-restore.jsonl` records the selected
      artifact and exact stream offsets, and `evidence/e11-t01-restore-summary.json`
      shows each restored state digest byte-equal to the manifest digest.
- [ ] Restoring the same manifest twice into separate empty roots yields byte-equal
      canonical state snapshots and identical per-stream offsets/digests in the two
      summaries.
- [ ] A restore using an unavailable historical offset, altered artifact digest, or
      altered expected state digest exits nonzero with a typed error naming the affected
      reference; `evidence/e11-t01-invalid-inputs.json` records each rejection.
- [ ] Truncated, malformed, duplicate-reference, and unknown-version manifests each
      fail before a restored application is reported as ready; the evidence records zero
      success receipts for these cases.
- [ ] A process/network trace in `evidence/e11-t01-effects.json` shows zero writes to the
      source project and zero live external effects during restore; the planted forbidden
      write/effect sensitivity case is detected by `make verify-E11-T01`.
- [ ] Replay evidence is declared in the Verification log as `Replay: N/A (restore is a
      non-browser platform operation) + manifest, event-log, and digest evidence`; no
      browser behavior is claimed by this task.

## Adversarial verification

1. Delete one retained event range and attempt restore. Any fallback to a newer head,
   partial ready state, or digest that still claims equality refutes exact restoration.
2. Change one byte in the referenced code artifact while keeping the manifest unchanged.
   If the environment becomes ready or records the manifest digest as its artifact digest,
   artifact binding is refuted.
3. Restore with a warm cache and then with a cold root while tracing file and stream
   reads. A warm-only success or unlisted input affecting the result refutes the claim.
4. Corrupt and truncate each manifest/stream fixture, then add one unknown version and
   duplicate offset reference. Any successful restore or untyped ambiguity refutes
   fail-closed parsing.
5. Inspect source-project offsets before and after each restore and plant a forbidden
   external-effect adapter. Any source append, effect call, or undetected planted call
   refutes isolation or the measuring apparatus.
6. Independently replay the cited event logs and recompute the canonical digests. Any
   mismatch with the recorded manifest or clean-root result refutes the evidence.

## Roadmap alignment — 2026-10-16

E12 delivers Forest hosting now; this epic is later provenance-aware operation of hosted
applications. Deployment, restoration, comparison, incident and repair records pin the E14
source changeset and complete file-version/content-manifest hash in addition to tested build
and authoritative state offsets. Stale source/content identity invalidates evidence even when
a branch name or artifact label is unchanged. Derived diffs remain in memory; textual patches
persist only in redacted agent tool logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log

