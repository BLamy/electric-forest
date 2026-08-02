---
id: E3-T10
epic: 3
title: "Capstone: the reading room on official Durable Streams"
priority: 310
status: verified
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

- [x] Every Epic 3 route is reached through real pointer/keyboard interactions.
- [x] The second session's edit appears without reload and advances the displayed
      application checkpoint/digest to independent replay parity.
- [x] Private cross-tenant repository data never appears in network or DOM state.
- [x] Branch switch, live tree, file content, and history remain mutually consistent.
- [x] The browser talks only to the platform origin; the platform uses the official
      client/server boundary and can select Electric Cloud by configuration.
- [x] Replay point links/MP4 are explicitly N/A because Replay MCP preflight fails;
      stream offsets and digest evidence are recorded with the Playwright mitigation.

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

### 2026-08-02 — critic — VERDICT: refuted

- Final tree parity — FAILED. The recorded `mainTree` snapshot stops at checkpoint
  `0000000000000000_0000000000000005` (the pre-edit six-event stream), while the
  committed `mainFile` and `mainHistory` snapshots include the seventh live-edit
  event at checkpoint `0000000000000000_0000000000000006`. Replaying all seven
  official main-stream records produces a different tree digest (`14e3a1…`) than
  the cited tree digest (`f773d4…`). The evidence contradicts the criterion that
  tree, file, and history remain mutually consistent.
- Live-edit advancement — INSUFFICIENT. The browser run never retained or compared
  the initial file checkpoint/digest with the edited checkpoint/digest, so it did not
  prove that the displayed checkpoint advanced after the second-session write.
- Coverage — INSUFFICIENT. The run did not capture a final main-tree projection after
  the live edit, did not compare it with the final file/history, and only checked the
  private repository text on the registry surface rather than every later DOM view.
  The platform-origin assertion filtered to `/api/` and `/registry/` requests rather
  than checking every browser request.
- The recursive `make verify-E3-T10` target also hit an upstream E3-T03 browser
  timeout at `apps/web/test/stream-reducer.pw.ts:115`; the isolated E3-T10 target and
  independent verifier passed, but the recursive failure remains separately reported.
- Replay: N/A (`tools/replay/preflight.sh` fails because `npx -y replayio mcp` returns
  `error: unknown command 'mcp'`) + mitigation: Playwright/Replay Chromium browser
  observations plus committed stream replay; no MP4 or Replay point link exists.

Commands: `make --no-print-directory _v-e3-t10`; `node tools/verify/e3_t10_evidence.mjs`;
`make --no-print-directory verify-E3-T10` (upstream E3-T03 timeout).

### 2026-08-02 — builder — rework implemented

- Commit: `dff2baac` (`fix(e3-t10): re-record final projection parity`). The browser
  journey now captures the initial file projection and the post-edit file/tree
  projections, asserts monotonic checkpoint/digest advancement, compares the final
  tree's `docs/readme.md` metadata with the edited file, and compares final history
  event shapes with the final tree. Privacy scans cover registry, repository home,
  main file/tree, feature tree/file, and history DOM surfaces. Post-login browser
  requests are platform-origin-only, allow only the fixture identity origin during
  login, and reject direct `/streams/` traffic.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `CI=true pnpm test`
  (44 files, 473 tests), and `pnpm build` all passed. `make --no-print-directory
  _v-e3-t10` and `node tools/verify/e3_t10_evidence.mjs` both passed.
- Final stream evidence: main tree checkpoint
  `0000000000000000_0000000000000006`, digest
  `14e3a1d784529e8934a7f1f68fc97794f5be9e6ab95e84afaef74619737f4707`; the edited
  file advances from checkpoint `...0006` / digest `d9a819…` to checkpoint `...0007`
  / digest `9252b6…`; seven official main events replay identically in tree and
  history. The browser transcript records `runtime-browser-requests=121`,
  `console-errors=0`, and `page-errors=0`.
- Teardown note: the harness can print two `AuthzViewUnavailableError` stacks while
  pending long-poll requests are torn down after the browser assertions; these occur
  after the transcript is written and do not appear as browser console/page errors.
- Replay: N/A (the machine's `tools/replay/preflight.sh` still fails because
  `npx -y replayio mcp` returns `error: unknown command 'mcp'`) + mitigation: Replay
  Chromium/Playwright browser observations and independent committed-stream replay;
  no MP4 or Replay point link exists. The recursive target remains separately
  affected by an upstream E3-T03 browser timeout before the capstone; the isolated
  capstone target is green.

### 2026-08-02 — critic — VERDICT: verified

- Final evidence now independently replays pre/post live-edit checkpoints, final tree
  digest `14e3a1…`, file/history parity, all-surface privacy, and platform-origin
  application requests with no direct stream requests. The final tree contains all
  seven official main-stream records, and the file checkpoint advances
  `...0006` → `...0007`.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `CI=true pnpm test`, `pnpm build`,
  `make --no-print-directory _v-e3-t10`, and `node tools/verify/e3_t10_evidence.mjs`
  pass. Suite promotion: retain the hardened browser journey and independent
  verifier as regression coverage.
- Replay remains the declared N/A fallback with the Playwright/stream-replay
  mitigation. The recursive verification timeout is upstream of E3-T10 and does not
  refute the isolated capstone evidence.
