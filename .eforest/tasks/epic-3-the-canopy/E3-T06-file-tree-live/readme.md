---
id: E3-T06
epic: 3
title: "Live StreamFS tree browser with deterministic digest"
priority: 306
status: in-progress
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

- Commit: `5731a54`; status is `in-progress` pending the fresh critic re-review.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `make --no-print-directory verify-E3-T06`.
- Stream evidence: `evidence/e3-t06-events.jsonl` (20 canonical events), `evidence/e3-t06-digests.json`, and `evidence/e3-t06-browser.txt`. Independent replay reports `E3_T06_INDEPENDENT_REPLAY_OK events=20 rows=11`; the tampered parent-directory event is rejected.
- Browser evidence: Replay QA project `proj-electric-forest-ms8w0nv1`, reworked journey `journey-ms97ufeg-tu14`, test run `run-ms97ugd5-vun8` (focused journey; no exploration). The run exercises root and `docs` navigation, the spaced filename `my file.md`, live rename/delete/recreate, populated-directory rename while nested, stale-name removal, no-reload mutation updates, reducer version 2, repository projection requests, and console/network assertions.
- Claim: the tree route renders the canonical StreamFS projection with deterministic direct-child rows, exposes checkpoint and digest attributes, supports accessible pointer/keyboard directory navigation and loading/refusal states, and follows live mutations without a document navigation or direct Electric/stream endpoint access.
- Replay: N/A (tenant policy rejected a new Replay QA tunnel run because sending local runtime data to the external service is denied; direct Replay MCP URL/MP4 is unavailable) + mitigation: focused Replay-Chromium/Playwright transcript, canonical event-log replay, mixed-character ordering regression, explicit reload/reconnect recovery, and tamper sensitivity verifier.

### 2026-07-31 — critic — VERDICT: refuted

- File paths containing spaces were not covered by the original row parser; the implementation now derives rows directly from the shared reducer state maps, preserving `docs/my file.md` exactly.
- The original journey did not exercise a populated-directory rename while inside that directory. The reworked journey navigates into `docs`, renames it to `archive-docs`, and verifies the nested view empties while the final replay digest advances.
- The reworked evidence contains 16 events and 7 final rows and must be re-criticized after the updated branch is pushed.

### 2026-07-31 — builder — rework

- Rows now use the same raw segment comparator as `StreamFS.listTree`, with mixed-case/accented directory regression coverage (`B`, `a`, `z`, `ä`).
- The focused browser journey now forces a reconnect by reloading during the live tail, waits for the stream to return `live`, and verifies the delete state and final canonical digest after recovery. The expected in-flight poll abort is recorded as part of that reconnect proof.
