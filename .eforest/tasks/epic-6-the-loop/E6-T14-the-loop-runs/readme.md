---
id: E6-T14
epic: 6
title: "Capstone: the-loop-runs — builder claim, real critic refutation, rework, verification, all streaming live"
priority: 614
status: pending
depends_on: [E6-T12, E6-T13]
estimate: L
capstone: true
---

## Goal

The ROADMAP Epic 6 capstone runs end-to-end from a cold start as
`make verify-E6-capstone`: on a newly hosted sample project, an authorized browser starts
the loop; a builder process takes the queued task onto a branch, implements it, earns the
gates, and records evidence; a fresh critic process predicts and exposes one real boundary
defect with its own input, refuting the first claim; the builder reworks the same task;
a second fresh critic fails to refute and appends `verified`. A witness browser sees every
status/run/finding/evidence update live on the project page, every link resolves, and the
complete session replays through E6-T13 to a composite digest equal to the DOM-derived
final state.

## Context

This task is exactly ROADMAP.md's **the-loop-runs** paragraph made executable. It composes
E6-T01 through T13 and adds no new loop behavior. The Epic 6 task itself is the sole and
final capstone of this epic.

The hosted sample contains exactly one task and marks it as that sample project's sole
capstone, so the accepted verified verdict also drives the project to `complete` through
E6-T03/E6-T11 instead of leaving a staged pending marker behind. The sample task is
frozen and falsifiable: implement `clampToRange(value, min, max)` with
the stated contract that `min > max` throws `RangeError`. The first builder fixture adds
correct in-range/below/above behavior but omits inverted-bound validation; its own gates
are honestly green because its tests omit that case. The critic records the prediction
"inverted bounds throw", calls the exported function with independently chosen values,
observes a returned value, and cites the failing test/run offset. Rework adds validation
and a regression test; the second critic uses different inverted bounds and the full
attack list. A pre-scripted `task/refuted`, a critic using the builder's seed, or a
finding not produced by executed behavior fails the capstone.

## Deliverables

- `examples/loop-capstone/` hosted-project seed with `.eforest` task, source, gates, and
  deterministic process-backed builder/critic adapters that use the production E6-T07
  protocol in separate processes/workspaces.
- `packages/webapp/test/capstone-e6.spec.ts` with actor and witness browser contexts,
  exact transition/timeline assertions, DOM offset/digest captures, link resolution,
  navigation/console assertions, and cold profile setup.
- `tools/verify/capstone_e6.sh` provisioning fresh streams/data dir/project, running the
  demo, dumping/replaying E6-T13 session evidence, and byte-comparing DOM/server roots.
- `Makefile` target `verify-E6-capstone`, joined to `verify-all`, rerunning all E6 verify
  targets and root gates without weakening or skips.
- One uploaded Replay recording `e6-t14-final` containing actor and witness contexts.
- Committed evidence under this task: full member JSONL dumps and hashes, loop manifest,
  composite/DOM digests, step timeline, critic prediction/probe/finding transcript,
  branch diff/gate transcripts, link audit, cold-start audit, and sensitivity transcript;
  the session is promoted into the E6-T13 corpus.

## Acceptance criteria

- [ ] `make verify-E6-capstone` exits 0 only through `tools/verify/cold_clone.sh` with
      scrubbed env, fresh server data dir, ephemeral port, new hosted project/streams,
      fresh agent workspaces/processes, two fresh browser profiles, zero `SKIPPED:`, and
      all workspace gates green; exact creation evidence is committed.
- [ ] The stream event order is exactly task start -> first builder branch/run/gates/
      evidence/claim -> fresh critic prediction/probe/real finding/refuted -> rework
      builder run/gates/evidence/second claim -> second fresh critic predictions/attacks/
      verified -> project complete, with distinct agent process/workspace/run ids and one
      task branch attempt per claim.
- [ ] The first claim's implementation passes its declared gates yet behaviorally returns
      instead of throwing for the critic's independently chosen `min > max` input; the
      finding cites the executed probe and source/diff/stream point. The second branch
      state throws `RangeError` for a different inverted-bound input and contains the
      promoted regression test. No fixture or script directly dispatches refuted.
- [ ] Browser B, held open before launch, observes every task status
      `pending -> in-progress -> implemented -> refuted -> in-progress -> implemented ->
      verified`, all four agent runs, both claims, the first finding, and all evidence
      additions within the committed liveness bound, with zero reloads/document
      navigations and zero console errors.
- [ ] Every builder/critic log, branch diff, gate transcript, stream dump/digest, finding
      citation, and Replay reference rendered in B resolves successfully; displayed
      SHA-256 values byte-equal hashes of replayed/fetched bytes and no secret canary is
      present in DOM/network/recording.
- [ ] At final quiescence, B's exposed task, queue, run, evidence, and project offsets /
      digests recompute through the E6-T13 manifest to a root byte-equal to
      `ef loop replay`; every member head is current and the sample project truthfully
      reports `complete` because its one task is its unique verified capstone.
- [ ] The promoted capstone session passes `make verify-E6-loop-replay` unmodified, and a
      repo-wide no-database audit reports zero database dependencies/clients/side tables.
- [ ] The cited `e6-t14-final` Replay recording contains both browser contexts and the
      whole launch-to-verified timeline; point inspection confirms the first finding was
      visible before rework, each DOM offset advanced from behind to the causative head,
      and no navigation/console exception was hidden.
- [ ] Sensitivity legs in scratch worktrees each go red at the named assertion: suppress
      the inverted-bounds defect, let builder self-verify, reuse the builder process as
      critic, omit one intermediate UI status, break one evidence hash, freeze one DOM
      digest, or pre-seed any server/profile/agent workspace. Any green sabotage fails.

## Adversarial verification

1. **Cold start or refuted.** Run only from a critic-created clone with a new HOME, data
   dir, ports, browser profiles, and agent workspace roots; inspect before/after. Any
   pre-existing project/task/token/golden/runtime state refutes the demo.
2. **Prove the finding is real.** Before reading the critic output, predict that first
   implementation returns for an independently selected inverted range. Invoke the
   exported function outside both agents, inspect the claimed branch diff, and reproduce
   the observed return. A prewritten verdict, same builder test seed, or nonreproducible
   finding refutes the required real refutation.
3. **Prove fresh adversaries.** Compare process/workspace/run identities and input
   manifests for builder, first critic, rework builder, and second critic; plant a secret
   in each predecessor. Reuse or leakage into the next agent refutes role separation.
4. **Attack the witness.** In the Replay recording and Playwright trace, prove B was
   behind before each event then advanced via the live tail, with no reload, direct DOM
   injection, polling replacement, or skipped intermediate status. One staged update
   refutes live observability.
5. **Rebuild the proof.** Fetch every member dump/link independently, verify hashes and
   cross-links, replay through E6-T13, and manually recompute the composite from B's DOM
   captures. Missing/unresolvable evidence or one unequal byte refutes completion.
6. **Sabotage the apparatus.** Repeat every committed sensitivity mutation plus one new
   critic-chosen mutation. If the named assertion does not fail before the expected-fail
   wrapper succeeds, the capstone's measurement system is refuted.

## Verification log
