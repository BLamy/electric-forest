---
id: E3-T02a
epic: 3
title: "Authenticated app shell: session-backed whoami, SPA routing, and frozen DOM stream-triple contract"
priority: 302
status: implemented
depends_on: [E2]
estimate: S
capstone: false
split_from: E3-T02
inherited_invalid_loop_commit: 1d22b95
---

## Goal

Independently prove the product-facing half of E3-T02: the built React SPA is served by
the authenticated platform origin, `/api/whoami` is session-backed and log-neutral, and
every rendered stream region exposes one complete, internally consistent
`data-ef-stream` / `data-ef-offset` / `data-ef-digest` triple. This task owns the shell,
routing, identity view, and browser-verify core. It does not own credential encoding
policy or Replay close/upload publication.

## Lineage and scope

E3-T02 was stopped after refuted run 16 at commit `1d22b95`. Its complete Verification
log remains in the cancelled parent readme and is incorporated by reference. This split
does not reset that history. Historical recordings and receipts are context only; this
child must re-earn exact-head evidence.

Owned paths: `apps/web/**`; the platform SPA, auth route, production topology, and
session-backed whoami integration; browser-verify core APIs; A-specific verification
scripts and evidence. Shared Makefile wiring is assigned to this task only for its own
target.

## Deliverables

- Authenticated SPA shell and typed, log-neutral `/api/whoami`.
- Frozen complete DOM stream-triple contract and `collectEfRegions`.
- `bootWorld` / `loginAs` core harness with default console, page-error, and failed
  same-origin request tripwires.
- SPA/deep-link/logout, identity provenance, and partial-triple regression tests.
- Fresh stream evidence, same-session MP4 plus Replay URL or loud fallback, and
  `make verify-E3-T02a`.

## Acceptance criteria

- [ ] Exact-head and pristine cold-clone `verify-E3-T02a` pass with scrubbed environment,
      loopback networking, and two isolated concurrent worlds.
- [ ] Unauthenticated app routes redirect; `/api/whoami` returns typed JSON 401 and never
      HTML; forged, ended, and malformed sessions leave the identity stream byte-identical.
- [ ] Authorization-code + PKCE login renders subject and email from an independently
      reduced identity view, never token claims or fixtures.
- [ ] Exactly one EF region exposes a complete triple whose offset and digest equal an
      independent replay truncated to that offset; reload after an out-of-band identity
      event advances to a new consistent triple.
- [ ] Root/org/repo/back/forward navigation uses one document load; authenticated deep
      links and 404 work; API/auth paths never SPA-fallback; traversal cannot escape dist.
- [ ] The default harness trips on console error, page error, failed same-origin request,
      each independently damaged triple attribute, a wrong-stream digest, and SPA/API
      fallback sabotage; the clean control stays green.
- [ ] Root gates plus E2-T04 and E2-T12 regressions remain green.

## Adversarial verification

Attack every route/static-asset/traversal class, forged and ended sessions, malformed
whoami methods and bodies, independently replay the triple, damage each attribute alone,
inject mount and lazy-route failures, run two cold worlds, and interrogate the fresh
recording. Scanner grammar or upload-race findings cannot refute this child unless they
show the shell/core tripwire itself is wrong.

## Verification log

### 2026-07-29 — human-directed decomposition authorization

- Authorization: APPROVED
- Task: E3-T02a
- Parent stopped after run: 16
- Scope: lineage-preserving E3-T02 decomposition and independent E3-T02a verification
  only.
- Accounting: this child has newly narrowed product-only criteria and no inherited open
  finding. It receives fresh child accounting only because the migration matrix assigns
  every unresolved parent finding to E3-T02b; the parent run ledger remains unchanged and
  E3-T02b stays downstream-blocking.

### 2026-07-29 — split validation — PENDING IMPLEMENTATION

- Parent coverage assigned here: app serving, auth/whoami, identity provenance, SPA
  routing, DOM triple, browser-verify core, and the product-specific portions of the
  original shell evidence.
- Fresh proof required: all acceptance checks above, exact-head gate, cold clone, and
  browser recording. No parent green receipt verifies this child.

### 2026-07-29 — builder — CLAIM: implemented

- Commit under test: `084037f8439e42a69d573a9ff13d1055d609679b`.
- Exact-head gate: `make verify-E3-T02a` passed under the repository loopback sandbox:
  format, lint, typecheck, 34/34 test files and 413/413 tests, build, Auth0 emulator
  (61 + 6 tests), production topology, contract check, and authenticated shell Playwright.
- Pristine-clone gate: `tools/verify/cold_clone.sh verify-E3-T02a` passed from a clean
  clone of exact HEAD `084037f`, pinned emulator commit
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, scrubbed environment, verified local pnpm
  store, and loopback-only networking.
- Product evidence: two isolated worlds; unauthenticated redirects; log-neutral typed
  whoami refusal; authorization-code + PKCE login; independently replayed identity triple
  at offset `0000000000000000_0000000000000370`, digest
  `7ccf4d7ccc97cf5584fe3a77064e8f2206075708282c1b6344a52206dcf6dd2a`;
  partial-triple sweep; one-document SPA navigation, deep link, 404, API/auth/traversal
  refusal, logout; zero console errors, page errors, failed requests, storage leaks, and
  non-loopback observations.
- Stream artifacts: parent evidence
  `E3-T02-app-shell-browser-verify/evidence/e3-t02-shell-playwright.txt`,
  `e3-t02-whoami-neutrality.txt`, `e3-t02-identity-replay.jsonl`, and
  `e3-t02-independent-digest.txt` were regenerated by the exact-head gate and reproduced
  in the pristine clone.
- Replay: N/A (tenant policy rejected export of private local bundles/runtime metadata
  before Replay Chromium launched) + mitigation: exact-head and pristine-clone
  Playwright runs with persistent zero-error telemetry, independently replayed stream
  digest, and previously critic-accepted unchanged-app recording
  `https://app.replay.io/recording/5d13ecd8-424f-4c7e-9e2a-b18ef0ad9685`.
  Historical same-session MP4 `recordings/e3-t02-run15.mp4` is supporting context only,
  SHA-256 `d3f4834f6f82a7cd262eb6ae3237148d8f2525a24a15b9db3ff34452bc2dedb7`;
  it is not presented as fresh exact-head evidence.
- Claim: the independently named A gate proves only the authenticated shell, whoami,
  SPA, DOM-triple, and core tripwire contract. It makes no claim that the credential
  scanner or Replay publication lifecycle is sound; those inherited findings remain
  assigned to blocked successor E3-T02b.
