---
id: E14-T06
epic: 14
title: "Capstone: migrate a legacy repo and recover changeset-native source without diffs"
priority: 556
status: pending
depends_on: [E14-T04, E14-T05]
estimate: L
capstone: true
---

## Goal

From a cold start, a dedicated legacy Forest repository gains an append-only migration
boundary linking its exact old head/tree to complete immutable file versions. Two
clients then edit, branch, merge, review and recover the changeset-native repository
using only official-stream content objects and accepted manifests. Original logs and
verified evidence remain byte-identical, and new source remains readable after every
agent log and derived comparison/index cache is removed.

## Context

The runnable milestone is **the-addressed-changes**. It closes E14 after all focused
journeys pass, then runs exactly one integrated open-ended Replay QA exploration for
the epic. This is a disposable seeded rehearsal, not authorization to migrate a
production repository, rewrite the current project's verdict ledger, change Railway
services or retire legacy data. Production cutover requires its own authorized task.

The migration selects a frozen legacy branch head and independently materializes its
full files. Stage those full bytes and append the explicit boundary/baseline manifest;
do not convert or replace historical patch events. Reading an old offset continues to
mean its original legacy replay. Reading after the boundary follows changeset/full-
version semantics. A racing legacy writer must either be fenced before boundary
acceptance or make the pinned-head migration fail with a typed no-op; it cannot be
silently dropped. All old criteria and evidence remain assigned and intact.

Objects staged by failed/retried migration may be retained but do not move source
state. Every accepted retry resolves by durable identity and expected head. No garbage
collection, history pruning or weakening of old retention guards is part of this proof.

The no-diff rule classifies artifact roles, not source byte patterns: an ordinary
full source file (including a `.patch` fixture) remains permitted. New generated patch
operations/comparison bodies are forbidden outside redacted agent logs. Recorded
comparison scenes mask generated text and derived payloads before any QA timeline,
screenshot, console/network body, Playwright trace/snapshot artifact or attached recording persists them. Keep immutable
endpoint IDs, comparison-result digests and UI state so the critic can independently
recompute expected comparisons. Qualify masking with a canary before upload; unsupported
masking is an evidence blocker or the literal AGENTS.md fallback, never a silent waiver.

## Deliverables

- A resumable migration planner/executor in `packages/changesets` and an explicit CLI
  rehearsal command that selects a fixed legacy head, previews its manifest and
  publishes through authenticated dispatch with a dedicated capability.
- Frozen representative legacy logs plus complete object/baseline/new changeset dumps
  covering text, binary, modes, rename/delete, native forks and merge conflicts.
- A cold end-to-end harness and proposed `make verify-E14-T06` composing existing
  official-substrate, filesystem/workspace, review/evidence and E14 verify targets.
- `evidence/migration-manifest.json`, old-history hash catalog, all replay/tree digests,
  client convergence, crash/fencing/refusal results and no-persisted-diff storage audit.
- Focused managed-tunnel Replay QA journeys, one epic-closing exploration and their
  project/journey/test-run/bug/exploration/attached recording references.

## Acceptance criteria

- [ ] `make verify-E14-T06` exits 0 from a cold clone with scrubbed environment, fresh
      browser profiles and fresh official-server data. All finite E14-T01 compatibility
      catalog cases and E14 targets pass without skips; executed commands and artifact
      pins appear in `evidence/cold-capstone.json`.
- [ ] Migration at the frozen legacy head stages full objects, appends one explicit
      boundary/baseline and produces a tree byte-equal to an independent legacy replay
      and `ef tree-digest` materialization. Old events, logs, verdicts and evidence retain
      their exact pre-migration SHA-256 values in `evidence/legacy-preservation.json`.
- [ ] Old-offset reads before and after migration produce identical legacy digests.
      New-offset reads resolve complete versions without consulting agent logs or
      transient comparisons; two independent replays match the pinned baseline/new
      digests in `evidence/history-parity.json`.
- [ ] A legacy-writer race and crashes after object staging, before boundary append and
      after acceptance but before response yield either one accepted boundary or a
      typed log-neutral retry/conflict. No accepted source edit is lost, no duplicate
      migration appears and staged objects are not prematurely deleted. Evidence is
      in `evidence/migration-boundaries.json` with offsets and expected-head values.
- [ ] Two clients independently edit and follow the migrated repo, fork, exercise a
      three-way conflict, publish its complete resolution, review the resulting
      changeset and attach evidence to the tested head. Their canonical files and
      digests equal a fresh replay at every checkpoint in
      `evidence/integrated-convergence.json`.
- [ ] After deleting disposable indexes/caches and all agent logs, restarting and
      cloning to a fresh directory reproduces exact source bytes, history links and
      comparison endpoints. New branch/content/changeset/review/journal storage has
      zero textual diff/patch payloads; legacy records are explicitly counted without
      modification in `evidence/final-authority-audit.json`.
- [ ] Playwright performs migration-visible history, full file/version browse, live
      edits, branch/conflict/review/evidence paths, permission refusal and reconnect
      through real input events with zero console errors. DOM offsets/digests/version
      IDs equal independent replay. Focused Replay QA journeys run through the configured
      project tunnel; after they pass, one epic-closing exploration is cited with its
      outcome/bugs and attached recording IDs, or loud AGENTS.md fallback declares the
      precise unavailable capability and mitigation without claiming remote proof.
- [ ] A one-byte object mutation, altered legacy prefix, skipped manifest file and
      wrong-head evidence binding each make the capstone fail a distinct assertion;
      `evidence/capstone-sensitivity.json` records all four red results. The final
      claim names both stream and browser evidence layers and the immutable candidate.

## Adversarial verification

1. Choose a different pinned legacy prefix containing binary/Unicode/rename/conflict
   history and recompute its expected tree independently. A baseline that matches only
   the builder's seed or rewrites its old records refutes migration.
2. Race a real legacy edit with migration and kill every declared boundary. A lost
   accepted edit, duplicated boundary, new patch after cutover or untyped head overwrite
   refutes the format transition.
3. Strip all agent logs, comparison caches and derived indexes and restart from official
   streams alone. Any file/version/evidence identity that cannot be reconstructed
   refutes the claimed authoritative storage boundary.
4. Attack cross-repo object reads and wrong-head review/evidence links with real tokens.
   Any accepted out-of-scope access or stale verified-head substitution refutes the
   integrated capability boundary.
5. Compare old history/evidence hashes byte-for-byte, including failed verdicts and
   snapshots, before and after the demo. A regenerated equivalent history still
   refutes the required immutable preservation.
6. Interrogate the actual focused Replay QA runs and epic exploration against the diff,
   including refusal/removal/reconnect scenes and DOM identities. A new browser hunk
   with no journey coverage needs evidence; a local rerun cannot replace the cited run.
7. Perform all four sensitivity mutations in disposable scratch copies and rerun the
   narrow checks first. One green mutation refutes the capstone's measuring apparatus;
   broad green gates cannot overrule that failure.

## Verification log
