---
id: E10-T01
epic: 10
title: "Ticket-bound fork manifest: canonical provenance for an application run"
priority: 1001
status: pending
depends_on: [E9]
estimate: M
capstone: false
---

## Goal

`@eforest/application-fork` defines and validates a versioned `ApplicationForkManifestV1` that binds one task ticket to the app-manifest digest, source branch and opaque source offset, separate source revision/tree digest and built-artifact digest, runtime and declared capabilities, state-schema identity, and a canonically ordered vector of authoritative Durable Streams ids and offsets. Its canonical JSON bytes and SHA-256 digest are stable across processes, and incomplete or contradictory provenance is rejected before a fork or run can use it.

## Context

The Time Machine epic begins with a reproducible identity for the exact app candidate and state boundary under test. This manifest is the shared input contract for the fork lifecycle, controlled effects, evidence ledger, acceptance runner, verdict, and PR check. It records authoritative app state as stream identities, opaque offsets, and reducer/schema versions; it does not copy state into a second log. Browser interaction evidence remains a separate Replay/rrweb reference and never substitutes for authoritative stream evidence.

The manifest is a provenance declaration, not an authorization grant: existing authenticated dispatch and server-side validation still decide whether a caller may create a fork or append an event. It must use official Durable Streams transport and existing Electric Forest stream/reducer contracts. This task freezes the manifest schema and encoding only; it does not create forks or execute application code.

## Deliverables

- `packages/application-fork/src/manifest.ts` with flat, versioned manifest types, runtime schema validation, canonical encoding, and SHA-256 digest calculation.
- A documented canonical JSON contract using RFC 8785 JSON Canonicalization Scheme for object-key ordering, whitespace, and JSON scalar encoding; capability names and authoritative stream members are additionally sorted because they have set semantics; scalar strings and opaque offsets are preserved exactly and offsets are never numerically parsed.
- Committed valid and invalid manifest fixtures covering absent fields, duplicate stream identities, contradictory ticket/source/build provenance, unsupported schema versions, and non-canonical representations.
- `make verify-E10-T01` and a cold-clone verification recipe that emit the fixture digest ledger and typed refusal results under this task's `evidence/`.

## Acceptance criteria

- [ ] `make verify-E10-T01` exits 0 from `tools/verify/cold_clone.sh`; the committed valid fixtures produce byte-identical canonical JSON and SHA-256 digests across two fresh processes, recorded in `evidence/e10-t01-manifest-digests.txt`.
- [ ] The schema has separate `sourceRevision` (the E14 changeset ID), `sourceContentManifestDigest`, `sourceTreeDigest`, and `buildArtifactDigest` fields; changing ticket, app-manifest, branch, source offset, either source identity, build artifact, runtime/capabilities, state schema, or an authoritative stream offset changes the manifest digest.
- [ ] Canonicalization follows RFC 8785 and sorts only capability/stream arrays declared as sets; equivalent representations yield identical bytes while any changed semantic scalar yields a changed digest or typed parse failure.
- [ ] Each missing required provenance field, duplicate authoritative stream identity, contradictory source reference, unknown schema version, and invalid digest fails with a stable typed error before producing a usable manifest; `evidence/e10-t01-invalid-cases.jsonl` records case, error code, and no-manifest result.
- [ ] One-byte changes to a canonical manifest fixture change its computed digest or fail parsing; the sensitivity transcript in `evidence/e10-t01-sensitivity.txt` names the field/byte and observed digest or error.
- [ ] The reducer/dependency graph used for canonicalization has no network, clock, random, filesystem, or database dependency; `make verify-E10-T01` records the checked module boundary.
- [ ] Verification log declares browser evidence `Replay: N/A (manifest schema and canonicalization only) + mitigation: cold-clone process-stability fixtures, invalid-provenance matrix, and byte-sensitivity transcript`.

## Adversarial verification

1. Reorder capability and stream arrays and encode equivalent JSON with different whitespace or object-key order. RFC 8785 canonical bytes/digest must match; changing any scalar value, including whitespace inside a scalar string, must change the digest or fail parsing.
2. Remove or contradict each required provenance field in turn, duplicate stream members, and use offsets that look numeric but are opaque. Any invalid manifest accepted or valid opaque offset rejected refutes validation.
3. Change each semantic digest-bearing field independently, including ticket, source revision/tree digest, build artifact digest, and source boundary. An unchanged digest refutes binding; a digest change caused only by a representation variant normalized by RFC 8785 refutes canonicalization.
4. Add a network/filesystem/clock import to the canonicalizer in a scratch copy and rerun the target. If the dependency-boundary check remains green, the purity measurement is refuted.
5. Run the target from a cold clone with scrubbed environment and independently recompute fixture digests using only canonical JSON and SHA-256. Any disagreement or warm-state requirement refutes the claim.

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
