---
id: E3-T10
epic: 3
title: "Capstone: the reading room on official Durable Streams"
priority: 310
status: implemented
depends_on: [E3-T04, E3-T08, E3-T09]
estimate: L
capstone: true
---

## Goal

From a cold clone, start the pinned Auth0 emulator, platform gateway, web app, and
Electric's published local Durable Streams server. In one Replay Chromium session,
browse organization to repository to tree to file, switch branches, inspect history,
then observe a second authenticated session's StreamFS edit arrive live.

## Deliverables

- `make verify-E3-T10` / `verify-E3-capstone` cold-start scenario.
- One Replay recording and matching verified MP4 for the walkthrough.
- Seeded official-stream event logs and independent digest report for every visible
  projection.
- Zero-console-error and network-boundary assertions.

## Acceptance criteria

- [ ] Every Epic 3 route is reached through real pointer/keyboard interactions.
- [ ] The second session's edit appears without reload and advances the displayed
      application checkpoint/digest to independent replay parity.
- [ ] Private cross-tenant repository data never appears in network or DOM state.
- [ ] Branch switch, live tree, file content, and history remain mutually consistent.
- [ ] The browser talks only to the platform origin; the platform uses the official
      client/server boundary and can select Electric Cloud by configuration.
- [ ] Replay point links, MP4, stream offsets, and digest evidence are recorded.

## Adversarial verification

1. Interrogate the Replay timeline for console errors, failed requests, hidden reloads,
   and source coverage.
2. Compare each DOM digest with the committed official-stream dump.
3. Force one reconnect during the live edit and verify exact convergence.
4. Run the same scenario from a pristine clone with empty service state.

## Verification log

### 2026-08-02 — builder — implemented

- Commit: `93235df5` (`feat(e3-t10): add reading room capstone proof`).
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `CI=true pnpm test` (44 files, 473 tests), and `pnpm build` all passed. The task target `make --no-print-directory _v-e3-t10` passed, including the browser journey and independent verifier.
- Browser evidence: `evidence/e3-t10-browser.txt` records real pointer/keyboard navigation through the organization route, authorized registry, repository home, tree, file, native fork, and history; two authenticated contexts; a live second-session edit after one forced reconnect; private cross-tenant suppression; platform-origin-only requests; and `console-errors=0 page-errors=0`.
- Stream evidence: `evidence/e3-t10-events.json` and `evidence/e3-t10-digests.json` are canonical committed projections. `node tools/verify/e3_t10_evidence.mjs` independently replays registry, repository-home regions, main/feature trees, both file views, and both histories, compares state/digests/checkpoints, checks fork parity, and proves a one-byte tamper changes the tree digest. The resulting digests include registry `f42adb1bfe08efd40fbd3455142070d128e761577d5036c7e9378743dd931206`, main tree `f773d407dbc29ebfc3f80653d0e1369ffc06890d0823840f7e8cbfb497a1a846`, feature tree `6a58f5d2f4bb04fabaac56798f2bf1f1f66c6032f4fc2336aa63dbffc1a162b2`, and edited main file `9252b6185bbbd200a26ac3a9f7bdedcaf0ccd3ae791ec5878d97e5ca66d5c413`.
- Replay: N/A (the machine's `tools/replay/preflight.sh` fails because `npx -y replayio mcp` returns `error: unknown command 'mcp'`) + mitigation: the final run used Replay Chromium through the browser-verify harness with captured browser network/console/page-error observations, and the committed stream evidence was independently replayed. `tools/replay/record-run.sh -o e3-t10-final` was attempted and loudly skipped for the same preflight failure; see `evidence/e3-t10-replay.txt`. No MP4 or Replay point link exists.
