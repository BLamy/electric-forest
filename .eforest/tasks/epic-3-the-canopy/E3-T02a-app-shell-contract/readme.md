---
id: E3-T02a
epic: 3
title: "Authenticated app shell: session-backed whoami, SPA routing, and frozen DOM stream-triple contract"
priority: 302
status: in-progress
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

### 2026-07-29 — human resume — RECOVERY 3 RUNS 17-19 authorized

- Authorization: APPROVED
- Task: E3-T02a
- Recovery generation: 3
- Stopped after run: 16
- Authorized runs: 17-19
- Scope: lineage-preserving E3-T02 decomposition and E3-T02a verification only

### 2026-07-29 — split validation — PENDING IMPLEMENTATION

- Parent coverage assigned here: app serving, auth/whoami, identity provenance, SPA
  routing, DOM triple, browser-verify core, and the product-specific portions of the
  original shell evidence.
- Fresh proof required: all acceptance checks above, exact-head gate, cold clone, and
  browser recording. No parent green receipt verifies this child.
