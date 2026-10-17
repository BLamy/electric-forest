---
id: E7-T02
epic: 7
title: "Agent recorder: durable tool logs and bounded complete-version changeset checkpoints"
priority: 702
status: pending
depends_on: [E7-T01]
estimate: L
capstone: false
---

## Goal

The real Epic 6 hosted runners use `AgentSessionRecorder` for lifecycle, tool, task and
source provenance. Fine-grained edit deltas remain in redacted agent logs. Logical file
saves/checkpoints publish complete immutable E14 versions linked to changesets through
authenticated dispatch. The recorder links each accepted publication to its exact branch
offset, changeset ID and file/content hashes, and resumes without duplicate publication.

## Context

E14 is the source-history authority. This task closes the Nut gap without restoring a
patch-based source format: viewers follow accepted versions while agent logs explain
intermediate editing activity. A logical save groups complete file bytes from one
explicit checkpoint; it never spans unrelated tool calls. Under the fixed fixture of
files at most 256 KiB each, active editing flushes a checkpoint at most every 1000 ms
of recorder receipt and flushes at tool completion. Use a deterministic scheduler for
checkpoint bounds and a host clock for actual browser observation latency in E7-T08.
Token deltas need not trigger full-file uploads individually.

## Deliverables

- `packages/agent-session/src/recorder.ts` with lifecycle/tool logging, explicit save
  checkpoints, complete object upload, changeset publication and source-reference recovery.
- Adapters for the real E6 runners and E14 writer; no alternate filesystem mutation door.
- Integration fixtures for Unicode, CRLF, binary, add/delete/rename, two paths, task
  changes, tool failure/cancellation and lost-response recovery.
- `make verify-E7-T02` and `tools/verify/agent_recorder.sh` producing agent/branch logs,
  complete content objects, version manifests, provenance bijection and tree digests.

## Acceptance criteria

- [ ] The verify target exits 0 cold with fresh provider state, zero skips and ordered
      root gates green; every source dump replays independently twice to the frozen digest.
- [ ] A real runner performs at least 20 logical saves across two files, a binary write,
      rename/delete and task transition. Each save publishes exactly one accepted
      changeset with complete file-version references and contiguous session provenance.
- [ ] Checkpoints obey the 1000 ms bound for the frozen fixture and flush on tool
      completion. Full-byte content hashes match independently captured intended files;
      no source record, projection or evidence object contains textual patch bodies.
- [ ] Remove all agent transcripts from a copy of the fixture. Source replay and full
      content objects still reconstruct the same tree and every historical saved version.
- [ ] Kill after object upload, publication acceptance, and before `agent/source-ref`
      acknowledgement in separate cases. Resume discovers the original operation,
      publishes/references it once, and reaches the uninterrupted run's tree digest.
- [ ] Failure/cancellation/revocation produces a terminal or explicitly recoverable run;
      there are no false running tools, unauthorized publications or leaked secret canaries.
- [ ] Named Replay QA journeys in the configured managed-tunnel project exercise the
      real runner's existing live file/history surfaces after checkpoints, reconnect and
      failure. Record journey/test-run IDs and zero console errors plus matching source
      offsets/digests; use AGENTS.md's literal fallback if the service is unavailable.

## Adversarial verification

1. Use independently seeded Unicode/CRLF/binary edits and rapid path/tool changes. Any
   wrong bytes, crossed checkpoint boundary or missing save refutes capture.
2. Kill at every object/publication/reference boundary, including lost responses. Any
   duplicate logical changeset or unresolved accepted publication refutes recovery.
3. Search source/content/projection/evidence records outside agent logs for patch bodies;
   then remove the logs and reconstruct the tree. Either patch persistence or log-dependent
   source reconstruction refutes the model.
4. Sabotage the recorder to buffer beyond 1000 ms, omit one version, double-publish one
   checkpoint and write outside dispatch. Each mutation must fail its named assertion.
5. Revoke access between staged upload and publication. A later branch mutation refutes
   authorization even if the staged bytes already exist.

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
