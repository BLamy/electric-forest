---
id: E10-T02
epic: 10
title: "Isolated application fork lifecycle: fork code and authoritative state at one manifest boundary"
priority: 1002
status: pending
depends_on: [E10-T01]
estimate: L
capstone: false
---

## Goal

`@eforest/application-fork` creates and resolves an isolated application fork from an `ApplicationForkManifestV1`: for this first vertical slice, each manifest boundary must match the currently observed published Durable Streams head, and the fork uses the official head-fork operation. Historical offsets are rejected until an application-offset-to-transport-offset mapping is a verified platform capability. The fork starts with the same per-stream offsets and reducer digests as its parent, and authenticated app dispatches append only to the fork so parent state and sibling forks remain unchanged.

## Context

The manifest gives a run an exact starting point; this task turns that point into a usable isolated application candidate. A fork is a linked code/build artifact plus authoritative stream forks, not a copy in an untracked database or an rrweb recording. Existing Electric Forest reducer and dispatch rules remain authoritative: every state mutation goes through the authenticated, validated mutation door, and the official Durable Streams transport owns stream operations.

The lifecycle must fail closed if a source boundary is not the current published head, a manifest digest no longer matches its fields, a referenced app stream or state schema is unsupported, or the caller lacks authorization. Multi-stream creation is staged and unpublished: no fork is selectable until every stream fork and the final authenticated registry commit succeed. A failed or interrupted stage is idempotently resumed or marked aborted and made unresolvable; partial stream objects that cannot be deleted through a published API remain unaddressable and are recorded as cleanup residue. It establishes creation, lookup, and isolation evidence only; deterministic side-effect control and acceptance execution are later tasks.

## Deliverables

- Fork lifecycle operations in `packages/application-fork` to create, inspect, and resolve a fork from a validated manifest.
- Versioned fork lifecycle events/references linking the ticket, manifest digest, source branch and offsets, artifact/build digest, fork identity, and resulting stream heads without duplicating app state.
- Integration with the existing authenticated dispatch door and official Durable Streams stream-fork APIs; no alternate transport or direct reducer-bypassing write path.
- A staged registry lifecycle with an authenticated commit event after all stream forks exist, plus idempotent resume/abort handling for partial creation and a cleanup ledger for any unaddressable transport residue.
- Parent/fork/sibling fixtures, per-stream initial digest ledger, isolation transcript, and `make verify-E10-T02` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E10-T02` exits 0 from a cold clone and records the manifest digest, fork identity, parent/fork stream ids, fork offsets, and per-stream state digests in `evidence/e10-t02-fork-ledger.jsonl`.
- [ ] Every manifest stream boundary equals the currently observed published parent head before creation; the official head-fork operation creates the child, while any older/historical boundary or concurrent head change is refused with a typed reason until offset mapping is supported.
- [ ] For every stream in the manifest, replaying the parent and new fork from the committed head produces byte-equal reduced-state digests and matching reducer/schema versions; no fork resolves through the registry before every stream fork exists and the authenticated commit event is appended.
- [ ] Injecting a failure after each stream-fork operation and before registry commit, then retrying or aborting, yields one committed fork or one aborted, unresolvable fork; repeated cleanup is idempotent, parent/app heads stay unchanged, and any undeletable transport residue is listed without a public fork reference in `evidence/e10-t02-cleanup-ledger.jsonl`.
- [ ] An authenticated mutation appended through the normal dispatch door changes the fork digest at the reported fork offset while the parent and an independently created sibling remain byte-identical to their pre-append digests; before/after stream dumps and digests are saved under `evidence/`.
- [ ] Unauthenticated, cross-project, cross-branch, malformed-manifest, stale-boundary, and unsupported-schema requests are refused before any fork or app-state append; `evidence/e10-t02-refusals.jsonl` names each case and confirms unchanged heads.
- [ ] Source inspection plus a planted direct-write attempt proves the fork cannot mutate state outside authenticated validated dispatch; the attempt is rejected and no authoritative stream offset advances.
- [ ] Verification log declares browser evidence `Replay: N/A (fork lifecycle and stream isolation only) + mitigation: parent/fork/sibling event logs, exact replay digests, and dispatch-refusal transcript`.

## Adversarial verification

1. Request a historical manifest offset, then race a parent append with a head-bound request. Historical offsets must fail closed and the race must either commit exactly the observed head or refuse; mixed or silently advanced state refutes isolation.
2. Append one event to the fork, then to the parent, then to a sibling. Replay each independently; any cross-branch event or changed digest refutes isolation.
3. Fail after each individual stream fork in a multi-stream request, including a schema mismatch. No staged child may be discoverable before commit; cleanup or resume must converge to one committed fork or one aborted unresolvable fork without advancing parent app state.
4. Bypass the public operation and attempt direct server/reducer writes using the fork identity. Any accepted state mutation outside authenticated validated dispatch refutes the mutation boundary.
5. Recompute parent and fork digests from cold stream dumps without importing lifecycle code. Any claimed initial equality or unchanged-parent result that cannot be independently reproduced refutes the evidence.

## Roadmap alignment — 2026-10-16

This later application-history capability builds on the already-hosted Forest, E15 provider
decisions and E14 source model. Every fork/build/run/verdict/check manifest binds source
changeset ID and complete file-version/content-manifest hash alongside branch/offset, tree,
artifact and authoritative state boundaries. A changed changeset, file-version manifest or
blob identity invalidates dependent evidence. Persist endpoint manifests, hashes and
citations; textual comparisons remain transient except within redacted agent logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
