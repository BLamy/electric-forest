---
id: E14-T04
epic: 14
title: "Preserve filesystem, CLI and merge behavior over complete file versions"
priority: 554
status: pending
depends_on: [E14-T03]
estimate: L
capstone: false
---

## Goal

StreamFS, workspace sync and native-fork merge paths consume complete file versions
and publish changeset references after the E14 boundary while preserving the verified
behavior catalog from E14-T01. Existing legacy logs replay byte-for-byte. New writes,
sync journals, merge/conflict records and branch state persist no textual patches;
deterministic comparisons/merge calculations run in memory over immutable full bytes.
The browser tree/file/history surfaces expose the resulting version, offset and digest.

## Context

E1/E3/E4/E5 already verify file reads/writes, stale bases, Unicode/binary handling,
snapshots, branch forks, fast-forward and three-way merge/conflicts, CLI adoption/clone/
checkout/status and duplex synchronization. This is an adapter migration, not permission
to delete those capabilities or weaken their fixtures. Bound the work by the committed
compatibility catalog; any discovered missing behavior is added to that finite catalog
before claiming completion, with the existing evidence left unchanged.

An old `fs.file.patch` event is interpreted only by the legacy replay path. After the
explicit migration boundary every accepted edit stores/reuses a complete content
object and publishes version references. Merge may derive transient text operations to
calculate a result, but accepted merge/conflict state stores full endpoint/result
references and conflict metadata, never hunks. Rename preserves file identity; path
movement does not duplicate unchanged content. Full local pending snapshots or object
references replace durable patch bodies in the new `.ef/` journal version.

Native official forks retain their application-offset ancestry and opaque transport
cursor distinction. Snapshot/retention adapters preserve object reachability; historic
forks still fail explicitly where the official adapter lacks the required mapping.
No capability is claimed merely by creating a copied tree or a second transport.

The no-diff rule classifies artifact roles, not source byte patterns: an ordinary
full source file (including a `.patch` fixture) remains permitted. New generated patch
operations/comparison bodies are forbidden outside redacted agent logs. Recorded
comparison scenes mask generated text and derived payloads before any QA timeline,
screenshot, console/network body, Playwright trace/snapshot artifact or attached recording persists them. Keep immutable
endpoint IDs, comparison-result digests and UI state so the critic can independently
recompute expected comparisons. Qualify masking with a canary before upload; unsupported
masking is an evidence blocker or the literal AGENTS.md fallback, never a silent waiver.

## Deliverables

- Version-aware adapters in `packages/streamfs/src/` for replay, tree materialization,
  snapshots, native forks and conflict/merge handling over changeset/version references.
- `packages/cli/src/sync/` and clone/adopt/checkout/status/merge adapters with a
  versioned `.ef/` checkpoint/journal upgrade and idempotent full-version publication.
- On-demand comparison helpers that return transient text ranges or full binary/mode
  metadata without writing a diff artifact to source, review, cache or journal state.
- Updated real tree/file/history integration in `apps/web` or its shared UI packages,
  using E13 design choices and exposing atomic full-version provenance in the DOM.
- Proposed `make verify-E14-T04`, compatibility case results, frozen legacy replay
  checks, two-client sync/crash/merge evidence and focused Replay QA journeys.

## Acceptance criteria

- [ ] `make verify-E14-T04` exits 0 cold with zero skipped compatibility cases; all
      preserved targets named in E14-T01's catalog pass. `evidence/compatibility.json`
      maps each operation to its command, source format, output and independently
      replayed tree digest; old expected fixture bytes are unchanged.
- [ ] New-format create/read/update/delete/rename/directory/mode, Unicode/CRLF/empty/
      binary and stale-write cases produce byte-exact independently materialized trees.
      Two clients and CLI clone/status/watch agree on canonical tree bytes/digests at
      every accepted checkpoint in `evidence/workspace-parity.json`.
- [ ] Native fork isolation, supported historic-offset behavior, fast-forward and
      three-way merges retain the catalog's outcomes. Edit/edit, delete/edit,
      rename/rename, add/add and binary conflicts preserve exact base/source/target
      version references; resolving a conflict publishes complete resulting bytes.
      `evidence/fork-merge-matrix.json` cites branch offsets and replay digests.
- [ ] A CLI fixture runs adopt, clone, dirty checkout refusal, clean branch switch,
      status and duplex watch. Lost append responses and kills around local journal,
      accepted dispatch and checkpoint update recover without duplicate publication,
      lost bytes or echo. Results are in `evidence/workspace-recovery.json`.
- [ ] Snapshots and allowed retention restore the same tree with all referenced
      objects resolvable. Unsupported compaction/fork boundaries retain their explicit
      refusals; referenced objects are never deleted to make cleanup pass.
      `evidence/snapshot-reachability.json` records old and new format checks.
- [ ] A durable-state audit of new branch/content/changeset/merge/review streams,
      derived storage and `.ef/` journals finds zero textual patch/diff payloads.
      Redacted agent tool logs are the only new permitted copies and are removable
      without affecting replay. Legacy patch records remain byte-identical; all counts
      and exclusions are explicit in `evidence/source-state-audit.json`.
- [ ] Playwright drives live full-version edits, rename/delete, branch switch,
      disconnect/reconnect and conflict presentation through real input events with
      zero console errors. Every sampled `{ fileId, versionId, contentSha256, offset,
      treeDigest }` tuple matches independent replay. Final evidence cites focused
      managed-tunnel Replay QA project/journey/test-run/bug/recording IDs, or the exact
      loud fallback required by AGENTS.md; no epic exploration is run yet.
- [ ] Sabotaging one version reference, the sync-origin guard and conflict-result hash
      separately turns named assertions red. `evidence/adapter-sensitivity.json`
      records the first divergent offset/digest for each mutation.

## Adversarial verification

1. Use your own bounded edit sequence with Unicode, binary, mode changes and a
   rename/delete/recreate of the same path. Compare full endpoint bytes and file IDs;
   a hash-only or path-only identity shortcut refutes parity.
2. Drop accepted dispatch responses and SIGKILL around journal/append/checkpoint
   boundaries. Duplicates, lost bytes, an echo loop or a journal containing persisted
   patches after migration refutes workspace recovery.
3. Independently fork concurrent edits for every listed conflict class. Compare the
   adapter with the frozen legacy outcome and canonical full-tree oracle. A changed
   supported merge result or a missing conflict refutes behavior preservation.
4. Delete all comparison caches and agent logs, reconnect a cold client and restore
   a snapshot. Missing files or dependence on a saved diff refutes full-version authority.
5. Exercise unsupported historic fork/compaction cases deliberately. Silently forking
   head instead, dropping inherited history or deleting referenced objects refutes the
   official-substrate/reachability boundary.
6. Search actual newly emitted payloads and local journal bytes for nested or encoded
   patch bodies; source-code references to the transient comparison algorithm are not
   findings. One persisted source patch after the boundary refutes the model.
7. Inspect the cited Replay QA run for every changed browser scene and its DOM
   identities. Sabotage the file-version selector and sync guard separately; permanent
   checks must identify their divergence rather than remain green.

## Verification log
