---
id: E6-T08
epic: 6
title: "Builder agent: take the eligible task onto a task branch, earn gates, and submit a claim with evidence"
priority: 608
status: pending
depends_on: [E6-T05, E6-T07]
estimate: L
capstone: false
---

## Goal

`packages/loop` provides a runnable `BuilderAgent` that acquires the sole eligible task,
forks a deterministic `task/<id>/<attempt>` branch at the claimed main offset,
materializes its `.eforest` workshop, applies changes only through branch-stream tools,
runs the project's ordered gates, records the final run, attaches durable evidence, and
appends one fenced `task/claimed` event. A failing or skipped gate cannot produce a claim.

## Context

The builder protocol in AGENTS.md becomes platform behavior here. E6-T07 provides the
lease, workspace, capabilities, and run log; E6-T05 provides task folders and evidence
sync. The agent implementation is an `AgentAdapter` prompt/tool contract plus a
deterministic fixture adapter used to prove orchestration. No git operation is part of
the hosted path: the task branch is an E1 branch stream and the diff is its replayed
since-fork event range.

The ordered gate contract is project-configured but defaults to format/lint, typecheck,
test, build. Evidence is a complete stream dump/digest for every run and browser Replay
when the task diff reaches a web surface. Absence must be an explicit typed
`browserEvidence: not-applicable` with reason and mitigation; silence is invalid.

## Deliverables

- `packages/loop/src/builder/agent.ts`, `prompt.ts`, `tools.ts`, `gates.ts`,
  `claim.ts`, and `evidence.ts`.
- Branch naming/fork metadata, since-fork diff manifest, ordered gate result schema, and
  recorded-final-run manifest with content-addressed attachments.
- Hosted sample fixtures for a successful non-browser task, a browser task, gate failure,
  crash/resume, and stale-lease claim.
- `Makefile` target `verify-E6-T08` and deterministic builder-run golden logs.

## Acceptance criteria

- [ ] `make verify-E6-T08` exits 0 cold with zero skips and independently replays the
      builder run, task, task-branch, and evidence streams to the committed composite
      digest.
- [ ] From one eligibility proof the builder creates exactly one branch fork at the cited
      main offset, changes only that branch, and submits a claim whose diff manifest
      exactly enumerates the since-fork events and final branch head/digest.
- [ ] The four default gates execute in order; any nonzero, missing, weakened, or
      `SKIPPED:` result aborts before `task/claimed`, leaves task status in-progress, and
      attaches the failure transcript to the run.
- [ ] A successful final run attaches immutable log/digest artifacts whose hashes match
      replayed bytes and then appends exactly one claim referencing those attachments,
      the run, branch, fork/head offsets, and tested commit-equivalent branch digest.
- [ ] A browser-impacting fixture cannot claim without an uploaded Replay URL/recording
      manifest and zero-console-error result; the non-browser fixture must carry the
      explicit N/A reason and stream-layer mitigation.
- [ ] Crash after evidence upload but before claim resumes idempotently: no duplicate
      content stream, attachment, branch mutation, gate execution, or claim event; the
      resumed run cites the original accepted ids.
- [ ] Stale queue/lease/project offsets and attempts to write main or a sibling task
      branch are refused with no target-head movement.

## Adversarial verification

1. Supply adapters that exit 0 without emitting one gate, print `SKIPPED:`, weaken a
   command with `|| true`, and report green after a failing child. Any resulting claim
   refutes gate enforcement.
2. Recompute the branch diff from fork to claimed head and compare every event/hash to
   the claim manifest. One omitted changed event or claimed unexecuted head refutes
   sufficiency.
3. Crash at every boundary from fork through attachment and claim append, then resume.
   Any duplicate logical action or missing evidence refutes idempotency.
4. Mark a code path browser-impacting after the final run. Acceptance without Replay, or
   Replay with a console error in the cited recording, refutes evidence policy.
5. Sabotage gate-order enforcement in a scratch worktree. The verify target must fail on
   an out-of-order fixture; green refutes sensitivity.

## Verification log
