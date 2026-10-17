---
id: E10-T03
epic: 10
title: "Controlled side-effect adapters: deterministic clock, randomness, network, and external effects"
priority: 1003
status: pending
depends_on: [E10-T01, E10-T02]
estimate: L
capstone: false
---

## Goal

`@eforest/application-fork` runs cooperative application modules through versioned, manifest-bound adapters for logical time, seeded randomness, network responses, and external-service effects. Supported app code calls the injected `@eforest/application-fork/effects` APIs; the runner shadows supported browser globals and rejects known direct escape APIs at build time. Repeated execution from the same manifest and recorded inputs produces identical effect logs and authoritative stream digests. This is a deterministic API contract for cooperative app code, not a security sandbox for hostile code or native modules.

## Context

The whitepaper's repeatable app run depends on making nondeterministic inputs explicit. This task provides a small adapter boundary for the effects needed by the vertical slice, with stable adapter identities/configuration digests included in the run provenance. The boundary must not claim to virtualize arbitrary operating-system behavior: unsupported capabilities are refused, and all network or service behavior must pass through an explicitly declared adapter.

The supported boundary is the runner's isolated browser module realm for the web profile and the declared adapter API set: `clock.now()`, `random.next()`, `network.fetch()`, and `services.invoke()`. The runner shadows `Date`, `Math.random`, `fetch`, `XMLHttpRequest`, and `WebSocket` in that realm with typed `UNDECLARED_EFFECT` failures; the build boundary rejects direct use of those globals and imports of `node:*`, `fs`, `net`, or undeclared service clients. This catches the named escape surface for cooperative modules; it does not contain arbitrary malicious JavaScript, native addons, or a compromised host. Adapters do not become a second state authority. Effects that change application state still enter through authenticated, validated dispatch and the official Durable Streams path. This task does not add a general container/VM sandbox, deploy adapters, or enable uncontrolled live production integrations.

## Deliverables

- A versioned adapter registry keyed by declared manifest capabilities for logical clock, seeded random source, intercepted network requests, and external-service record/replay or refusal, exposed through the named `@eforest/application-fork/effects` APIs.
- A build-time boundary rule and isolated browser-module test realm that reject/shadow the named direct escape surface, with explicit documentation that hostile code and native modules are outside this contract.
- Capability/configuration digests included in the fork run's provenance and effect ledger, with stable error codes for undeclared, unsupported, and policy-denied effects.
- Deterministic fixtures for repeated runs and negative fixtures for undeclared clock/random/network/service access, network escape, and adapter mismatch.
- `make verify-E10-T03` with effect-ledger and refusal evidence under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E10-T03` exits 0 from a cold clone; two fresh processes using the same manifest and recorded effect inputs produce byte-identical effect logs and identical per-stream reduced-state digests, recorded in `evidence/e10-t03-repeat-ledger.jsonl`.
- [ ] The effect log identifies adapter version/configuration digest and the ordered request/result for each controlled clock, random, network, and external-service effect; changing one declared input changes the expected effect or causes a typed mismatch.
- [ ] Each undeclared or unsupported capability fails closed before an external request or authoritative app-state append; `evidence/e10-t03-refusals.jsonl` records observed process/network events and unchanged stream heads.
- [ ] Planted `Date.now()`, `Math.random()`, raw `fetch()`, `XMLHttpRequest`, and `WebSocket` calls fail with the named `UNDECLARED_EFFECT` result in the runner realm; direct forbidden imports fail the build boundary. `evidence/e10-t03-escape-surface.json` records each attempted call, interception/rejection point, zero outbound requests, and unchanged app-stream heads.
- [ ] Replaying the same effect ledger through a fresh fork reproduces its final event offsets and reducer digests exactly; a one-byte ledger mutation is rejected or changes the resulting digest and is reported at the affected effect/offset.
- [ ] Verification log declares browser evidence `Replay: N/A (side-effect adapter contract and stream replay) + mitigation: repeated-process effect-ledger comparison, escape-sabotage transcript, and unchanged-head refusal evidence`.

## Adversarial verification

1. Run the same manifest in fresh processes with changed wall clock, locale, timezone, and host RNG state. Any output change not represented by a declared adapter input refutes determinism.
2. Use cooperative application fixtures that call host clock/random APIs, raw fetch/socket APIs, and an undeclared external-service client. Any named API call that is not rejected at the build or runner boundary, any outbound request, or any app event append refutes the supported boundary; do not treat this check as containment of arbitrary hostile code.
3. Change adapter version/configuration while retaining the manifest and effect ledger. Reuse must be rejected as a provenance mismatch; silently replaying a different adapter refutes binding.
4. Make the network adapter return reordered, duplicated, truncated, and mismatched responses. The ledger must preserve exact request/result identity and reject invalid replay rather than report a matching run.
5. Disable the escape detector in a scratch copy and plant a network call. If `make verify-E10-T03` stays green, the sensitivity proof is refuted.

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
