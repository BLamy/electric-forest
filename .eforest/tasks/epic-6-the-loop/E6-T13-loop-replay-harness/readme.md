---
id: E6-T13
epic: 6
title: "Loop replay harness: task, branch, run, evidence, queue, and project streams fold to one composite digest"
priority: 613
status: pending
depends_on: [E6-T11]
estimate: M
capstone: false
---

## Goal

`ef loop dump` and `ef loop replay` capture a complete loop session manifest and replay
its task, branch, builder/critic run, evidence-reference, queue, project-state, and
loop-session streams to one canonical composite digest. Cross-links and source heads are
validated, replay order is deterministic, one-byte mutation goes red at a named member
and offset, and verified session fixtures become a permanent `verify-E6-loop-replay`
corpus.

## Context

The capstone spans more streams than a final task status can prove. This harness extends
E5-T11's negotiation-manifest pattern rather than forking its canonical encoding: sorted
`{streamId, reducerId, headOffset, stateDigest}` members plus a typed cross-link section
for lease -> runs -> claims -> findings/verdicts -> attachments -> project/queue
decisions. The root digest is SHA-256 over canonical JSON bytes.

The harness is stream-layer evidence only and can land in parallel with the UI. Dumps
contain referenced external Replay metadata but not the cloud recording bytes. A link
must still pass structural and ownership validation.

## Deliverables

- `packages/cli/src/loop/dump.ts`, `replay.ts`, `manifest.ts`, and `validate-links.ts`.
- Versioned `loop-session/v1` manifest and composite-digest encoding reusing E5-T11
  primitives.
- Frozen verify-first, refute/rework/verify, paused, and invalid-loop corpora with member
  dumps, SHA-256 siblings, manifests, and expected roots.
- Mutation sweep and independent plain-process recomputation script.
- `Makefile` target `verify-E6-loop-replay` and task target `verify-E6-T13`.

## Acceptance criteria

- [ ] `make verify-E6-T13` exits 0 cold with zero skips, runs
      `verify-E6-loop-replay`, and reproduces every fixture's committed member hashes,
      state digests, cross-link digest, and root digest without rewriting expected files.
- [ ] A separate script using only canonical JSON plus SHA-256 recomputes each root from
      the manifest/member digests and byte-equals `ef loop replay` output.
- [ ] The refute/rework fixture proves exact links from queue proof to lease, builder run
      to first claim/evidence, fresh critic run to cited finding/refutation, rework run to
      second claim, second fresh critic to verified verdict, and final queue/project
      heads; one missing/dangling/wrong-owner link fails with its path.
- [ ] Member order, fetch order, host path, locale, timezone, process id, and wall clock
      do not affect the composite digest; 100 shuffled replays in fresh processes print
      one unique root.
- [ ] Flipping one byte in every member dump, manifest member head/digest, or cross-link
      field makes replay nonzero and identifies the affected stream/offset or manifest
      path; no mutated copy remains green.
- [ ] Truncated, duplicated, out-of-order, stale-head, wrong-reducer, missing-evidence,
      builder-as-critic, and verdict-against-old-claim fixtures are all refused before a
      root is printed.
- [ ] Deleting all derived queue/folder/project projections does not change replay output;
      rebuilding them from member logs after verification yields the recorded digests.
- [ ] Browser evidence is declared `Replay: N/A (CLI/session replay harness)`; mitigation
      is independent root recomputation, the frozen multi-stream corpus, mutation sweep,
      and exact projection rebuild proof.

## Adversarial verification

1. Recompute the root manually from member dumps without importing harness code. Any
   difference refutes the encoding or exposes hidden input.
2. Mutate bytes at critic-chosen positions in every member and cross-link, including
   opaque offsets and attachment hashes. One green mutation refutes sensitivity.
3. Swap builder/critic run ids between attempts, point verified at the first claim, and
   attach evidence owned by another task. Any valid root refutes cross-link validation.
4. Shuffle member fetch completion and replay on machines with different locale/timezone
   and absolute paths. Digest drift refutes determinism.
5. Patch the expected root to the runtime result in a scratch copy. The verify target
   must reject fixture regeneration/dirty expected files; green refutes golden honesty.

## Verification log
