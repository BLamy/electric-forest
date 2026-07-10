---
id: E7-T01
epic: 7
title: "Agent session event contract: durable lifecycle, tool, file-edit, and task provenance on streams"
priority: 701
status: pending
depends_on: [E6]
estimate: M
capstone: false
---

## Goal

`@eforest/agent-session` (`packages/agent-session`) defines the durable contract for a
hosted AI edit session. Session lifecycle and tool events are dispatched to
`agent:<org>/<repo>:<sessionId>`; file and task mutations remain on their existing
branch/content/task streams and carry a validated `origin` envelope
`{ sessionStream, sessionSeq, toolCallId? }`. Each accepted external mutation is then
acknowledged on the session stream by `agent/source-ref` carrying its exact source
stream, offset, and event digest. The session reducer exposes status, actor, branch,
task, open tool calls, and the last contiguous sequence. Every visible AI action can
therefore be traced to exactly one source-stream offset without copying repository
state into a side log or bypassing the dispatch door.

## Context

Epic 6 supplies hosted builder/critic agents and task streams; this task gives their
runtime activity a versioned public shape. The contract deliberately references actual
stream offsets: a decorative transcript that says a file changed is not evidence that
the branch changed. `origin` is optional for non-agent dispatches but mandatory for
mutations claimed by a session. Sequence numbers are positive safe integers, start at
1, and are contiguous per session; stream offsets remain opaque strings.

The frozen event kinds are `agent/session-started`, `agent/tool-started`,
`agent/source-ref`, `agent/tool-finished`, and `agent/session-ended`. Existing
file-patch and task events retain their existing schemas and add only `origin`;
`agent/source-ref` is provenance, not a second mutation or a copy of file/task state.
Tool payloads store redacted summaries plus SHA-256 digests, never raw credentials. No
database, transcript file, or process-local map is authoritative.

## Deliverables

- `packages/agent-session/src/schema.ts` with versioned event and `AgentOrigin`
  schemas, exact validation failures, and canonical encoding.
- `packages/agent-session/src/reducer.ts` with a pure reducer rejecting duplicate,
  skipped, regressing, mismatched-session, and finish-without-start sequences.
- Dispatch validation in `packages/platform` for agent-session events and `origin`
  references, including authorization against the referenced branch/task.
- Golden valid and invalid logs under `packages/agent-session/fixtures/` with pinned
  per-prefix state digests.
- `make verify-E7-T01`, unit/property tests, and task evidence containing replay,
  mutation-sensitivity, and schema-fuzz transcripts.

## Acceptance criteria

- [ ] `make verify-E7-T01` exits 0 from `tools/verify/cold_clone.sh` with zero skips;
      all workspace gates pass.
- [ ] Replaying the committed valid fixture twice from offset `-1` yields the same
      pinned digest at every prefix, recorded in `evidence/e7-t01-digests.txt`.
- [ ] Every malformed sequence class (gap, duplicate, regression, wrong session,
      unknown kind, tool finish without start, double finish) is refused before append
      with a stable typed error and leaves a before/after stream dump byte-identical.
- [ ] A file or task mutation carrying `origin` is accepted only when the session,
      sequence, actor, branch/task authorization, and referenced open tool call agree;
      a one-field mismatch is rejected without an appended event.
- [ ] The package dependency graph reachable from the reducer contains no network,
      filesystem, clock, random, or database module; replay is a pure fold.
- [ ] The final claim names stream evidence explicitly. Replay browser evidence is
      `N/A` because this task adds no browser surface, with golden logs and digest
      sensitivity named as the mitigation.

## Adversarial verification

1. Generate valid sessions with random tool nesting and origins, then mutate one field
   at a time. Any invalid append accepted, or valid sequence rejected, refutes the
   schema/reducer contract.
2. Race two writers using the same next `sessionSeq`. Exactly one may append; two
   accepted records or a gap after retry refutes writer fencing.
3. Reuse an authorized session origin against another branch, task, actor, and repo.
   Any cross-scope acceptance refutes provenance authorization.
4. Flip one byte in each golden record. Replay must fail at that record or change the
   prefix digest; a green unchanged digest refutes the apparatus.
5. In a scratch worktree, disable sequence validation and confirm `verify-E7-T01`
   fails. A green sabotage run refutes test sensitivity.
6. Run from a cold clone with scrubbed environment and grep source and dependencies for
   database or side-log storage. Any required warm state or hidden authority refutes.

## Verification log
