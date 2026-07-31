---
id: E3-T06
epic: 3
title: "Live StreamFS tree browser with deterministic digest"
priority: 306
status: implemented
depends_on: [E3-T05]
estimate: M
capstone: false
---

## Goal

The tree route reduces a branch's StreamFS metadata events through
`useStreamReducer` and the canonical `@eforest/streamfs` reducer. Directory
navigation, renames, deletes, and recreates update live while the DOM exposes the exact
application checkpoint and tree digest.

## Deliverables

- Branch/path tree route and deterministic row selector.
- Shared StreamFS reducer; no browser-specific filesystem implementation.
- Keyboard/pointer navigation and accessible loading/error states.
- Live rename/delete/recreate browser scenario.

## Acceptance criteria

- [ ] Rows are segment-wise deterministic and match `StreamFs.listTree` over the same
      replay range.
- [ ] Tombstoned paths are absent; rename and recreate semantics match CLI replay.
- [ ] Live mutations render without document navigation or full projection reset.
- [ ] DOM tree digest equals independent StreamFS replay at the displayed checkpoint.
- [ ] No direct Electric credentials or retired custom endpoints appear in the browser.

## Adversarial verification

1. Rename a populated directory while the route points inside it.
2. Delete/recreate a path and verify stale file ids never reappear.
3. Reconnect around each mutation and compare final canonical trees.
4. Break one reducer operation in a scratch worktree; the digest gate must fail.

## Verification log

(appended by builder and critic)

### 2026-07-31 — builder — IMPLEMENTED

- Commit: pending (this worktree); status is `implemented` after the independent critic pass.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `make --no-print-directory verify-E3-T06`.
- Stream evidence: `evidence/e3-t06-events.jsonl` (13 canonical events), `evidence/e3-t06-digests.json`, and `evidence/e3-t06-browser.txt`. Independent replay reports `E3_T06_INDEPENDENT_REPLAY_OK events=13 rows=6`; the tampered parent-directory event is rejected.
- Browser evidence: Replay QA project `proj-electric-forest-ms8w0nv1`, journey `journey-ms96nnp0-t0mh`, test run `run-ms96noqi-7mw3` (focused journey; no exploration). The run exercises root and `docs` navigation, live rename/delete/recreate, stale-name removal, no-reload mutation updates, reducer version 2, repository projection requests, and console/network assertions.
- Claim: the tree route renders the canonical StreamFS projection with deterministic direct-child rows, exposes checkpoint and digest attributes, supports accessible pointer/keyboard directory navigation and loading/refusal states, and follows live mutations without a document navigation or direct Electric/stream endpoint access.
- Replay: N/A (Replay QA tunnel journey is the browser artifact; direct Replay MCP recording URL was not returned) + mitigation: focused Playwright/Replay-Chromium transcript plus canonical event-log replay and tamper sensitivity verifier.
