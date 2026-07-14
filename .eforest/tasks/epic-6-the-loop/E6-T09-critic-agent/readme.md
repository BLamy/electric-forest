---
id: E6-T09
epic: 6
title: "Critic agent: fresh-session falsification, diff coverage, and cited refuted or verified verdicts"
priority: 609
status: pending
depends_on: [E6-T08]
estimate: L
capstone: false
---

## Goal

`packages/loop` provides a runnable `CriticAgent` that starts in a fresh isolated session,
orients on the task/claim/diff/evidence, writes falsifiable predictions before probes,
executes the task's attacks with independent inputs, audits changed-hunk evidence
coverage, and appends exactly one `task/refuted` or `task/verified` verdict with point,
offset, digest, or diff citations. It cannot alter implementation code or verify its own
builder run.

## Context

This task productizes the critic charter, not a second test runner. E6-T08 freezes the
claim/diff/evidence manifest; E6-T07 guarantees the fresh process and critic capability.
The verdict schema comes from E6-T01. A verified verdict means all acceptance predictions
survived and every changed hunk is executed, waived with a reason, or removed. One real
finding means refuted; `needs-evidence` is represented as a refutation finding and returns
the task to in-progress.

The deterministic fixture adapter proves both verdicts: one builder claim contains a
subtle real defect that an independent critic input exposes, and a corrected claim
survives. Replay interrogation uses the Replay MCP when a claim cites browser evidence;
stream evidence is independently replayed, never trusted from builder output.

## Deliverables

- `packages/loop/src/critic/agent.ts`, `prompt.ts`, `predictions.ts`, `coverage.ts`,
  `attacks.ts`, `verdict.ts`, and evidence-tool adapters.
- Frozen critic input/output schemas, finding fingerprints, citation validators, coverage
  classifications, and verdict dispatch validation.
- Defective/corrected sample claims with independent attack seeds and sabotage proof.
- `Makefile` target `verify-E6-T09` plus critic run/task golden logs.

## Acceptance criteria

- [ ] `make verify-E6-T09` exits 0 cold with zero skips and replays critic run, task, and
      evidence streams to byte-identical digests in two fresh processes.
- [ ] Against the defective fixture, the critic records its expected state before the
      probe, produces a reproducible real finding from an independent input, cites an
      exact stream offset/digest or Replay point/diff hunk, and appends one refuted event
      linked to the current claim.
- [ ] Against the corrected fixture, all predictions and required attacks pass, every
      changed hunk is classified executed/waived/gone, and one verified event appends;
      any uncovered unwaived hunk prevents verification.
- [ ] A critic run whose `builderRunId` equals the claim's builder, whose process/workspace
      is reused, or whose input contains the builder transcript is refused before verdict.
- [ ] Invalid/stale citations, findings without evidence, verdicts against an old claim,
      and a verdict missing any task-mandated attack are refused without moving task head.
- [ ] Browser claims are interrogated through the cited Replay recording for console,
      network, interaction, and DOM-offset facts; a builder-provided screenshot or text
      transcript alone cannot satisfy a browser prediction.
- [ ] The critic capability cannot mutate the task branch, main, or task specification;
      promoted artifacts are immutable evidence attachments and verdict events only.
- [ ] Browser evidence for this service task is declared `Replay: N/A (critic runtime;
      live verdict UI lands in E6-T12)`; mitigation is independent replay of the cited
      browser fixture through Replay MCP plus critic/task/evidence stream digests.

## Adversarial verification

1. Give the critic a builder-produced expected value, same seed, and prewritten finding.
   A verdict without an independently recorded prediction/input refutes independence.
2. Hide one changed branch event from the evidence manifest and one source hunk from the
   coverage map. Verification in either case refutes sufficiency auditing.
3. Forge Replay point links, event offsets, attachment hashes, and diff ranges. Any
   accepted unresolvable citation refutes verdict integrity.
4. Attempt branch writes through every critic tool and raw endpoint, then compare heads.
   Any movement refutes role isolation.
5. Disable the defective behavior in the attack harness rather than the implementation.
   The sensitivity run must detect that the critic no longer refutes the known-bad
   fixture; green refutes the apparatus.

## Verification log
