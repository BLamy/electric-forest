---
id: E2-T03
epic: 2
title: "Platform gateway authentication: verify Auth0 bearer tokens before any official-stream access"
priority: 203
status: implemented
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

- [x] Valid RS256 tokens from the configured issuer reach dispatch with the verified
      `sub`; missing, malformed, forged, wrong-issuer, wrong-audience, expired, and
      unknown-`kid` tokens return typed 401 responses.
- [x] Every refusal leaves the target official stream byte-identical and does not call
      create, append, read, or follow on the Durable Streams adapter.
- [x] The local Durable Streams process binds only as test infrastructure; no source
      file patches or wraps `@durable-streams/server` behavior.
- [x] Production source never imports emulator implementation files. Tests start the
      pinned submodule through its public launcher/API.
- [x] `make verify-E2-T03` passes from a cold clone with deterministic Auth0 and
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

### 2026-07-18 — builder — claim submitted

- Claim tip: `67d857ae73b1425b2d7e0bc22b75f8360b16cba7`. `@eforest/platform`
  verifies RS256 bearer tokens against configured issuer, audience, time bounds, and
  cached JWKS; unknown keys and signature failures force a refresh, including same-`kid`
  rotation. `POST /api/dispatch` authenticates before parsing or touching the official
  stream adapter, rejects client-supplied `actor`, and injects the verified `sub`.
- Final aggregate run: `CI=true make verify-all` passed formatting, lint, typecheck,
  256 root tests, build, every historical promoted target, 61 upstream Auth0 tests, six
  upstream public-API tests, E2-T02 browser proof, and the newly aggregated
  `verify-E2-T03`. The gateway result was `E2_T03_GATEWAY_OK`: nine refusal cases,
  zero create/append/read/follow calls on refusal, one accepted append as
  `auth0|gateway-user`, and stream digest
  `116cce8d7509d3378baa4787eec46af3a3cc417e9a5de0abe2951b9d4f8f0674`.
- Exact-head proof: `tools/verify/cold_clone.sh --keep verify-E2-T03` passed from pristine
  clone `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.WBjcCoVNEH` at
  `67d857ae73b1425b2d7e0bc22b75f8360b16cba7`, with scrubbed environment and lockfile-only
  hydration. Signature-bypass and actor-precedence sabotages in disposable worktrees both
  made the apparatus fail before those worktrees were removed.
- Stream evidence: `evidence/e2-t03-refusal-transcript.jsonl` records typed refusals;
  `evidence/e2-t03-adapter-calls.json` records the zero-access boundary;
  `evidence/e2-t03-stream-dump.jsonl` records the sole accepted event; and
  `evidence/e2-t03-key-rotation.txt` plus `evidence/e2-t03-sensitivity.md` record
  same-`kid` refresh and sabotage sensitivity. Production-source scans found no emulator
  import and `4df852d341bae1147f0d3fe985c6baa78a8ffe57..67d857a` changes no
  `packages/server` path.
- Replay: N/A (server-only gateway with no browser-reaching surface) + mitigation:
  deterministic HTTP refusal transcript, adapter-call counters, official-stream dump and
  digest, pinned public-emulator integration, full aggregate gates, and exact-head cold
  clone.

(appended by builder and critic)
