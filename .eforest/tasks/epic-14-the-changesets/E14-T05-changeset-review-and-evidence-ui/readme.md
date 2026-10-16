---
id: E14-T05
epic: 14
title: "Review changesets and evidence through immutable versions and transient comparisons"
priority: 555
status: pending
depends_on: [E14-T04]
estimate: L
capstone: false
---

## Goal

The web app organizes new source history and PR review around immutable changesets,
full file-version links and evidence bound to the tested head. Users browse changed
paths, open exact before/after versions, request an in-memory comparison, follow agent
provenance and inspect the claim/verdict/Replay evidence for that changeset. New review
state stores version/line anchors and evidence references, never textual diff bodies.

## Context

E13 supplied the design contract; E14-T03/T04 made changesets and full-version files
real and visible. This task completes the review/navigation path rather than rendering
mock changesets or saving a second copy of source as a diff. All comparisons are
deterministic over exact immutable endpoints and remain memory-only: no disk/HTTP
cache, localStorage, IndexedDB, service-worker persistence, telemetry body or attachment
silently becomes a patch archive. Complete file objects and endpoint/hash manifests
are legitimate source/evidence. A newly saved textual diff outside a redacted agent
tool log is not.

Preserve E5's verified PR authorization, evidence gate and terminal-history behavior.
Add versioned changeset/review/evidence bindings where necessary without rewriting
existing events or reinterpreting old review anchors. New comments anchor to immutable
file identity/version, side and line/range metadata rather than saved hunk text. An
outdated anchor remains visibly tied to its old version after a new changeset arrives.
Any shared evidence-model extension is additive/versioned and leaves v1 goldens intact.

The no-diff rule classifies artifact roles, not source byte patterns: an ordinary
full source file (including a `.patch` fixture) remains permitted. New generated patch
operations/comparison bodies are forbidden outside redacted agent logs. Recorded
comparison scenes mask generated text and derived payloads before any QA timeline,
screenshot, console/network body, Playwright trace/snapshot artifact or attached recording persists them. Keep immutable
endpoint IDs, comparison-result digests and UI state so the critic can independently
recompute expected comparisons. Qualify masking with a canary before upload; unsupported
masking is an evidence blocker or the literal AGENTS.md fallback, never a silent waiver.

## Deliverables

- Changeset list/detail and changed-file navigation in `apps/web` or its owned shared
  UI packages, with immutable parent/version links and accessible full-version views.
- Transient text comparison plus binary/mode/rename/delete views, with authenticated
  endpoint reads and explicit loading, forbidden, unavailable, conflict and stale states.
- Versioned `PRChangesetBindingV1`, review anchors and `ChangesetEvidenceBindingV1`
  linking a claim/verdict/evidence manifest to exact changeset/head/tree digests.
- Read and dispatch validation and additive evidence references using existing platform
  capabilities; no independent UI mutation or duplicate attachment authority.
- Proposed `make verify-E14-T05`, focused named Replay QA journeys, Playwright DOM/
  network/storage assertions, endpoint/digest fixtures and review/evidence refusal logs.

## Acceptance criteria

- [ ] `make verify-E14-T05` exits 0 cold with zero skips and legacy E5 PR/evidence
      targets remain green. `evidence/review-contract.json` binds each new rendered
      changeset, parent, before/after version and evidence reference to the authoritative
      event offset and independently computed digest.
- [ ] Real pointer/keyboard interactions navigate a changeset containing text, binary,
      mode-only, rename and delete cases, open full endpoints and compute a text
      comparison. Repeating the comparison in independent processes yields identical
      normalized ranges; `evidence/comparison-parity.json` records endpoint hashes and
      comparison-result digests without storing the textual diff body.
- [ ] A permitted review comment and evidence attachment bind to the selected immutable
      changeset/version. A newer changeset marks the earlier anchor/evidence stale
      rather than retargeting it; source/head substitution, cross-repo references and
      revoked capabilities are refused with unchanged stream digests. Exact bindings
      and refusals are in `evidence/review-binding-matrix.json`.
- [ ] PR approval/merge can use only the evidence/current-head relationship allowed by
      the existing gate plus its explicit versioned binding; a verdict for another
      changeset/head cannot satisfy a newly bound candidate. Pre-existing terminal PRs
      and evidence v1 replay to their original pinned digests in
      `evidence/legacy-review-parity.json`.
- [ ] Reads, comparison rendering and navigating evidence produce no source mutation.
      Captured requests, server storage, browser persistent stores and new event dumps
      contain zero saved textual diff/patch bodies; comparison responses are
      non-persistent and omitted from body telemetry. Counts, response policies and
      storage probes are in `evidence/comparison-storage-audit.json`.
- [ ] Deleting all agent logs and disposable client/server comparison caches still
      permits reading every full endpoint and regenerating comparisons. Offline or
      revoked access never displays bytes from an unrelated cached scope; before/after
      endpoint hashes and refusal observations are in `evidence/cold-review.json`.
- [ ] Playwright exercises full navigation, comment/attachment creation/removal, stale
      head, forbidden/error, reconnect and narrow-screen/keyboard paths with zero
      console errors. Atomic DOM changeset/version/offset/digest values match replay.
      The claim cites the configured managed-tunnel Replay QA project, focused journey,
      test-run, bug and attached recording IDs or the exact loud AGENTS.md fallback.
- [ ] A unique generated-diff canary is absent from every persisted QA/recording,
      screenshot, console/network-body, Playwright trace/snapshot and evidence surface outside agent logs. The
      live DOM exposes endpoint IDs and a comparison digest matching independent
      regeneration; `evidence/recording-mask-audit.json` records the pre-upload canary
      refusal/sensitivity checks without copying the canary's comparison body.
- [ ] Rebinding an anchor to the latest version, accepting a wrong-head evidence link,
      and persisting a comparison body each make a distinct permanent assertion fail
      in `evidence/review-sensitivity.json`.

## Adversarial verification

1. Advance the source branch while a reviewer holds an older changeset open. Comments
   or evidence silently moving to the new version, or a stale verdict satisfying its
   merge gate, refutes immutable review binding.
2. Compare your own CRLF/Unicode text and binary/mode/rename/delete endpoints. Wrong
   bytes, nondeterministic ranges or a fabricated text patch for binary content refutes
   comparison correctness.
3. Inspect network response policies, telemetry, service-worker caches, browser storage,
   server caches and accepted event payloads after comparison. A new stored textual
   diff outside redacted agent logs refutes the storage boundary.
4. Revoke access during an endpoint request and switch org/repo identities. A stale
   authorized cache revealing bytes under the new scope refutes tenant isolation.
5. Remove agent logs and all disposable comparison caches, then independently fetch
   the immutable versions. Missing reconstructable endpoints refutes full-content
   authority; rerunning a saved diff is not a remedy.
6. Tamper with changeset/head/hash in a review or evidence request and with versioned
   legacy inputs. Any unauthorized acceptance or changed historical replay refutes the
   additive compatibility contract.
7. Inspect the builder's cited Replay QA journeys and inject the three sensitivity
   mutations in scratch copies. Missing scenes require new evidence, and a green
   mutation refutes the measuring apparatus rather than excusing the UI claim.

## Verification log
