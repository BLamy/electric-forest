---
id: E8-T03
epic: 8
title: "Source cutover and Git retirement: the imported main stream becomes canonical and the one-time bridge is permanently fenced"
priority: 803
status: pending
depends_on: [E8-T02]
estimate: M
capstone: false
---

## Goal

An imported project can be cut over exactly once from `sourceMode: "importing"` to
`sourceMode: "stream-native"` by dispatching `project.source-cutover { v: 1,
planDigest, importCompletedOffset, mainHead, treeDigest }`. The server validator accepts
the event only when it resolves a matching completed import and independently replays
the named main head to the named digest. Once accepted, every Git-import writer action,
second cutover, or attempt to change the imported baseline is refused pre-append and
log-neutral. `ef source audit` proves the canonical source tuple, the completion/cutover
provenance chain, and absence of post-cutover import events. The web project header shows
`Stream-native` plus the canonical main offset/digest so the retirement is visible.

## Context

The roadmap says "git → stream importer, then the bridge retires." Import parity alone
does not retire anything; this task makes retirement an enforced stream fact. The Git
repository remains an input artifact for provenance, but after cutover neither polling a
remote nor re-running import may mutate the hosted project. All future changes use normal
branch-stream dispatch and merge events. This is a one-way transition. Recovery from a
bad prepared import happens before cutover by abandoning the destination and importing a
new project; there is no cutover rollback that would create two sources of truth.

The state is reduced from the existing project stream, not a database flag. The cutover
event and validator extend the project reducer established by E2/E6. The browser work is
mandatory under AGENTS.md: the mode, offset, and digest are DOM-exposed and live-update
when the cutover event lands.

## Deliverables

- Project event/reducer additions for `project.source-cutover` and reduced
  `source: { mode, planDigest, importCompletedOffset, mainHead, treeDigest,
  cutoverOffset }` with no wall-clock-derived state.
- Dispatch validator that resolves the prepared/completed import chain, recomputes main
  state at the cited head, and freezes every tuple field; exact refusal reasons are
  documented and tested.
- Import-writer fence in the existing dispatch validation stage: any import provenance
  or plan action targeting a stream-native project is `validator-rejected` and changes
  no head/digest.
- `ef source cutover --receipt <path>` and `ef source audit <org>/<repo> --json`; audit
  exits nonzero on a broken chain, digest mismatch, post-cutover import event, or current
  main ancestry that does not descend from the imported baseline.
- Web project-header badge/details with `data-source-mode`, `data-main-offset`, and
  `data-tree-digest`; live subscription uses the project stream.
- Unit/integration/Playwright tests, `verify-E8-T03`, committed project/main dumps,
  audit report, DOM capture, refusal transcript, and Replay recording.

## Acceptance criteria

- [ ] `make verify-E8-T03` exits 0 from a cold clone and produces a committed audit whose
      `status` is exactly `stream-native`, whose provenance offsets resolve to the golden
      project dump, and whose main digest recomputes from the golden main dump.
- [ ] Valid cutover appends exactly one event. Replaying the project log twice yields one
      canonical state digest and the reduced source tuple byte-equals the receipt and
      independently replayed main state.
- [ ] Cutover before import completion, with a wrong plan digest, wrong completion
      offset, stale/wrong main head, wrong tree digest, or a completion from another
      project is refused with an exact reason; before/after project and main head/digest
      pairs are identical for every refusal.
- [ ] After cutover, re-running `ef import-git --execute`, resuming its receipt, appending
      a second `import.completed`, and dispatching a second cutover are each refused
      pre-append. Stream enumeration and every destination head/digest remain unchanged.
- [ ] Normal stream-native file dispatch on a new branch, branch merge to main, and main
      tree-digest advancement remain accepted after cutover; `ef source audit` proves the
      new main descends from the frozen baseline without requiring Git.
- [ ] Playwright loads the project before cutover, observes the badge switch live without
      reload, asserts zero console errors, and asserts DOM offset/digest fields equal the
      server audit. Replay recording `e8-t03-final` is cited; `Replay: N/A` follows the
      loud fallback rule if infrastructure is unavailable.
- [ ] A repo-wide `git-retirement` static/runtime audit proves no production server,
      watcher, agent runner, or web process invokes `git` or reads `.git`; the only
      allowed Git adapter remains the explicitly user-invoked pre-cutover importer.
- [ ] Sensitivity: remove the post-cutover fence and alter the DOM digest source to a
      stale constant in scratch worktrees. `verify-E8-T03` must fail on the unauthorized
      append and DOM/server equality checks respectively; transcripts are committed.
- [ ] Root gates plus `verify-E8-T02`, project reducer, branch merge, and web live-update
      targets re-run green unchanged.

## Adversarial verification

1. Try every cutover tuple with one field borrowed from another valid import. Acceptance
   of a mixed provenance chain refutes the validator.
2. Race cutover against a final import action and race two cutovers. Reduced state must
   have one cutover at a real offset; a post-cutover importer append or two accepted
   events refutes permanence.
3. After cutover, delete Git from `PATH`, make `.git` unreadable, and perform a normal
   branch edit and merge. Any Git lookup, degraded behavior, or digest dependence on the
   old checkout refutes stream-native source.
4. Manually append a forged post-cutover import event to a copy of the golden dump and
   run `ef source audit`. It must name the exact offending offset. A green audit refutes
   the retirement instrument.
5. Interrogate the Replay recording around cutover: badge changes without navigation,
   DOM project offset advances through the cutover event, and digest equals server audit.
   Missing points or console errors refute browser sufficiency.
6. Sabotage the validator to trust receipt fields instead of replay, corrupt one main
   event, and re-run. The verifier must go red; otherwise the provenance equation is
   self-referential.

## Verification log
