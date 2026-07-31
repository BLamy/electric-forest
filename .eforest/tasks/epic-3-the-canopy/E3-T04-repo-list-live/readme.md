---
id: E3-T04
epic: 3
title: "Live repository and organization browse from the registry event stream"
priority: 304
status: implemented
depends_on: [E3-T03]
estimate: M
capstone: false
---

## Goal

The authenticated web app renders the current user's repository list and organization
browse by reducing the E2-T08 registry stream through `useStreamReducer`. New
repositories appear through live application events. Private repositories never enter a
cross-tenant browser payload.

## Deliverables

- Repository-list and organization routes in `apps/web`.
- One shared registry reducer imported by projector, CLI replay, and browser.
- Stable sorting, empty/loading/refusal states, and DOM checkpoint/digest attributes.
- Two-browser live-add and private-visibility tests.

## Acceptance criteria

- [ ] Initial rows and digest equal independent replay of the authorized registry range.
- [ ] A newly created repository appears without navigation or reload.
- [ ] Anonymous/non-member payloads contain no private repository identifiers or counts.
- [ ] DOM checkpoint and digest advance to the event observed in the Replay recording.
- [ ] No database, side cache, or browser-local persistence feeds either list.

## Adversarial verification

1. Create public and private repos concurrently in two organizations.
2. Inspect response bodies and browser state for private-name leakage.
3. Drop/reconnect the live feed and compare rows to independent replay.
4. Mutate the registry reducer in a scratch worktree; the digest/browser gate must fail.

## Verification log

(appended by builder and critic)

### 2026-07-30 — builder — CLAIM: implemented

- Implementation commit: `f00de0f0f6204a4c9c0e020f8c9f2700780f821f`.
- Focused registry validation: `pnpm --filter @eforest/platform test -- registry.test.ts`
  passed all 19 registry tests.
- Full local gauntlet: `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test`, and `pnpm build` passed (38 test files, 437 tests).
- Browser and stream proof: `make verify-E3-T04` passed 30 focused tests plus the
  two-client Playwright run. Both clients converged without reload at checkpoint
  `0000000000000000_0000000000000003` and digest
  `660090db9949ddc8e0f247e4d7040114b00ace19a9f207fa1a57613c4c2415b2`;
  independent CLI replay produced the same digest. The forced reconnect succeeded,
  response-body scans found none of the hidden private repository identifiers or owner,
  and console, page, and request-failure counts were all zero.
- Standing browser proof: `make verify-E3-T02` passed after the repository routes landed,
  including the authenticated SPA navigation/deep-link checks and zero-error tripwires.
- Cold-clone proof: `tools/verify/cold_clone.sh verify-E3-T04` passed from a pristine
  clone at `f00de0f0f6204a4c9c0e020f8c9f2700780f821f`, including format, lint, typecheck,
  437 tests, build, emulator checks, and the E3-T02, E3-T03, and E3-T04 browser gates.
- Evidence: `evidence/e3-t04-authorized-registry.jsonl`,
  `evidence/e3-t04-browser.txt`, and `evidence/e3-t04-digest.txt`.
- Replay: N/A (Replay CLI is not authenticated and the installed CLI exposes no MCP
  command) + mitigation: the committed authorized registry event log, exact independent
  replay digest, two-client Playwright convergence run with response-body leak scans,
  forced reconnect, zero browser errors, frozen digest sensitivity, and pristine-clone
  verification.

The recorded stream evidence and browser transcript demonstrate that the web app derives
the authorized repository and organization views from the shared registry reducer, adds a
new repository live on two clients without navigation or reload, preserves convergence
across a dropped/reconnected feed, and does not expose hidden cross-tenant private
identifiers or counts. No database, browser persistence, or side cache feeds the lists.
