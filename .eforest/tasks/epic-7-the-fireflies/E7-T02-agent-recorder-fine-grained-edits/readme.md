---
id: E7-T02
epic: 7
title: "Agent recorder: fine-grained file patches, tool calls, and task activity emitted while work happens"
priority: 702
status: pending
depends_on: [E7-T01]
estimate: L
capstone: false
---

## Goal

The Epic 6 hosted-agent runtime uses `AgentSessionRecorder` from
`@eforest/agent-session` for every run. It emits lifecycle/tool events and attaches
`AgentOrigin` to actual stream-fs and task dispatches as they occur. Text-edit callbacks
become ordered stream-fs patch events without waiting for tool completion: a chunk is
at most 256 Unicode scalar values and flushes within 100 ms, chunks never coalesce
across paths or tool calls, and no end-of-tool whole-file snapshot substitutes for the
fine-grained trail. A resumed runner continues from the durable session sequence and
does not duplicate accepted edits.

## Context

This closes the Nut gap at the write source. The recorder is not a logger beside the
mutation path: its file callbacks dispatch through stream-fs, its task callbacks
dispatch through the task reducer, and the returned source offsets are the proof the
later activity timeline cites. E7-T01 froze provenance and ordering. This task adapts
the real Epic 6 builder and critic runners; a toy standalone emitter is insufficient.

The 100 ms/256-scalar bounds define "keystroke-granular" for this product. Deletes and
replacements are emitted immediately as patch operations; binary writes remain one
content event and are explicitly labeled `binary`, not falsely split into text.

## Deliverables

- `packages/agent-session/src/recorder.ts` implementing lifecycle, tool, text-edit,
  binary-write, source-reference acknowledgement, and task-activity methods with
  durable sequence recovery.
- Epic 6 runner adapters that route real builder/critic file and task callbacks through
  the recorder and forbid direct unproven writes during an active session.
- `packages/agent-session/test/recorder.integration.test.ts` against a real platform
  server, including crash/restart, unicode, concurrent paths, deletes, and errors.
- `tools/verify/agent_recorder.sh` and `make verify-E7-T02`, producing a session dump,
  branch/content dumps, a provenance bijection, and digest parity transcript.
- Evidence fixtures proving chunk sizes, flush latency, source offsets, recovery, and
  the final materialized tree digest.

## Acceptance criteria

- [ ] `make verify-E7-T02` exits 0 from a cold clone with a fresh server data dir and
      zero skips; all root gates pass.
- [ ] A real hosted-agent fixture performs at least 20 incremental text callbacks on
      two files plus a delete and task-status change; every callback is represented by
      exactly one accepted source event or a documented split into chunks of at most
      256 scalars, and every event carries the correct contiguous session origin.
- [ ] Each text callback is appended within 100 ms of recorder receipt under the
      committed deterministic test clock; no patch spans two paths or tool calls, and
      no full-file replacement appears where incremental patches were supplied.
- [ ] Replaying the branch/content dumps yields a tree byte-identical to the runner's
      final files, and every session-origin source offset resolves to exactly one real
      event; results are committed under `evidence/`.
- [ ] Killing the runner after source append but before `agent/source-ref` or its local
      checkpoint and then resuming resolves the origin-bearing source event, appends
      exactly one missing reference without repeating the mutation, produces no skipped
      `sessionSeq`, and reaches the same final tree digest as an uninterrupted run.
- [ ] Tool failure, cancellation, and runner crash all end in replayable terminal or
      recoverable session state; no tool remains falsely `running` after recovery.
- [ ] Browser evidence is declared `N/A` because this task changes the agent runtime,
      with stream dumps, source-offset bijection, and tree digest as mitigation.

## Adversarial verification

1. Supply your own unicode edit stream with combining marks, emoji, CRLF, empty inserts,
   overlapping deletes, and rapid path switches. Any wrong bytes or chunk crossing a
   boundary refutes fine-grained capture.
2. SIGKILL at every recorder boundary: before source dispatch, after its append response,
   before `agent/source-ref`, after the ref, before checkpoint, and during tool failure.
   Any duplicate mutation/ref, gap, or unrecoverable open tool refutes crash recovery.
3. Inspect the runner diff and block every write path except authenticated dispatch.
   If the run still changes a file by direct filesystem/server mutation, the one-door
   claim is refuted.
4. Compare source events to recorder callbacks as a bijection and resolve every offset
   independently from fresh dumps. A decorative activity entry without a real mutation,
   or an unreported mutation, refutes provenance.
5. Sabotage chunk flushing to buffer until tool completion and to emit whole-file
   snapshots; `verify-E7-T02` must fail both variants.
6. Cold-start twice with identical scripted callbacks and compare normalized event
   shapes and final digests. Nondeterministic order or warm-state dependence refutes.

## Verification log
