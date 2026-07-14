---
id: E7-T09
epic: 7
title: "Capstone: watch-the-ai-build"
priority: 709
status: pending
depends_on: [E7-T08]
estimate: L
capstone: true
---

## Goal

From a pristine clone and fresh platform state, a hosted AI session edits a real sample
repo through the Epic 6 runner while two independent authenticated browsers watch the
same branch. Both feeds and open file views show every fine-grained edit, tool call, and
task transition live; each event appears in both browsers within one second of each
other. Each browser then scrubs to named past activity offsets and shows the exact whole
repo state at those offsets—tree, file, issue/PR/task/project status, and session
activity—with composite digests byte-equal to independent `ef replay`. Returning live
converges both viewers to the branch head. The complete run is one interrogatable Replay
recording and one promoted stream corpus.

## Context

This is ROADMAP.md's Epic 7 capstone **watch-the-ai-build**, composed from E7-T01–T08.
It introduces no new protocol, reducer, UI, timing rule, or alternate harness. Any gap
is rework against the owning task. `depends_on: [E7-T08]` is the transitive frontier:
T08 depends on the feed, file view, and scrubber and those pull in the recorder,
activity timeline, projector, and session contract.

The final evidence run must use fresh server data, a real hosted agent adapter, two
fresh browser profiles, and Replay Chromium. Because watching and scrubbing are the
headline product, `Replay: N/A` is not acceptable for verification of this capstone;
failed Replay preflight blocks the run rather than weakening it.

## Deliverables

- `packages/webapp/test/capstone-e7.spec.ts` composing the E7-T08 harness into the named
  demo with two isolated authenticated contexts and the full live/scrub/return flow.
- `tools/verify/capstone_e7.sh` and `make verify-E7-capstone`, running from cold-clone
  state, replaying all source/activity dumps, comparing every claimed digest, enforcing
  latency/event-set/console/network assertions, and re-running `verify-E7-fireflies`.
- A promoted `watch-the-ai-build` corpus containing the activity/session/task/issue/PR/
  tree/content dumps, expected high-watermark vectors, per-prefix and final composite
  digests, and exact recorder input manifest.
- `evidence/e7-t09-timeline.json`, `e7-t09-digests.txt`, source dumps with SHA-256
  siblings, DOM captures, cold-start transcript, no-mutation scrub audit, and sabotage
  transcript.
- One uploaded Replay recording named `e7-t09-final`, URL and point links for live
  editing, historical scrub, and return-to-live cited in the Verification log.

## Acceptance criteria

- [ ] `make verify-E7-capstone` exits 0 via `tools/verify/cold_clone.sh` with scrubbed
      environment, fresh server data and browser profiles, zero skips, successful Replay
      preflight/upload, and every workspace gate green.
- [ ] The real hosted agent performs at least 20 incremental text edits across two files,
      one rename or delete, two tool calls including one error path, and at least two task
      transitions; source dumps prove every mutation used dispatch and carries contiguous
      session provenance.
- [ ] Both browsers observe every expected activity/content source offset exactly once,
      without reload; every corresponding observation differs between browsers by at
      most 1000 ms, as independently recomputed from the host-stamped timeline.
- [ ] At live quiescence, both browsers' activity/content offsets and digests equal each
      other, server heads, and independent replay of the fresh dumps; final tree bytes
      are byte-identical to the agent's intended result.
- [ ] Each browser scrubs through at least five named cursors spanning before, during,
      and after the edit session. At every cursor its DOM composite digest equals offline
      replay, and tree/file/issue/PR/task/project/session values match the promoted prefix
      golden exactly.
- [ ] While pinned, new live events do not advance either historical UI and all mutation
      controls remain disabled; before/after dumps are byte-identical around scrub-only
      interactions. Returning live converges both browsers to the new head without reload.
- [ ] The promoted corpus replays twice to byte-identical per-prefix and final digests;
      flipping one byte in each stream class turns verification red naming the source and
      first divergent offset.
- [ ] The single cited Replay recording contains both contexts and every headline scene,
      has zero console errors and no watched-surface navigation/reload, and its DOM
      offset/digest tuples match committed evidence at cited point links.
- [ ] `make verify-E7-fireflies` and every E7-T01–T08 verify target re-run unmodified and
      green in the same clone; `verify-all` and `tools/verify/self_check.sh` remain green.

## Adversarial verification

1. **Cold-start audit.** Run only from a pristine clone with empty server/profile dirs
   and scrubbed credentials except required test auth/Replay access. Any preseeded repo,
   warm agent output, fixed dev server, or generated-at-test golden refutes the demo.
2. **Real-agent provenance.** Hold the agent callbacks against source logs. Every claimed
   edit must resolve to a real source offset with session origin, and every agent-origin
   mutation must appear in both viewers. A toy script bypassing the hosted runner, direct
   write, missing event, or decorative row refutes.
3. **Two-viewer independence and latency.** Verify separate profiles/identities, recompute
   latency from host timestamps, and disconnect one viewer mid-run. Shared state,
   cross-context clock comparison, a >1000 ms observation delta, reload, or unequal event
   sets refutes.
4. **Predict, then scrub.** Before opening each sampled cursor, predict exact tree paths,
   file bytes, task/PR/issue status, and session tool state from raw logs. One observed
   mismatch or mixed-era panel refutes time travel.
5. **No mutation in history.** Keep the agent writing while pinned, attempt all disabled
   controls, then compare stream dumps. Any pinned advance, accepted dispatch, or silent
   fallback to head refutes historical isolation.
6. **Two-instrument digest proof.** Derive composites from raw source dumps and compare
   to each browser independently. Browsers agreeing with each other but not replay still
   refute; a DOM digest copied from the server without matching rendered state is caught
   by the prefix golden comparisons.
7. **Sensitivity and coverage.** Run the E7-T08 sabotages plus corrupt one record in each
   source-stream class. Every changed implementation hunk must be executed in the final
   recording or classified with a justified waiver; an unexercised behavior needs new
   evidence or deletion.
8. **Replay interrogation.** Use Replay MCP to inspect both contexts, console, network,
   source execution, and DOM at live-edit, error, scrub, and return points. A missing
   scene, console exception, hidden reload/state refetch, or point inconsistent with the
   committed timeline refutes.

## Verification log
