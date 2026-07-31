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
- Replay: N/A (tenant policy rejected a new Replay QA tunnel run because sending local runtime data to the external service is denied; direct Replay MCP URL/MP4 is unavailable) + mitigation: focused Replay-Chromium/Playwright transcript, canonical event-log replay, mixed-character ordering regression, controlled in-session abort/reconnect recovery, and tamper sensitivity verifier.

### 2026-07-31 — critic — VERDICT: refuted

- File paths containing spaces were not covered by the original row parser; the implementation now derives rows directly from the shared reducer state maps, preserving `docs/my file.md` exactly.
- The original journey did not exercise a populated-directory rename while inside that directory. The reworked journey navigates into `docs`, renames it to `archive-docs`, and verifies the nested view empties while the final replay digest advances.
- The reworked evidence contains 16 events and 7 final rows and must be re-criticized after the updated branch is pushed.

### 2026-07-31 — builder — rework

- Rows now use the same raw segment comparator as `StreamFS.listTree`, with mixed-case/accented directory regression coverage (`B`, `a`, `z`, `ä`).
- The focused browser journey now forces a reconnect by reloading during the live tail, waits for the stream to return `live`, and verifies the delete state and final canonical digest after recovery. The expected in-flight poll abort is recorded as part of that reconnect proof.

### 2026-07-31 — critic — VERDICT: refuted (remaining)

- Ordering parity is cleared: `compareTreePaths` mirrors `StreamFS.listTree`, with mixed `B`, `a`, `z`, `ä` coverage.
- Replay policy waiver is explicit above, with Loop QA and stream-layer mitigation.
- Remaining gap: the browser proof uses reload-based recovery rather than a transient `/events` failure observing `data-stream-status="reconnecting"` in the mounted hook around each mutation. Keep this task `in-progress` until controlled reconnect evidence is recorded or the acceptance scope is explicitly revised.

### 2026-07-31 — builder — rework 2

- `apps/web/test/file-tree.pw.ts` now installs a transient in-session long-poll abort before each delete, recreate, and directory rename. Each mutation asserts `data-stream-status="reconnecting"`, removes the fault, waits for `live`, and then checks the updated DOM and final independent replay digest. The transcript records four `reconnecting->live=true` recoveries without document navigation.
- Focused evidence: `E3_T06_INDEPENDENT_REPLAY_OK events=20 rows=11`; final checkpoint `0000000000000000_0000000000000019`; final digest `f2a92aeccdab1de5f8d6deda7f30f1d754efb79de443a379641f07247fb2012f`.

### 2026-07-31 — builder — rework 3

- The journey now activates the docs directory with keyboard `Enter`, holds a bootstrap projection to assert the accessible loading state, injects a malformed bootstrap response to assert the `role=alert` refusal state, then recovers to `live`.
- Final transcript includes `loading-state visible=true keyboard-docs=true` and `refusal-state role=alert visible=true recovery=live`, in addition to four controlled `reconnecting->live=true` mutation recoveries.

### 2026-07-31 — critic — VERDICT: refuted (evidence contradiction)

- The behavior coverage is complete, but `evidence/e3-t06-browser.txt` reported `final rows=4` while the cited final event log replay reported 11 canonical `listTree` rows. The journey was still inside the renamed directory, so the transcript did not identify the displayed DOM state. Re-record with a derived/asserted displayed row count and report the canonical total separately.

### 2026-07-31 — builder — rework 4

- `independentTree()` now records the canonical `listTree` row count from the same final replay used for the digest. The browser journey asserts the actual displayed row count after the populated-directory rename and records `final displayedRows=0 canonicalRows=11`, eliminating the contradictory hard-coded total.
- Focused evidence was regenerated in this rework; the verifier still reports `E3_T06_INDEPENDENT_REPLAY_OK events=20 rows=11` and rejects the tampered event log.

### 2026-07-31 — critic — VERDICT: verified

- Commit: `2b0bf2d`; fresh critic review confirms the final transcript and replay evidence agree. The browser proof covers mixed-character ordering, spaced paths, keyboard navigation, loading/refusal/recovery UI, four controlled reconnects, populated-directory rename while nested, no document navigation, digest/checkpoint parity, and no direct Electric/stream endpoint access.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `make --no-print-directory _v-e3-t06`, and `node tools/verify/e3_t06_evidence.mjs` (all passed). The independent verifier reports `E3_T06_INDEPENDENT_REPLAY_OK events=20 rows=11` and rejects a tampered event log.
- Replay: N/A (tenant policy rejected a new Replay QA tunnel run because sending local runtime data to the external service is denied; direct Replay MCP URL/MP4 is unavailable) + mitigation: focused Replay-Chromium/Playwright transcript, canonical event-log replay, controlled in-session abort/reconnect recovery, and tamper sensitivity verification.

### 2026-07-31 — cold-clone gate — refuted (harness race)

- The pristine clone of `2b0bf2d` passed the 39-file/447-test suite and dependency gates, then failed E3-T06 with `route.continue: Route is already handled!` in the shared `openGuardedPage` context route while page-level route handlers were active. This was a test-harness routing race, not an application assertion.

### 2026-07-31 — builder — rework 5

- Page-level E3-T06 interceptors and the shared browser guard now use Playwright `route.fallback()` so layered handlers compose without double-handling a request; abort and fulfill branches remain terminal.
- The focused target passes again with the same transcript and independent replay result. The task remains `in-progress` until a fresh pristine-clone run and critic review clear the harness fix.
