---
id: E8-T05
epic: 8
title: "Disposable self-host rehearsal: import electric-forest, retire Git, and run a refuted-then-verified task through the hosted loop"
priority: 805
status: pending
depends_on: [E8-T03, E8-T04]
estimate: L
capstone: false
---

## Goal

`make verify-E8-rehearsal` performs the complete self-host choreography against a fresh,
disposable platform instance: plan and import the selected electric-forest source,
cut it over to stream-native mode, start its hosted `.eforest` loop, execute a deterministic
canary task on a branch with the gitless E8-T04 runner, have a fresh critic refute one
real seeded defect, rework it, verify it, and merge it to main. The final main tree, task
state, project state, PR/verdict stream, evidence attachments, and browser DOM replay to
one pinned composite digest. The harness destroys the disposable service after dumping
all evidence, proving that no warm local checkout is part of the result.

## Context

This is the dress rehearsal before changing the live source of truth in E8-T06. It
composes rather than extends: importer (T01/T02), cutover fence (T03), gitless loop
workspaces (T04), and all earlier platform capabilities. The canary is a committed
fixture task under `tools/verify/fixtures/self-host-project/` whose deliberately seeded
behavior is non-production and whose expected first refutation is frozen; passing only
because the critic skipped the defect is a failure. No fixture or special-case event may
be added to the imported project at runtime outside the ordinary task dispatch door.

The rehearsal must be repeatable locally/CI without production credentials. It uses the
actual electric-forest source tree for build/gate scale and a task fixture that changes
real TypeScript/test files in that imported tree or a namespaced committed canary module.
The capstone remains the only task allowed to claim a real production task.

## Deliverables

- `tools/verify/self_host_rehearsal.ts` and shell wrapper — cold server/bootstrap,
  import/cutover, task creation, builder/critic/rework/merge orchestration, evidence dump,
  composite-digest calculation, teardown.
- A frozen canary task/event fixture with one deterministic defect, acceptance oracle,
  expected first critic finding class, and expected final tree/task/project digests.
- `packages/self-host-test` or equivalent committed canary module exercised by normal
  workspace gates; no production code path recognizes the rehearsal project/task id.
- Two-browser Playwright scenario: operator starts the loop, witness watches import mode,
  task/agent/PR/verdict/evidence transitions and final main digest without reload.
- `verify-E8-T05` (`verify-E8-rehearsal` is a descriptive alias) and evidence: all entity dumps, plan/receipt/cutover audit,
  builder/critic provenance, process/network no-Git trace, composite digest, step timeline,
  teardown proof, Playwright trace, and one Replay recording.

## Acceptance criteria

- [ ] `make verify-E8-T05` (which runs `verify-E8-rehearsal`) exits 0 via
      `tools/verify/cold_clone.sh` with fresh server
      data, `$EF_HOME`, browser profiles, and agent workspaces; transcript contains zero
      `SKIPPED:` lines.
- [ ] Source import and cutover satisfy the E8-T01–03 equations: plan expected digest,
      imported main replay digest, cloned tree digest, and cutover baseline digest are
      byte-identical, and `ef source audit` reports `stream-native`.
- [ ] The first builder claim is refuted by a fresh critic with the frozen real finding,
      cited to a changed stream range/evidence offset; project/task transitions follow
      `pending → in-progress → implemented → refuted → in-progress → implemented →
      verified` exactly once each where applicable.
- [ ] Rework removes the seeded defect, re-earns every root gate, produces new evidence,
      and a fresh critic verifies it; merge advances main exactly once and the final main
      tree digest equals the verified task-branch digest. The disposable project reaches
      `complete` only after that merge event, never at the earlier verdict offset.
- [ ] Runtime audit over importer-post-cutover, both agent runs, verification, evidence
      attachment, and merge reports zero Git invocation/access/network count. Git is
      permitted only during the pre-cutover source-plan phase, with its process span
      separately delimited in the timeline.
- [ ] Browser B witnesses each source/task/project/PR status transition live within the
      committed bound, without document reload and with zero console errors; its final
      DOM offsets/digests recompute to the server composite digest.
- [ ] Every evidence link displayed for both failed and successful claims resolves; each
      content attachment hash equals replayed content bytes, and the cited Replay URL is
      attached to the task entity.
- [ ] Teardown kills the service and deletes its disposable data/workspace roots; rerun
      with a different seed starts from no streams and reaches the same event shape and
      equality invariants, not necessarily the same opaque offsets.
- [ ] Sensitivity: remove the seeded defect, reuse the builder as critic, allow Git after
      cutover, and freeze the witness DOM offset in four separate runs. Each mutation
      fails its named oracle before a success verdict; transcripts are committed.
- [ ] `make verify-E8-T01`, `T02`, `T03`, and `T04` re-run green unmodified in the same
      cold clone, and all root gates pass.

## Adversarial verification

1. Inspect the canary and predict the first finding before reading critic output. If the
   critic verifies the known-bad first claim, or the harness injects a verdict without a
   real fresh critic session, refute the rehearsal.
2. Run with Git blocked immediately after cutover and trace all descendants. A single Git
   access during builder, critic, gate, diff, or merge refutes no-Git composition.
3. Kill server/runner at critic verdict and merge boundaries, resume, and demand exactly
   one status/merge event with provenance resolving to real offsets.
4. Recompute the composite from independently dumped streams and browser DOM captures.
   An echoed server value, stale DOM digest, or unresolved attachment refutes the two-
   instrument evidence claim.
5. Grep production code for canary task ids, expected finding strings, or fixture-only
   bypasses. Any special casing makes the rehearsal self-licking and refutes it.
6. Run twice with different names/seeds and no shared data dir. Hidden warm state,
   non-repeatable lifecycle shape, or teardown residue is a finding.
7. Interrogate the Replay recording for both browser contexts, every transition, console
   and network errors, and final digest. A screenshot-only or partial recording is
   insufficient evidence.

## Verification log
