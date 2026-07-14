---
id: E2-T07
epic: 2
title: "Platform authorization: per-repository read, follow, and dispatch decisions before official-stream access"
priority: 207
status: pending
depends_on: [E2-T05, E2-T06]
estimate: L
capstone: false
---

## Goal

Every application operation is authorized in `@eforest/platform` before the official
Durable Streams client is invoked. A pure decision function joins the E2-T01 identity
view with the E2-T06 namespace view and decides `read`, `follow`, or `dispatch` for
a logical repo/branch stream. Electric owns stream transport; electric-forest owns who
may ask the platform to use it.

Public repositories permit anonymous reads and follows. Private repositories require
membership or a scoped read grant. Every write requires a branch-scoped write grant.
Refusals reveal no private-stream existence and append nothing.

## Deliverables

- `packages/platform/src/authz/decide.ts`: one total, pure authorization function.
- Gateway integration for application reads, live follows, and `POST /api/dispatch`.
- Stable public/private not-found behavior and typed refusal taxonomy.
- A real-HTTP matrix using Auth0 emulator identities and the official Durable Streams service.
- Golden decision and no-side-effect transcripts.

## Acceptance criteria

- [ ] The pure matrix covers anonymous, member, non-member, admin, read-grant,
      write-grant, revoked-grant, public, and private combinations.
- [ ] Every gateway operation calls the same decision function before using
      `@durable-streams/client`.
- [ ] Private unauthorized and nonexistent resources are indistinguishable.
- [ ] A refused read, follow, or dispatch performs no official-stream operation and
      leaves all logs unchanged.
- [ ] Grant revocation takes effect at the next replayed identity-view offset without
      restarting the platform.
- [ ] `make verify-E2-T07` passes from a cold clone against the pinned Auth0 emulator
      and published Durable Streams server.

## Adversarial verification

1. Enumerate every platform route that can resolve a stream; any route bypassing
   `authorize` refutes the task.
2. Race grant revocation with a dispatch and prove the accepted/refused result cites the
   exact identity-view offset used for the decision.
3. Probe private ids, malformed ids, encoded separators, and cross-tenant ids; any
   existence oracle or append is a refutation.
4. Search for authorization changes inside `@eforest/server` or copied Durable Streams
   code; those changes are out of bounds.

## Verification log

(appended by builder and critic)
