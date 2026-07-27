---
id: E2-T12
epic: 2
title: "Capstone: the locked gate on Auth0, the platform gateway, and Electric Durable Streams"
priority: 212
status: implemented
depends_on: [E2-T11]
estimate: L
capstone: true
---

## Goal

From a cold clone, the capstone starts the pinned `blamy/emulate` Auth0 service, the
electric-forest platform gateway, and Electric's published local Durable Streams server.
Playwright completes Auth0 authorization-code+PKCE login, mints a CLI token, performs an
authorized application dispatch, then proves the equivalent tokenless request is refused
without changing the stream.

The same application code targets Electric Cloud by configuration; no fork, local
transport implementation, custom Durable Streams endpoint, or production emulator path
is permitted.

## Deliverables

- `make verify-E2-T12` / `verify-E2-capstone` cold-start orchestration.
- One browser walkthrough recorded under Replay Chromium with its matching verified MP4.
- A CLI leg using a minted, revocable token through `POST /api/dispatch`.
- Before/after official stream dumps, application digests, and refusal transcript.
- A deployment-configuration check proving production selects Electric Cloud and real
  Auth0 without code changes.

## Acceptance criteria

- [ ] A fresh browser logs in through the pinned Auth0 emulator using real pointer and
      keyboard input with zero console errors and zero non-loopback external requests.
- [ ] The authenticated browser session mints a CLI token whose issuance is present on
      the identity stream.
- [ ] The CLI's authorized dispatch appends exactly one application event through the
      platform gateway and the reduced digest changes as expected.
- [ ] The tokenless and revoked-token versions return the typed refusal and leave the
      stream byte-identical.
- [ ] The platform reaches a real `DurableStreamTestServer` via
      `@durable-streams/client`; no product package imports emulator internals or
      implements Durable Streams protocol behavior.
- [ ] The Replay URL, MP4 path, event-log offsets, and digests are recorded in the
      verification claim.

## Adversarial verification

1. Run from a pristine clone with the submodule initialized and all service state empty.
2. Compare the Replay network timeline with stream dumps so the authorized append and
   refused append are both anchored.
3. Swap the test server URL for an Electric Cloud test project using only configuration;
   any code-path divergence refutes portability.
4. Search production dependencies for emulator internals, copied Durable Streams code,
   or direct browser access to the stream origin.

## Verification log

(appended by builder and critic)

### 2026-07-27 — builder — implemented

- Proof commit:
  `36651cfbe1f5d78d4aec471b7a851c90530491cf`.
- Gates:
  `pnpm format:check && pnpm lint`; `pnpm typecheck`; `pnpm test` (31 files,
  406 tests); `pnpm build`; `make verify-E2-T12`; `make verify-E2-capstone`;
  and `tools/verify/cold_clone.sh verify-E2-T12`. Both named targets passed,
  and the last command reported `cold_clone: verify-E2-T12 PASSED from a
  pristine clone` of the exact proof commit with pinned `vendor/emulate`
  commit `82eb835947c97fcf6e0596a4377acbb01ca13ede`.
- Replay:
  [recording 6a201545-75e0-4d13-a968-a53f8ce970d5](https://app.replay.io/recording/6a201545-75e0-4d13-a968-a53f8ce970d5),
  uploaded explicitly with
  `replayio upload 6a201545-75e0-4d13-a968-a53f8ce970d5`.
  Matching video:
  `/private/tmp/electric-forest-e2-t12/recordings/e2-t12-final.mp4`
  (verified H.264 MP4, 1280x720, 30 fps, 31.9 seconds, 572833 bytes).
  Browser interrogation reported zero console errors, zero warnings, and
  zero non-loopback requests.
- Lifecycle compatibility: this repository's `"type": "module"` makes Node
  interpret the vendored CommonJS lifecycle `.js` files as ESM. The final
  session therefore ran byte-identical temporary `.cjs` copies of
  `browser-open.js` (SHA-256
  `6e9d9ad00b984fa663e270e4a0bfefbd490b23819a4e2ac6bd0beb65cde947b2`)
  and `browser-close.js` (SHA-256
  `016416fbab0d2d5188410174a3144c5e3ae47d24a3b9a2abb5137a253cd9357e`).
  The Playwright run-code isolate also required a temporary runner with the
  trailing statement semicolon removed, macOS `Meta+A` selected explicitly,
  and URL parsing evaluated in the page. These were orchestration-only
  compatibility adaptations; the browser executed the committed proof
  server and product bundles at the proof commit.
- Stream evidence:
  `evidence/e2-t12-before.raw.json`,
  `evidence/e2-t12-after.raw.json`,
  `evidence/e2-t12-after.jsonl`, and
  `evidence/e2-t12-capstone.json`. Before: offset
  `0000000000000000_0000000000000000`, digest
  `f62a9e9bbd5f0f2c93cf41922fbb8c05c63f5028b2d339d32d2d60481f1bd80f`.
  Authorized CLI dispatch: exactly one event, offset
  `0000000000000000_0000000000000204`, digest
  `0f7709f1e8a6db71898da6c96076dac4110d93d979ec1b932cd019a1a15dbe2c`.
  The grant issuance is anchored at identity offset
  `0000000000000000_0000000000000002`; revocation is anchored at identity
  offset `0000000000000000_0000000000000005`. The tokenless request returned
  HTTP 401 and the revoked CLI invocation returned exit 13; both left the
  target bytes identical to the authorized after-state.
- Portability:
  `E2_T12_PORTABILITY_OK` confirmed
  `packages/platform/src/bin.ts -> createPlatformProductionRuntime`,
  real Auth0/Electric deployment hosts, published
  `@durable-streams/client@^0.2.6` and
  `@durable-streams/server@^0.3.7`, and zero emulator product imports,
  custom platform transports, or code-path divergence.

The recording demonstrates the complete locked-gate path in one browser
session: a fresh Auth0 authorization-code+PKCE login, web-session CLI-token
mint, successful built-CLI dispatch of exactly one application event, typed
byte-neutral tokenless refusal, grant revocation in the web app, and typed
byte-neutral revoked-token refusal. The DOM proof state binds the session to
the immutable proof commit and exposes the cited stream offsets and digest.
