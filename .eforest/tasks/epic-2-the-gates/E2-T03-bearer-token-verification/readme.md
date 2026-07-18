---
id: E2-T03
epic: 2
title: "Platform gateway authentication: verify Auth0 bearer tokens before any official-stream access"
priority: 203
status: in-progress
depends_on: [E2-T02]
estimate: M
capstone: false
---

## Goal

`@eforest/platform` owns the authenticated application boundary. It verifies Auth0
bearer tokens from the pinned `vendor/emulate` fixture in local/E2 runs and from the
configured Auth0 issuer in deployment, then uses `@durable-streams/client` server-side
to reach Electric Durable Streams. Electric's server and protocol packages remain
unmodified.

The first protected operation is `POST /api/dispatch`. Invalid, expired, forged, or
missing tokens receive a typed 401 before stream lookup or append. The Durable Streams
origin is an internal dependency, not a second public mutation door.

## Deliverables

- `packages/platform` with issuer/audience configuration and cached JWKS verification.
- A request identity type containing the verified `sub`; clients cannot supply actor
  identity in an event payload.
- `POST /api/dispatch` authentication middleware that delegates accepted appends to
  the official client.
- Local integration tests using `vendor/emulate/packages/@emulators/auth0` and a real
  published `DurableStreamTestServer`.
- Golden refusal transcripts and a stream dump proving rejected requests append
  nothing.

## Acceptance criteria

- [ ] Valid RS256 tokens from the configured issuer reach dispatch with the verified
      `sub`; missing, malformed, forged, wrong-issuer, wrong-audience, expired, and
      unknown-`kid` tokens return typed 401 responses.
- [ ] Every refusal leaves the target official stream byte-identical and does not call
      create, append, read, or follow on the Durable Streams adapter.
- [ ] The local Durable Streams process binds only as test infrastructure; no source
      file patches or wraps `@durable-streams/server` behavior.
- [ ] Production source never imports emulator implementation files. Tests start the
      pinned submodule through its public launcher/API.
- [ ] `make verify-E2-T03` passes from a cold clone with deterministic Auth0 and
      official-server fixtures.

## Adversarial verification

1. Fuzz Authorization headers and JWT segments; any exception, 5xx, or stream access on
   refusal refutes the task.
2. Rotate the emulator key while retaining the same `kid`; cached-key acceptance after
   refresh is a refutation.
3. Put an `actor` field in a valid client payload; acceptance of the supplied identity
   instead of the verified subject is a refutation.
4. Search the diff for changes under a copied/forked Durable Streams implementation or
   a second transport client.

## Verification log

### 2026-07-18 — builder — work started

- Picked as the first eligible task after E2-T02 reached `verified`; branch
  `codex/e2-t03-bearer-token-verification` starts at verified stack tip
  `4df852d341bae1147f0d3fe985c6baa78a8ffe57` and will stack on draft PR #28.
- The task is a server-side gateway/authentication boundary rather than a browser UI
  change. Its final claim will declare `Replay: N/A (no browser-reaching surface) +
  mitigation` and name deterministic HTTP refusal transcripts, an official-stream dump,
  adapter call counts, and cold-clone evidence.
- Implementation starts by auditing the existing official-client/server adapters and
  E2-T02's public emulator launcher so the new package composes those boundaries without
  modifying or wrapping Durable Streams transport behavior.

(appended by builder and critic)
