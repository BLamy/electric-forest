---
id: E7-T06
epic: 7
title: "Time-travel projector: reconstruct the whole branch workspace at any activity offset"
priority: 706
status: pending
depends_on: [E7-T03]
estimate: L
capstone: false
---

## Goal

`@eforest/platform` exposes a read-only branch time-travel projection at
`GET /api/repos/:org/:repo/branches/:branch/at/:activityOffset`. It replays the activity
stream through the requested opaque offset, obtains its source high-watermark vector,
then replays each referenced file/tree, issue, PR, task, evidence, and agent-session
stream only through that source offset. The response contains the reconstructed entity
states, vector, and a composite SHA-256 digest over canonically encoded per-stream
digests sorted by stream id. Repeating the same request is byte-identical and performs
zero dispatches.

## Context

This is the redux-devtools move applied to the one-model repository. "At offset" means
the E7-T03 activity cursor, not a wall clock and not independently choosing each
entity's current head. Entities absent from the prefix are absent; entities deleted or
closed by the prefix remain in their reduced historical state. Stream snapshots may
accelerate replay, but the answer must equal a full fold from `-1` exactly.

## Deliverables

- `packages/platform/src/activity/project-at.ts` implementing prefix validation,
  high-watermark replay, auth filtering, and canonical composite digest.
- The read-only HTTP route plus typed failures for unknown/retained-away cursor,
  unresolved source ref, corrupt digest, and unauthorized branch.
- `ef replay --activity <dump> --sources <dir> --at <offset> --digest` as an independent
  offline instrument producing the same vector and composite digest.
- Golden source corpus with expected projections at every activity prefix, tests for
  snapshots/retention/concurrency, `make verify-E7-T06`, and mutation/bisect evidence.

## Acceptance criteria

- [ ] `make verify-E7-T06` exits 0 from a scrubbed cold clone with zero skips; all root
      gates pass.
- [ ] For every offset in the committed activity fixture, HTTP projection and offline
      CLI replay produce byte-identical high-watermark vectors and composite digests,
      pinned in `evidence/e7-t06-prefixes.txt`.
- [ ] Tree bytes and issue/PR/task/session states at three named prefixes equal frozen
      golden artifacts; later events are absent even while source streams have advanced
      beyond the requested cursor.
- [ ] Full replay and snapshot-accelerated replay return byte-identical canonical
      responses and digests for every cursor still retained.
- [ ] A time-travel request appends zero events to every stream: before/after dumps are
      byte-identical, including error responses.
- [ ] Unknown, malformed, pruned, unauthorized, or digest-corrupt cursors fail with the
      expected typed status and never fall back to current head.
- [ ] Browser evidence is `N/A` because this task is the projection engine/CLI; prefix
      goldens, two-instrument digest equality, and no-mutation dumps are cited instead.

## Adversarial verification

1. Choose random activity prefixes and reconstruct every source independently from raw
   dumps. Any vector, state, or composite mismatch refutes the projector.
2. Append future events to all source streams while repeatedly querying an old cursor.
   Any historical response drift refutes prefix isolation.
3. Compare full replay against every available snapshot boundary; a one-byte difference
   or retained-away cursor silently mapped to head refutes.
4. Capture all stream dumps before and after successful and failing requests. Any append
   refutes read-only time travel.
5. Flip one byte in one source dump and ensure the composite check fails naming that
   stream/offset; use `ef bisect` to pin it. A green response refutes sensitivity.
6. Sabotage the projector to use current heads for one entity. The every-prefix suite
   must fail before its expected-fail marker.

## Roadmap alignment — 2026-10-16

This task runs after the hosted loop and E14 source transition. Accepted source changes are
complete immutable versions linked to changesets; fine-grained edit/patch text belongs only in
redacted agent logs. Activity and historical views reference actual changeset, version and
source-offset identities; transient highlights are computed from full versions. No new
branch/content/projection/evidence artifact may persist textual patch bodies. Legacy verified
streams/evidence remain unchanged.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
