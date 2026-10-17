---
id: E10-T08
epic: 10
title: "Ticket to verified app: cold end-to-end proof from ticket through evidence-backed PR check"
priority: 1008
status: pending
depends_on: [E10-T07]
estimate: L
capstone: true
---

## Goal

From a cold, Git-free application workspace, a fresh browser profile, and an empty Durable Streams server data directory, an operator can take one authorized app ticket through a manifest-bound isolated application fork, deterministic controlled-effects run, recorded Replay QA acceptance journey, independent critic verdict, and evidence-backed PR check. The final check is green only for the exact ticket/fork/build/stream boundary that the Replay journey and independent verdict examined; tampered, stale, mismatched, or refuted evidence blocks it.

## Context

This is the Time Machine epic's vertical-slice capstone: the smallest complete demonstration of the whitepaper's proposed application lifecycle running on Electric Forest's existing stream-native platform. E10-T01 through E10-T07 define the pieces; this task proves they compose from a clean start with durable, independently resolvable links. rrweb/Replay proves the browser journey that occurred. Durable Streams offsets, reducer versions, and replayed state digests prove authoritative app state. Neither evidence layer stands in for the other.

The capstone preserves the platform's official Durable Streams transport, authenticated validated mutation door, and no-side-authority rule. It does not claim to complete deployment, production monitoring, incident response, or training-data workflows proposed as later extensions in the whitepaper. Browser proof is mandatory through the configured Replay QA managed tunnel and committed project binding; local browser capture is only self-validation.

## Deliverables

- A `make verify-E10-capstone` cold-start orchestration that runs the real ticket-to-check path with fresh application workspace, fresh browser profile, and fresh stream-server data directory.
- One committed end-to-end fixture ticket with declared criteria/journey, manifest, build artifact, controlled effect inputs, and evidence references that exercise all E10 lifecycle stages.
- Complete task/fork/run/effect/Replay/stream/verdict/check event dumps, per-prefix authoritative state digests, boundary offsets, and an independently recomputable `EvidenceChainV1` root under `evidence/`. The root is SHA-256 over UTF-8 RFC 8785 canonical JSON for `{version, links}`; `links` appear in lifecycle order and contain event tuples `{kind, streamId, eventId, offset, eventDigest}` plus the Replay tuple `{kind, projectId, journeyId, testRunId, recordingId, recordingUrl}`. The root field itself is excluded from the hashed input.
- A named Replay QA journey run through the configured managed tunnel, with attached recording, zero-console-error result, and visible ticket/fork/build/check identity and stream offsets/digests.
- A bounded integrated tamper/staleness matrix proving the check blocks for a stale build, wrong fork, or altered evidence reference; exhaustive interruption and changed-code coverage cases are consumed from E10-T05 and E10-T06 evidence.

## Acceptance criteria

- [ ] `make verify-E10-capstone` exits 0 from a cold clone with a fresh Git-free application workspace, browser profile, and stream-server data directory; it does not rely on a prior task run, warm cache, or preexisting fork.
- [ ] One event chain resolves in order from authorized ticket and manifest through isolated fork, controlled-effects ledger, Replay QA acceptance run, paired authoritative stream events/digests, distinct independent verdict, and passing PR check; `evidence/e10-capstone-chain.json` names every event id, stream id, opaque offset, reducer digest, manifest/build/evidence digest, and cross-reference.
- [ ] Replaying every authoritative app-state stream twice from the declared fork boundary yields identical per-prefix digests; the final digests match the run ledger and the UI-visible offsets/digests captured in the Replay recording.
- [ ] The configured Replay QA project records the named acceptance journey through the managed tunnel; the run has zero console errors, an attached Replay recording URL, and shows the exact ticket, fork, candidate build, and final check identity named by the event chain.
- [ ] Independent recomputation of the `EvidenceChainV1` root using lifecycle-ordered links, RFC 8785 canonical JSON, UTF-8, and SHA-256 matches the recorded root; removing a link or changing one byte in a digest-bearing reference causes `make verify-E10-capstone` to exit nonzero and identify the failed member.
- [ ] The bounded integrated tamper runs with stale build, wrong fork, and altered evidence reference never produce a passing PR check; `evidence/e10-capstone-negative-runs.jsonl` records each refusal and unchanged candidate PR/branch/app-state heads. Focused E10-T05/T06 evidence supplies the exhaustive interruption and changed-code coverage cases and is itself resolved by the capstone chain.
- [ ] Builder, runner, and critic provenance identify distinct server-authenticated principals/sessions; critic findings cover every declared criterion and its diff coverage ledger matches the exact candidate in the capstone chain. Only the independent critic can record the passing verdict.
- [ ] Browser and stream evidence remain distinguishable throughout the chain: rrweb/Replay is cited as browser interaction evidence, while app state is derived only from official stream events and reducer digests. Any claim that browser snapshots establish state or that stream digests prove the visible journey refutes the capstone.
- [ ] Epic-closing Replay QA exploration is run after the focused journey succeeds and cites the integrated ticket-to-check journey, project id, exploration/test-run ids, recording URL, and final stream/check digests; the independent critic interrogates the journey and exploration against the event chain.

## Adversarial verification

1. Repeat the entire capstone from a fresh cold root and independently resolve every event link and digest before inspecting the claimed root. Any missing, duplicated, or circularly self-asserted evidence refutes composition.
2. Change one authoritative stream offset, reducer digest, manifest/build identity, Replay recording id, critic session, or PR candidate head at a time. Every altered chain must fail closed before a passing check is written.
3. Make the browser journey show a success state while the stream dump is stale, then make the stream digest correct while the Replay journey fails. Either mismatched half must prevent the final pass.
4. Append an unrelated event to the parent branch and a state-changing event to the fork after the candidate evidence is recorded. The candidate check must stay tied to the recorded fork head and become stale when that head changes.
5. Attempt to create an app-state mutation or passing check through raw transport, direct reducer, cached result, and unauthorized dispatch paths. Any successful bypass refutes the platform boundary.
6. Substitute the E10-T05 restart matrix or E10-T06 diff-coverage evidence after the capstone chain is produced. If the root still verifies without resolving the focused task evidence against the exact candidate, capstone evidence composition is refuted.

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
