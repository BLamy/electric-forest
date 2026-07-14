---
id: E8-T07
epic: 8
title: "The forest builds the forest: electric-forest implements a production source-audit bundle on itself, earns verified, and merges with no Git"
priority: 807
status: pending
depends_on: [E8-T06]
estimate: L
capstone: true
---

## Goal

On the canonical production project established by E8-T06, the hosted loop implements
this task itself: a reusable `ef source bundle <org>/<repo> --output <file>` capability
that exports an authorization-filtered, point-in-time audit bundle for any stream-native
project, plus a project-page action that downloads the same bundle. The bundle contains
a canonical manifest and immutable dumps/hashes for source provenance, main, task/PR,
and evidence streams at explicit observed offsets; `ef source verify-bundle <file>`
replays it offline, verifies every hash/reference/digest, and exits nonzero at the first
corrupt entry. This is a production operability feature, not capstone ceremony.

E8-T07 starts `pending` in the hosted `.eforest` queue, is implemented by a builder in a
branch-stream workspace, challenged by a fresh critic, reaches `verified`, and merges to
`main` entirely through electric-forest. From the hosted task's first `in-progress` event
through merge and final audit there is no Git binary invocation, `.git` access, Git
protocol traffic, commit object, or Git-derived diff. The complete chain — task/PR logs,
branch/main digests, gates, changed-range coverage, bundle fixtures, Replay recordings,
evidence, verdict, and merge — is browsable on production and the newly shipped bundle
independently replays that very chain.

## Context

This is ROADMAP.md Epic 8's capstone, **the-forest-builds-the-forest**, made into a real
task with a user beyond the demo: operators need one portable artifact proving which
stream offsets/digests comprise a deployed source and its verification chain. The bundle
uses the same canonical JSON/digest/replay contracts as the platform and must be useful
for any hosted stream-native project. It is not allowed to recognize electric-forest,
E8-T07, or a capstone id in production code.

E8-T06 hands control to the hosted queue with this exact spec already present and E8-T06
verified. Existing E6 machinery starts E8-T07; nothing new is needed to begin the task.
The builder creates the bundle feature and evidence on a task branch, the critic attacks
both the feature and its self-host provenance, and the normal E5 PR merge advances main.
Any missing import, loop, evidence, merge, or UI primitive is a refutation of its owning
earlier task and must be repaired/re-verified before this capstone restarts from the top.

Bundle contract frozen here: `SourceAuditBundleV1` is an uncompressed POSIX ustar archive
with extension `.efaudit`, lexicographically sorted entry paths, uid/gid `0`, fixed modes,
mtime `0`, `manifest.json` in canonical JSON, and
`streams/<logical-name>.jsonl` payloads. The manifest names project identity,
source-cutover tuple, a capture-boundary vector of `(streamId, headOffset)` entries,
each logical entity's stream id/head offset/content SHA-256/state digest/reducer version,
and attachment references. Archive entry order and metadata are fixed; secrets and
authorization-invisible entities are absent. Verification never contacts Git or trusts a
digest stored inside the bundle without recomputing it.

## Deliverables

- `packages/cli/src/commands/source-bundle.ts` — authenticated consistent capture and
  deterministic `SourceAuditBundleV1` writer; `--include task:<id>` selects the task/PR/
  evidence closure, and unauthorized/private entities are filtered by server grants.
- `packages/cli/src/commands/source-verify-bundle.ts` — offline archive/schema/hash/
  offset/reducer/reference/composite-digest verification with typed failure path and
  corrupt entry/offset in stderr.
- Shared `@eforest/source-audit` module for bundle schema, canonical archive ordering,
  closure traversal, and composite digest; CLI and web server use this one implementation.
- Project-page `Download source audit` action with task selector, progress/error state,
  and DOM-exposed captured main offset/composite digest. Browser download bytes must be
  byte-identical to CLI output captured at the same boundary.
- Tests for deterministic output, concurrent appends during capture, auth filtering,
  missing/dangling evidence, corrupt/truncated/duplicate archive entries, unknown reducer
  versions, and offline verification with network/Git blocked.
- `Makefile` target `verify-E8-T07` for the feature on the task branch (goldens,
  concurrency, authorization, tamper sensitivity, browser download) and final
  `verify-E8-capstone` for the post-merge self-host chain. `verify-E8-T07` joins routine
  `verify-all`; the production-evidence target is explicit and never silently skipped or
  run as a routine offline gate.
- `tools/verify/capstone_e8.ts` and `verify-E8-capstone` — downloads production evidence
  and the E8-T07 audit bundle, verifies/replays the full lifecycle, checks Git-free traces,
  and compares verified task-branch, merged main, bundle, server, and DOM digests.
- Durable evidence attached to the production task/PR/project and mirrored in this task's
  `evidence/`: bundle + SHA-256, entity dumps, start/final digest ledger, builder/critic
  provenance, gate/attack transcripts, changed-range coverage classification, no-Git
  process/network trace, browser timeline, Replay URL, and sensitivity results.

## Acceptance criteria

- [ ] **Real feature behavior.** From a fresh Git-free workspace, CLI and browser export
      bundles for the production electric-forest project at the same explicit capture
      boundary; archive bytes and SHA-256 are identical, and `ef source verify-bundle`
      exits 0 offline with network blocked.
- [ ] **Deterministic, complete closure.** Repeating export at unchanged heads in separate
      processes yields byte-identical archives. Manifest entries resolve every selected
      E8-T07 task/PR/evidence reference, name exact stream heads/reducer versions, and
      recompute to one composite digest matching server and DOM.
- [ ] **Capture consistency under writes.** While unrelated and included streams append,
      every bundle entry is read at the manifest's frozen boundary; verify succeeds with
      no mixture of pre/post-boundary state. A missing historical offset/retention case
      fails with a typed error and emits no success bundle.
- [ ] **Authorization and secrecy.** An authorized operator receives the selected private
      closure; a reader without grants receives neither hidden stream ids nor bytes and a
      request for an unauthorized selected task is refused before archive output. Secret
      scanner reports zero token/session values, and its planted-secret self-test fails.
- [ ] **Tamper sensitivity.** Flip one byte, truncate one JSONL, duplicate/reorder an
      archive entry, alter an offset, change a reducer version, and break one attachment
      reference in separate copies. `verify-bundle` exits nonzero and names the affected
      entry/offset for every mutation; no mutation survives by trusting manifest hashes.
- [ ] **Normal hosted lifecycle.** Production streams show E8-T07 moving through the E6
      state machine under distinct builder and critic sessions. Only the critic sets
      `verified`; any refutation is followed by rework and new evidence before another
      verdict. Task/PR/evidence UI exposes every transition at resolving offsets.
- [ ] **Every gate earned on final bytes.** Final builder provenance cites the exact task-
      branch head/tree digest that passed root gates, feature tests, and
      `verify-E8-T07`; no source event occurs between the cited gate run and critic
      materialization of that head.
- [ ] **Critic sufficiency.** The critic maps every changed stream range/hunk to executed
      evidence, justified waiver, or deletion; runs every attack in this spec plus one new
      attack; independently verifies the bundle with network blocked; and attaches its
      prediction-before-verification record. An uncovered behavioral hunk cannot receive
      `verified`.
- [ ] **No Git anywhere in the hosted path.** From E8-T07's first `in-progress` event
      through the final `pr/merged` event and audit, process/filesystem/network traces
      report zero Git
      executable/library invocation, `.git` access, Git protocol traffic, and Git-derived
      commit/diff/worktree use. All agent/audit workspaces begin without `.git` and with
      the failing Git shim active; a planted Git-call sensitivity leg is detected.
- [ ] **Verified merge equality.** The PR merge event cites the critic-verified task-
      branch head; replayed main immediately after merge has a tree digest byte-equal to
      that branch. A Git-free `ef clone` of final main has the same digest, passes gates,
      and its shipped `ef source verify-bundle` verifies the capstone bundle.
- [ ] **Browser proof.** One Replay recording contains operator and witness contexts:
      witness sees live source edits, verdict, evidence, merge, and final main digest
      without reload; browser bundle download succeeds; final task is `verified`, PR is
      `merged`, source mode remains `stream-native`, and both contexts have zero console
      errors. Replay evidence is mandatory; no fallback can verify this final capstone.
- [ ] **Whole-chain replay.** `make verify-E8-capstone` in a fresh Git-free audit root
      downloads the immutable production bundle/evidence and exits 0 with zero skips;
      replaying task, PR, project, branch, main, evidence, and source-audit entries twice
      gives identical per-entity and composite digests matching server and witness DOM.
- [ ] **Project remains honest.** Hosted queue marks E8-T07 verified, source audit remains
      `stream-native`, importer probes remain refused, and project state becomes
      `complete` only if the stream-built queue proves no pending/in-progress/implemented
      task remains; no script writes project state directly.
- [ ] E8-T01–T06 verify targets and `tools/verify/self_check.sh` re-run green against
      final main, and all production audit/bundle/Replay references are cited in the
      Verification log.

## Adversarial verification

The claim under attack is literal: "electric-forest implemented a useful audit-bundle
feature on its own production source through its own hosted loop, a fresh critic earned
`verified`, main received exactly those bytes, the new bundle replays the proof, and Git
was nowhere in the path." Predict expected state/offsets before inspecting each layer.

1. **Feature, not ceremony.** Export another project with multiple tasks/PRs/evidence,
   not just electric-forest. Search production code for project/task/capstone ids and
   fixture shortcuts. A one-off exporter or hard-coded manifest refutes the real feature.
2. **Bundle differential.** Independently dump the same closure at the frozen heads and
   compare entry bytes, offsets, state digests, and composite. Then execute every named
   corruption. Any missed entity or mutation that verifies refutes completeness/integrity.
3. **Concurrent-boundary attack.** Append to included streams between manifest discovery
   and reads, compact an old offset, and append to unrelated streams at high rate. A mixed
   boundary, hang, or silent partial bundle refutes capture consistency.
4. **Authorization hunt.** Export under owner, read-only collaborator, unrelated user,
   expired token, and revoked-mid-download token. Hidden ids/bytes in archive, filename,
   size, error, or network trace are a secrecy finding.
5. **Role and coverage.** Resolve builder/critic identities and derive changed range from
   fork/head events yourself. Critic source writes, session reuse, or any behavioral hunk
   without execution/waiver/deletion refutes the verdict.
6. **Git hunt broader than the shim.** Inspect descendant processes, loaded modules,
   filesystem probes, environment, network, workspaces, and transcripts. Any Git/libgit/
   isomorphic-git use, `.git` read, or commit-derived diff after task start is direct
   refutation. Confirm the planted call is detected.
7. **Merge provenance.** Replay branch and main from fork; match critic's verified head,
   PR merge reference, post-merge main, Git-free clone, and bundle source digest exactly.
   An extra post-gate event or merge of another head refutes self-build integrity.
8. **Replay interrogation.** Through Replay MCP inspect both contexts, live edits, bundle
   download, critic verdict, evidence, merge, console/network/navigation, and final DOM
   digest. A partial recording, reload-based witness, or DOM/server mismatch refutes.
9. **Crash and cold audit.** In a disposable replay, kill exporter mid-entry and server
   during merge, then resume. No partial bundle may claim success; verdict/merge remain
   exactly once. Verify the unmodified production bundle twice in a fresh network- and
   Git-blocked root. Dependence on warm state is a refutation.

Refutation currency: exact stream/archive entry and offset, digest mismatch, unresolved
attachment, Replay point, process-trace Git hit, uncovered changed hunk, or role overlap.
"It looked like it built itself" is neither proof nor a finding.

## Verification log
