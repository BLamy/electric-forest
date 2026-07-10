---
id: E7-T03
epic: 7
title: "Branch activity timeline: a rebuildable derived stream of source-offset references"
priority: 703
status: pending
depends_on: [E7-T01]
estimate: L
capstone: false
---

## Goal

`@eforest/platform` materializes one derived activity stream per branch,
`activity:<org>/<repo>:<branch>`. Its only event, `activity/ref`, points to an actual
source event by `{ sourceStream, sourceOffset, sourceDigest, kind, entityRef,
sessionStream?, sessionSeq? }`; it never copies source state. The projector consumes
the session stream's validated `agent/source-ref` records plus lifecycle/tool records,
so agent activity is complete and ordered by durable session sequence without guessing
across independent stream clocks. The reducer produces an ordered feed and a
high-watermark map of every referenced source stream; duplicates key on `(sourceStream,
sourceOffset)`, and every reference is resolved and digest-checked before append. The
index can be deleted and rebuilt from source logs to the identical canonical digest.

## Context

This is the single timeline used by both the firefly feed and time travel. A cursor is
an opaque activity-stream offset; the reduced high-watermark map at that cursor says
exactly how far every branch file, issue, PR, task, and agent-session stream had
advanced. That vector makes "rewind the whole repo" precise without inventing a global
database clock. E2's registry projection and E5's session replay are prior art; the
index remains derived and disposable under architectural bet 4.

Only events attached to the branch or its repo entities enter the timeline. Source
authorization is rechecked when reading; an activity reference never grants access to
an otherwise private stream.

## Deliverables

- `packages/platform/src/activity/events.ts`, `reducer.ts`, `projector.ts`, and
  `rebuild.ts` for validation, exactly-once projection, and deterministic rebuild.
- `GET /api/repos/:org/:repo/branches/:branch/activity` using the normal offset/live
  protocol and authorization filtering without changing stored order.
- Golden multi-stream fixtures covering file patches, tools, issue/PR/task events,
  concurrent sessions, tombstones, and denied entities.
- `make verify-E7-T03` plus rebuild-destruction, reference-integrity, reconnect, and
  mutation-sensitivity tests and committed evidence.

## Acceptance criteria

- [ ] `make verify-E7-T03` exits 0 from a scrubbed cold clone with zero skips; all
      workspace gates pass.
- [ ] Every emitted `activity/ref` resolves to exactly one source record whose bytes
      hash to `sourceDigest`; a missing offset or digest mismatch prevents projection
      and surfaces a typed error naming the reference.
- [ ] Projecting the same source offset twice yields one activity item, while two
      distinct source offsets remain distinct even if their payloads are equal.
- [ ] Delete the derived activity stream, rebuild only from committed source dumps,
      and compare the original and rebuilt activity logs and state digests byte-for-byte;
      evidence is committed in `evidence/e7-t03-rebuild.txt`.
- [ ] At every activity prefix, replaying the reducer yields the exact source-stream
      high-watermark vector expected from that prefix; the fixture pins its digest.
- [ ] Long-poll and SSE readers resume from an activity cursor without gap or duplicate,
      and authorization never reveals a reference to a source stream the caller cannot
      read.
- [ ] Browser evidence is `N/A` because this task exposes protocol/index behavior only;
      reference-resolution, rebuild, and digest evidence are cited instead.

## Adversarial verification

1. Forge refs to absent, later, wrong-repo, wrong-branch, and digest-mismatched source
   events. Any append or disclosure refutes reference integrity.
2. Hammer the projector with duplicate notifications and concurrent sessions. Compare
   source-offset sets exactly; any missing or duplicate ref refutes exactly-once.
3. Destroy the index and rebuild after shuffling discovery order. The canonical log and
   digest must match; order-dependent output refutes rebuildability.
4. At random activity offsets, independently replay every source only through the
   reduced high-watermark and compare the vector's composite digest. One mismatch
   refutes the cursor contract.
5. Revoke access while tailing. The next protected item must not leak; continued
   payload/ref visibility refutes authorization.
6. Sabotage deduplication and source digest checking in scratch worktrees. The verify
   target must fail each mutation before printing its expected-fail marker.

## Verification log
