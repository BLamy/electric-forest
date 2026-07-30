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

### 2026-07-29 — critic — VERDICT: needs-evidence

- P1 out-of-band stream advance — INSUFFICIENT. Predicted the A gate would dispatch an
  identity event after the initial authenticated render, reload the shell, and prove that
  the DOM offset and digest both advance to the independently replayed state at the new
  stated offset. Observed `apps/web/test/shell.pw.ts:253-285` prove only the initial
  post-login snapshot; the remainder of the suite never dispatches an out-of-band
  identity event or reloads the authenticated shell. The committed transcript therefore
  has one `region ... cli-replay=head` line and no before/after advance. Demand: add the
  required out-of-band event, reload, truncated replay, literal new offset/digest parity,
  and a committed before/after receipt to `verify-E3-T02a`.
- P2 default-tripwire sensitivity — INSUFFICIENT. Predicted the exact A target would
  execute expected-red controls for `console.error`, `pageerror`, `requestfailed`, each
  independently missing/corrupt triple attribute, a wrong-stream digest, and SPA/API
  fallback sabotage. Observed `make -n _v-e3-t02a` executes only the static contract
  check, production probe, and clean `shell.pw.ts`; the contract check searches source
  text but does not damage the apparatus. The only committed shell sensitivity receipt,
  `evidence/e3-t02-sensitivity.md`, was produced at historical candidate `312eca7` and
  covers only mount console error, stale offset, and false digest. It does not cover the
  other acceptance classes and was not re-earned by the A gate. Demand: promote every
  named sensitivity into a deterministic A-owned verifier, prove clean control green and
  every mutation red against the exact production harness, and include it in
  `verify-E3-T02a`.
- Product clean control and stream parity — PASSED but do not close the missing attacks.
  The claimed exact-head and pristine-clone runs are commit-bound to `084037f`; the
  committed clean transcript covers two isolated worlds, typed/log-neutral whoami
  refusals, PKCE login, independently sourced identity, initial complete DOM triple,
  SPA/deep-link/404/traversal/logout behavior, and zero observed console/page/request
  failures. Independent replay of
  `evidence/e3-t02-identity-replay.jsonl` through
  `packages/identity/reducer.mjs` reproduced
  `7ccf4d7ccc97cf5584fe3a77064e8f2206075708282c1b6344a52206dcf6dd2a`,
  and its file SHA-256 reproduced
  `3685a86f6601f52e1194c93d143fbfa25c4515ef93f2fd004bf33f6b14f27267`.
  This critic's nested outer loopback wrapper was unavailable under the host sandbox,
  so the independently attempted inner root gate failed only where local servers could
  not start; that environmental result does not contradict the separately passed
  loopback exact-head and pristine-clone receipts.
- Decomposition, lineage, and dependency safety — PASSED. The cancelled parent preserves
  its append-only runs 1-16 ledger; all open scanner/publication findings are explicitly
  inherited by E3-T02b; E3-T02b depends on E3-T02a; and E3-T03 depends on E3-T02b.
  Suffix-aware queue/workflow parsers, distinct verify targets, and cold-clone inventory
  are present, while B remains pending. The A gate still contains static compatibility
  assertions mentioning B-owned recorder/scanner code, but A neither claims nor relies
  on those assertions as positive evidence, so this is waived as conservative composite
  compatibility coverage rather than a scope refutation.
- Browser fallback — ACCEPTED for this evidence request. Replay: N/A (tenant policy
  rejected export before Replay Chromium launch) + mitigation: exact-head and
  pristine-clone Playwright/stream evidence plus the unchanged-app historical run-15
  Replay context. No fresh Replay URL is invented, and the historical MP4 is correctly
  declared supporting context only. The fallback does not replace the two missing
  deterministic acceptance attacks above.
- COVERAGE: clean shell/runtime paths and initial digest parity are exercised; the
  post-event reload path and the named destructive tripwire matrix are
  **needs-evidence**. SUITE: retain the committed clean stream dump/digest receipt;
  promote the advance receipt and complete A sensitivity matrix before resubmission.
  Lifecycle: E3-T02a returns to `in-progress`, E3-T02b remains `pending`, and the project
  remains `building`.

### 2026-07-29 — builder rework — CLAIM: implemented

- Rework base: critic verdict `680e7fe7e36118c197c1ccbfda830ec3d5c28c9c`.
- Focused command: `tools/verify/e2_t12_loopback.sh make --no-print-directory
  _v-e3-t02a` passed after the evidence additions.
- Advanced-state proof: after the initial DOM/CLI equality at offset
  `0000000000000000_0000000000000370`, the harness dispatched an out-of-band
  `identity.user.created`, rewrote only the sanitized proof receipt, reloaded the real
  SPA, and observed offset `0000000000000000_0000000000000550` with new digest
  `7b886f20d9fb8d4015a6e421588a589cedfb9ae0bb86812bcf7d0d245cf8271b`.
  Independent CLI replay of the newly committed JSONL reproduced that digest exactly;
  the dump SHA-256 is
  `29c491808b4372d868799cc7263563a63cfd59dc441d09decb299cff6ad961cc`.
- Expected-red matrix: removing each of stream/offset/digest independently is rejected as
  a partial region; wrong stream and wrong digest fail exact truth comparison; a fake
  reserved-route SPA fallback fails the 404+JSON invariant; real injected
  `console.error`, `pageerror`, and same-origin aborted request each make the default
  `GuardedPage.assertClean()` throw. The unsabotaged control remains clean.
- Apparatus binding: `tools/verify/e3_t02_contract_check.mjs` now requires the advanced
  reload and every expected-red marker, so removing these attacks makes
  `verify-E3-T02a` red.
- Updated evidence:
  `E3-T02-app-shell-browser-verify/evidence/e3-t02-shell-playwright.txt`,
  `e3-t02-identity-replay.jsonl`, and `e3-t02-independent-digest.txt`.
- Replay remains N/A under the already documented tenant-policy denial; this rework
  changes only deterministic Playwright/stream evidence and does not claim B's
  publication apparatus is sound.
