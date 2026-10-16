---
id: E10-T04
epic: 10
title: "Paired browser and stream evidence: bind Replay interaction to authoritative app state"
priority: 1004
status: pending
depends_on: [E10-T02, E10-T03]
estimate: M
capstone: false
---

## Goal

`@eforest/application-fork` emits a versioned run-evidence ledger pairing one durable `runId` and `forkId` with its ticket, Replay QA/rrweb browser journey, Replay project identity, exact manifest and candidate build digests, journey and recording references, authoritative Durable Streams event ids/opaque offsets, and reducer state digests at declared checkpoints. A verifier rejects stale, tampered, mismatched, or incomplete pairings; Replay remains evidence of what the browser encountered, while stream offsets and reducer digests remain the authority for app state.

## Context

The whitepaper needs both sides of a run: browser interaction history and the state changes that actually persisted. This task freezes their correlation contract without treating rrweb snapshots as authoritative state or copying stream payloads into the browser recording. Correlation must resolve to exact referenced stream events and reducer checkpoints from the fork created in E10-T02, under the controlled effects declared in E10-T03.

Because this work changes browser-facing evidence capture and inspection, its implementation must surface relevant run identity, stream offsets, and digests in the app and exercise them through the configured Replay QA managed tunnel. The existing Replay project binding and journey workflow remain in force. No second transport or unauthenticated state mutation is introduced.

## Deliverables

- Versioned `ForkRunEvidenceV1` schema and verifier in `packages/application-fork`, with ticket, `runId`, `forkId`, Replay project identity, explicit browser-evidence references, and a separate authoritative stream checkpoint vector.
- Correlation rules linking Replay journey steps to zero or more exact fork event references and reducer digests without claiming a browser frame proves an app-state mutation.
- App UI surface for the active run's manifest/build identity and relevant authoritative offsets/digests, plus a named Replay QA journey exercising the visible evidence view.
- Valid, stale, mismatched, tampered, incomplete, and wrong-fork fixtures; `make verify-E10-T04` and evidence ledger/tamper transcript.

## Acceptance criteria

- [ ] `make verify-E10-T04` exits 0 from a cold clone and the named Replay QA journey runs in the committed project binding with a recording URL, journey/test-run ids, zero console errors, and DOM-visible ticket/run/fork identity, manifest/build identity, and authoritative offsets/digests recorded in `evidence/e10-t04-run-ledger.json`.
- [ ] Every `ForkRunEvidenceV1` browser and stream reference resolves to the same ticket, `runId`, and `forkId`; its Replay project id matches the configured project binding. Missing or substituted run/fork references fail with typed reasons in the invalid-ledger results.
- [ ] Every ledger stream reference resolves to an event at the named fork stream and opaque offset; independently replaying from the fork boundary reproduces each cited reducer digest exactly.
- [ ] The verifier rejects separate fixtures with a stale manifest, wrong build, wrong fork, missing event reference, mismatched offset, tampered reducer digest, and Replay recording/journey identity mismatch; `evidence/e10-t04-invalid-ledger-results.jsonl` names each rejection and no invalid ledger verifies.
- [ ] Replacing or removing the Replay recording reference never changes authoritative stream replay output, and a browser-only interaction without a referenced stream event is represented as browser evidence only; the recorded test proves this separation.
- [ ] A one-byte mutation to each digest-bearing ledger field is refused or changes the recomputed ledger digest; evidence names the field, expected/observed digest, and verifier result.
- [ ] Verification log cites Replay QA project, journey, test-run, recording URL, plus stream dump/offset/digest. If Replay QA is unavailable, the claim remains unverified rather than treating local rrweb as final evidence.

## Adversarial verification

1. Substitute a recording from a different build, ticket, fork, or project while leaving the event ledger intact. The verifier must reject the identity mismatch; matching only a human-readable title refutes provenance.
2. Shift a cited opaque stream offset by one, point at a valid event from the parent branch, and retain the original digest. Any accepted ledger refutes branch and offset binding.
3. Alter the browser recording reference while preserving stream references, then alter stream references while preserving the recording. The first must not change authoritative app-state replay; the second must fail stream verification.
4. Hide or stale the visible DOM digest/offset while the server returns current values. The Replay journey must detect the discrepancy; a green run with mismatched DOM and stream evidence refutes the UI proof.
5. Remove one changed browser-evidence hunk from the named journey or introduce a console error in a scratch copy. If Replay QA still passes without exercising/reporting it, the measurement is insufficient.

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
