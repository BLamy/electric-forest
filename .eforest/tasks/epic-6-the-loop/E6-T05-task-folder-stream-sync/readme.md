---
id: E6-T05
epic: 6
title: "Task folders on streams: bidirectional projection without echo, drift, or side-channel status writes"
priority: 605
status: in-progress
depends_on: [E6-T01, E6-T02, E6-T04]
estimate: L
capstone: false
---

## Goal

`packages/tasks` joins `.eforest` task folders to task streams: valid local specification
and Verification-log edits become validated task events through dispatch, while accepted
task/attachment events materialize deterministic `readme.md` and `evidence/` bytes on the
project branch. A provenance journal prevents projection echo, `work/` remains ephemeral,
and task status can never change by bypassing the task transition validator.

## Context

Epic 6 must preserve the folder users and agents work in while making replayed streams
authoritative. E6-T01 owns lifecycle semantics, E6-T02 owns syntax and bytes, and E6-T04
owns the queue projection. This task composes them into the same full-duplex pattern
proven by Epic 4: origin-tagged events, a total journal, measured quiescence, and exact
tree/log digest parity.

A local change to prose/spec fields dispatches `task/spec-revised`; an appended builder
or critic log entry dispatches its corresponding lifecycle event only when its structured
fields validate. Raw frontmatter status edits are requests, not authority, and are
rejected unless backed by the legal event/actor. Evidence files become E5 attachment
content streams before their references append to the task. Projected writes carry a
sync origin and may not re-dispatch themselves.

## Deliverables

- `packages/tasks/src/folder/sync.ts`, `ingest.ts`, `project.ts`, and `journal.ts` with a
  frozen canonical provenance-journal format.
- stream-fs watcher integration for task folder creation, spec revision, verification-log
  append, evidence add/remove, and deterministic projection back to the task branch.
- Refusal/conflict artifacts for malformed folders, stale spec edits, illegal status
  edits, hash mismatch, and concurrent prose edits.
- Real-server, two-client integration tests and `Makefile` target `verify-E6-T05`.

## Acceptance criteria

- [ ] `make verify-E6-T05` exits 0 cold with zero skips; its mixed local/remote schedule
      ends with task state, rendered folder, evidence manifest, and derived queue at heads
      whose canonical digests byte-equal the independently replayed streams.
- [ ] A valid local task folder creation and prose revision each append exactly one
      validated task event; projection of those events does not append an echo, proven by
      exact logical-change/event counts and a frozen head over at least 10 idle seconds.
- [ ] Editing `status: verified` locally without a critic verdict is refused, leaves the
      task and queue stream heads unchanged, and restores/projects the authoritative
      status with a stable conflict artifact naming the refusal.
- [ ] Adding arbitrary binary evidence creates one content stream whose SHA-256 matches
      the local bytes and one task attachment reference; removing a reference does not
      delete shared content, and replay reconstructs the same evidence bytes.
- [ ] Changes under `work/` cause zero task, evidence, queue, or project events and do not
      change any durable digest.
- [ ] Two clients concurrently revising the same spec from one base cannot silently
      overwrite: one fenced append wins and the loser receives a deterministic conflict
      file retaining its bytes; replay/project after resolution is identical on both.
- [ ] Every accepted input/output is represented in the provenance journal exactly once
      in its frozen disposition, and deleting derived folders then projecting from the
      streams recreates exact readme/evidence bytes.
- [ ] Browser evidence is declared `Replay: N/A (task-folder sync engine; the dedicated
      browser task surface lands in E6-T06)`; mitigation is the two-client schedule,
      measured quiescence, journal audit, byte hashes, and replay/tree digest parity.

## Adversarial verification

1. Run two independent folder watchers with racing spec, status, log, and evidence edits.
   Lost bytes, two accepted stale edits, divergent final digests, or an unjournaled action
   refutes synchronization.
2. Forge a builder Verification-log paragraph claiming a critic verdict and directly
   edit frontmatter. Any path to verified without a valid critic event refutes the sole
   mutation door.
3. Delay projected stream-fs writes beyond batching windows and leave the system idle for
   60 seconds. Any head movement after quiescence refutes provenance echo suppression.
4. Replace an evidence file after hashing but before append, and attempt symlink/path
   escapes. A reference whose digest does not match replayed content, or an outside read,
   refutes evidence integrity.
5. Disable origin filtering in a scratch worktree. The verify target must fail on exact
   event count or quiescence; green refutes sensitivity.

## Verification log
