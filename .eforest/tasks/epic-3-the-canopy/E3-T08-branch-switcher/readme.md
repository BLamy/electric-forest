---
id: E3-T08
epic: 3
title: "Branch switcher over Electric native forks with isolated projections"
priority: 308
status: verified
depends_on: [E3-T07]
estimate: M
capstone: false
---

## Goal

Tree and blob routes switch between repository branches by rebinding
`useStreamReducer` to the selected native-fork-backed StreamFS streams. The UI exposes
parent/fork application checkpoints and keeps branch histories isolated.

## Deliverables

- Accessible branch selector shared by tree and blob routes.
- Per-stream checkpoint retention for fast switch-back without from-zero replay.
- Diverged fixture and rapid-switch/reconnect browser tests.
- DOM branch, parent, fork-checkpoint, head-checkpoint, and digest attributes.

## Acceptance criteria

- [ ] Switching changes the route and both metadata/content projections atomically.
- [ ] Branch-specific edits never leak to another branch before a merge event.
- [ ] Switching back resumes from the saved application checkpoint and converges.
- [ ] Displayed ancestry and digests equal independent replay of each official stream.
- [ ] Rapid switches cannot apply a late frame from the previously selected branch.

## Adversarial verification

1. Alternate branches while both receive writes and network reconnects.
2. Delay frames from the old branch until after rebinding.
3. Navigate to a path that exists on only one branch.
4. Compare each settled DOM digest with its branch dump.

## Verification log

(appended by builder and critic)

### 2026-08-02 — builder/critic — VERDICT: verified

- Commit `3327645` adds the shared accessible branch selector, native-fork projection resolver, branch-aware blob sidecars, retained per-stream reducer checkpoints, and route-keyed rebinding. The browser journey exercises every acceptance attack: delayed feature frames are ignored after switching back, branch-only content never appears on `main`, feature-owned bytes are selected without parent leakage, both branches receive writes across a forced reconnect, and a rapid switch-back resumes the retained checkpoint. Evidence: `evidence/e3-t08-browser.txt`.
- Stream evidence: `evidence/e3-t08-events.json` contains canonical main/feature dumps; `evidence/e3-t08-digests.json` records the DOM/replay digests. `node tools/verify/e3_t08_evidence.mjs` independently replays both dumps, checks contiguous offsets and exact tree digests, and rejects a one-field tamper (`orphaned path`).
- Gates: `make --no-print-directory _v-gates` (format, lint, typecheck, 42 test files / 461 tests, build) passed; `make --no-print-directory _v-e3-t08` (13 focused tests, browser journey, independent verifier) passed; `git diff --check` passed. The recursive `make verify-E3-T08` was also attempted; its inherited E3-T07 browser script printed its complete proof but held a stale process open, so that harness was interrupted and the required gates plus E3-T08 target were rerun directly and passed.
- Browser evidence: Playwright/Replay Chromium fallback recorded zero console errors and zero page errors, with expected route-abort counts only from deliberate route unmounts. Replay: N/A (preflight authenticated the CLI and Replay Chromium, but `npx -y replayio mcp` failed with `error: unknown command 'mcp'`) + mitigation: Playwright browser assertions and independent stream replay are committed above. See `evidence/e3-t08-replay.txt`.
