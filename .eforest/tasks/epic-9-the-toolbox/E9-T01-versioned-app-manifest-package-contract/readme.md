---
id: E9-T01
epic: 9
title: Versioned app manifest pins source, build, runtime, state, capabilities, providers, and UI entrypoints
priority: 901
status: pending
depends_on: [E8]
estimate: M
capstone: false
---

## Goal

`@eforest/app-manifest` exposes a frozen `AppManifestV1` contract that identifies an app, its source branch and offset, build digest, runtime profile, state schema, declared capabilities, UI entrypoints, provider choices, and module graph. Canonical serialization produces a stable digest; validation rejects malformed, unsupported, or cyclic graphs before an app is accepted.

## Context

Epic 9 needs one portable description of how an app is assembled before it can test UI packages, state providers, or runtime profiles. This contract records app composition; it does not change the authority of Electric Forest streams or imply that every named provider/runtime is supported. Optional choices must be explicit and validated. The public shape and canonical digest rules freeze here; later tasks consume them rather than defining parallel manifests.

## Deliverables

- `@eforest/app-manifest` schema, types, canonical serializer, digest function, and validator for `AppManifestV1`.
- Valid, malformed, unsupported-capability, missing-provider, and cyclic-module-graph fixtures under `evidence/`.
- `make verify-E9-T01` with deterministic digest and graph-validation coverage.

## Acceptance criteria

- [ ] Two clean processes serialize each valid fixture to byte-identical canonical JSON and the same SHA-256; command output and fixture digests are committed in `evidence/manifest-digests.txt`.
- [ ] The frozen schema requires app identity, source branch+offset, build identity+digest, runtime profile, state schema, capabilities, UI entrypoints, provider manifest, and module graph; `evidence/app-manifest-v1.schema.json` is the published schema used by the validator.
- [ ] Missing required fields, unknown schema versions, undeclared capabilities/providers, invalid entrypoints, and a one-edge cycle each produce a typed validation failure and no accepted manifest; `make verify-E9-T01` records each case in `evidence/validation-matrix.json`.
- [ ] `make verify-E9-T01` exits 0 and its committed package-graph report shows every accepted module graph is acyclic and every edge resolves to a declared module/export.

## Adversarial verification

1. Remove or alter each required field, add an undeclared provider/capability, and point an entrypoint at a missing export. Any invalid manifest accepted by the validator refutes the contract.
2. Introduce a cycle through an optional subpath and compare graph validation with an independent topological check. Acceptance or disagreement refutes cycle detection.
3. Vary key order, locale, timezone, and checkout path for the same manifest. Any byte or digest change refutes canonicalization.
4. Change one source offset, build byte, provider, or capability in a fixture. An unchanged digest or validation report refutes sensitivity.

## Roadmap alignment — 2026-10-16

This is later application-platform work after public launch, design, provider decisions and
changeset migration. Reuse E15's pinned contract/pilot/decision evidence before provider
qualification; optional app providers do not move Forest core authority out of streams.
Application source manifests pin E14 changeset identity and complete file-version/content
references. Derive comparisons in memory rather than storing patch artifacts outside redacted
agent logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
