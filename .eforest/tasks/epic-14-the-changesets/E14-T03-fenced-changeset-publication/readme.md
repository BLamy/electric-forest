---
id: E14-T03
epic: 14
title: "Publish one fenced changeset manifest after staging complete content objects"
priority: 553
status: pending
depends_on: [E14-T02]
estimate: L
capstone: false
---

## Goal

The authenticated dispatch service accepts `ChangesetV1` publication only after all
referenced complete objects and parents validate, then appends one authoritative branch
manifest event bound to the expected parent/head, writer capability and idempotency
key. Two observers see either the preceding tree or the entire accepted changeset;
they never see a subset of its files. The existing web history exposes accepted
changeset identity, parent, changed paths and resulting offset/tree digest.

## Context

E14-T02 supplies immutable objects; it does not provide a cross-stream transaction.
Stage and verify objects first, then make them source history through one accepted
branch event. Object uploads can be orphaned by a rejected publication, but they do not
move the branch or become visible source state. Preserve these objects for safe retry;
do not implement automatic garbage collection. Cached tree/history indexes are derived
and can be lost without losing publication decisions.

Use official stream ordering plus the existing writer fencing and authenticated
mutation door. Concurrent publication cannot rely on an in-memory lock or a second
database: a rejected race must replay/reconcile the durable branch before retrying.
An idempotency key binds the canonical request digest; reusing it for different bytes
is a refusal. A response lost after acceptance resolves to the original manifest,
offset and digest rather than publishing twice.

New branches can exercise publication before E14-T04 adapts all existing writers.
Legacy branches remain readable and use their frozen format until an explicit boundary.
The minimal history integration makes the landed capability visible immediately;
E14-T05 supplies the full changeset-first review experience. New state contains complete
version references, never stored textual diff/patch bodies.

The no-diff rule classifies artifact roles, not source byte patterns: an ordinary
full source file (including a `.patch` fixture) remains permitted. New generated patch
operations/comparison bodies are forbidden outside redacted agent logs. Recorded
comparison scenes mask generated text and derived payloads before any QA timeline,
screenshot, console/network body, Playwright trace/snapshot artifact or attached recording persists them. Keep immutable
endpoint IDs, comparison-result digests and UI state so the critic can independently
recompute expected comparisons. Qualify masking with a canary before upload; unsupported
masking is an evidence blocker or the literal AGENTS.md fallback, never a silent waiver.

## Deliverables

- `packages/changesets/src/publish.ts` and branch changeset reducer/validators.
- Product registration in `packages/platform/src/changesets/` for authorized object
  access and expected-parent changeset publication, using existing refusal taxonomy.
- A client API accepting staged references, expected parent and request identity;
  durable retry reconciliation and derived history/index rebuilding.
- Minimal changeset rows/details in the existing web event/history route with atomic
  `{ stream, offset, treeDigest, changesetId }` DOM identity.
- Proposed `make verify-E14-T03`, two-client race/crash fixtures, named Replay QA
  journey definitions, canonical stream/object dumps and no-stored-diff audit evidence.

## Acceptance criteria

- [ ] `make verify-E14-T03` exits 0 cold with zero skips. Independent replay of staged
      objects plus accepted branch events produces the pinned complete tree digest
      twice; `evidence/publication-digests.json` binds input, manifest, parent and head.
- [ ] A changeset changing two files, deleting another and changing one mode becomes
      visible to two independently connected observers at one branch offset. Every
      sampled tree is exactly the pre-publication or post-publication tree; no partial
      state appears in `evidence/observer-prefixes.json`.
- [ ] Missing/unsealed/wrong-hash/cross-scope object references, malformed parents and
      stale/unauthorized/expired writers are refused before branch append. All branch
      heads/dumps remain byte-identical, with typed refusals in
      `evidence/publication-refusals.json`; orphaned staged objects do not affect trees.
- [ ] Two writers racing the same expected parent cannot both publish successors as
      if it were current. One accepted winner and a typed stale-parent loser are
      recorded in `evidence/parent-race.json`; a deliberate later retry references the
      replayed current head and never silently overwrites the winning changeset.
- [ ] Crashes after object acceptance, before manifest append and after append but
      before response reconcile to one accepted logical publication. Same-key/same-
      digest retries return its original identity; same-key/different-digest retries
      fail. `evidence/publication-recovery.json` includes event counts, offsets and
      object retention for every boundary without premature garbage collection.
- [ ] Deleting disposable indexes and restarting reconstructs the same branch head,
      accepted idempotency result and tree digest from streams; no warm process lock,
      database or saved textual diff is required. State/storage audit results are in
      `evidence/publication-authority.json`.
- [ ] Playwright exercises history/detail, a stale publication refusal and reconnect
      with zero console errors; DOM changeset/offset/digest tuples equal independent
      replay. The claim cites configured Replay QA project, named focused journey,
      test-run/bug/attached recording IDs and evidence paths, or the exact loud
      `Replay: N/A (<reason>) + mitigation` fallback required by AGENTS.md.

## Adversarial verification

1. Stage three full files, interrupt publication at every boundary and inspect both
   observers. One partial tree or two accepted copies after a lost response refutes
   atomic publication/reconciliation.
2. Race independent writers with different changes and the same parent, including
   separate platform processes. Dual success against the same current-head condition
   or an in-memory-lock dependency refutes fencing.
3. Reuse an idempotency key with a changed parent, object reference or file mode. Any
   success presented as the original request refutes request binding.
4. Attempt publication using known sibling-repo objects, forged seals and expired writer
   credentials. Any appended manifest refutes authorization/completeness.
5. Clear all indexes and local logs, restart and retry a prior accepted request. A new
   accepted event, missing tree or dependence on an agent transcript refutes authority.
6. Sabotage the final completeness check and expected-parent condition separately. The
   permanent target must fail named assertions; inspect the cited Replay QA history
   run rather than re-driving a different browser session to assess the UI claim.

## Verification log
