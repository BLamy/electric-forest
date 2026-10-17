---
id: E9-T09
epic: 9
title: Cold-start the first manifest-built platform app over Electric Forest streams
priority: 909
status: pending
depends_on: [E9-T03, E9-T04, E9-T05, E9-T06, E9-T08]
estimate: L
capstone: true
---

## Goal

A cold-start sample app is built from `AppManifestV1`, renders shared published UI over a TanStack DB collection backed by Electric Forest reducers, and sends writes through authenticated dispatch. A second client observes the accepted event and matching replay digest. Its root excludes unused optional integrations, selected subpaths resolve, and its app/build/provider/browser evidence is bound to the manifest digest.

## Context

This is Epic 9's first runnable proof that the platform can assemble an app from the shared manifest, collection, provider-qualification, runtime, and package contracts. The sample uses the Electric Forest event log as authority. Optional provider results may be explicitly unsupported; the app must select only a provider/capability marked supported and must not present an unsupported qualification as success.

## Deliverables

- A cold-start sample app and versioned manifest using the web profile, published UI package, and reducer-backed TanStack DB collection.
- A cold-clone scaffold command that generates the sample app from the manifest without copying the published UI implementation.
- A two-client accepted-write/read journey with deterministic event log and replay digest evidence.
- `make verify-E9-T09`, package/bundle/provider reports, and a named Replay QA journey in the configured project.

## Acceptance criteria

- [ ] From a clean checkout and fresh stream data directory, the sample validates its manifest, builds, starts, and renders; `evidence/cold-start-transcript.txt` records commands, manifest/build digests, and zero skipped gates.
- [ ] `make scaffold-E9-T09` exits 0 from a cold clone and generates the manifest-driven sample in `examples/first-platform-app`; the transcript records the generated file list and proves no UI implementation was copied.
- [ ] A named component imported from the pinned published `@brett_lamy/ui` package renders the live TanStack collection and initiates the sample mutation through authenticated dispatch; the Replay journey identifies that component and proves its displayed update matches the second client and stream replay digest.
- [ ] Client A writes through authenticated dispatch; client B observes the accepted event; replay from the committed event log yields a digest byte-equal to both clients' collection state. The log and values are committed as `evidence/sample-events.jsonl` and `evidence/sample-digests.json`.
- [ ] The sample's root bundle excludes every unselected optional feature; its selected published UI subpath resolves. Package provenance, selected/unselected graph, and byte counts are in `evidence/sample-package-report.json`.
- [ ] The sample provider manifest can select the first-party reducer/collection baseline from E9-T03. Any selected optional provider must be a supported matrix row from E9-T04–T06; unsupported optional rows remain refused. All optional providers may be declined without blocking the first-party sample. The consumed matrix and validation result are in `evidence/sample-provider-matrix.json`.
- [ ] A Replay QA journey exercises cold app load, accepted write, second-client update, and displayed digest; the Verification log cites its project, journey, test-run, and recording identifiers. The journey has zero console errors and observed UI digest equals stream replay evidence.
- [ ] `make verify-E9-T09` exits 0 from the cold-start setup, and the final committed evidence binds the same manifest/build digest to event log, package report, provider matrix, and Replay journey.

## Adversarial verification

1. Start with a fresh profile and empty stream data directory, then repeat the journey. Any dependency on warm state, unpinned artifact, or changed manifest/build digest refutes cold-start reproducibility.
2. Attempt an unauthorized write and a direct client collection mutation. Any offset advance or second-client update without an accepted dispatch event refutes the one-door claim.
3. Delay or drop the accepted event for client B, then compare its visible state with replay. A displayed digest that does not match the event log refutes convergence.
4. Import every optional integration without selecting it in the manifest, then select an unsupported provider row. A green build/start or hidden dependency refutes the bundle and fail-closed claims.
5. Compare the Replay QA journey's actions, console, and displayed digest to the committed event log and package report. Missing behavior, console errors, or a digest mismatch refutes the capstone evidence.

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
