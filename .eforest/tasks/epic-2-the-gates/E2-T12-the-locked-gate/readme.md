---
id: E2-T12
epic: 2
title: "Capstone: the locked gate on Auth0, the platform gateway, and Electric Durable Streams"
priority: 212
status: in-progress
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
