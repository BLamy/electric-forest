---
id: E3-T07
epic: 3
title: "Live patch-aware file viewer over canonical StreamFS events"
priority: 307
status: verified
depends_on: [E3-T06]
estimate: L
capstone: false
---

## Goal

The blob route resolves a path through StreamFS metadata and folds its per-file content
stream through the canonical content reducer. Full writes and text patches appear live
through `useStreamReducer`; patch base/result digests are enforced by shared
application code.

## Deliverables

- File-viewer route with metadata and content projections.
- Shared patch application and content digest implementation.
- Binary/oversize/error states that never silently coerce bytes.
- Two-session live patch and full-write fallback scenarios.

## Acceptance criteria

- [x] Rendered bytes and digest equal independent replay at the displayed checkpoint.
- [x] Valid patches and fallback writes update without reload.
- [x] Wrong-base, wrong-result, truncated, or reordered patches fail visibly and do not
      corrupt rendered state.
- [x] Rename keeps the same file identity; delete removes the open file deterministically.
- [x] The browser contains no second patcher, hasher, or stream transport.

## Adversarial verification

1. Race a patch with rename and delete operations.
2. Corrupt each patch digest independently.
3. Force reconnect before and after the patch frame.
4. Compare browser bytes, CLI materialization, and replay digest exactly.

## Verification log

(appended by builder and critic)

### 2026-08-02 — builder — implemented

- Commits: `6504c86` (`feat(e3-t07): add live patch-aware file viewer`) and `a8765d5` (`test(e3-t07): cover two live viewer sessions`).
- Gates: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`; and `make --no-print-directory verify-E3-T07`. The composed gate completed with 41 test files and 458 tests passing, followed by the focused E3-T07 suite (3 files, 14 tests), browser journey, and evidence verifier.
- Stream evidence: `evidence/e3-t07-events.jsonl` contains 17 canonical projection events through checkpoint `0000000000000000_0000000000000016`; independent replay and the final projection both produce digest `4f14e1dab217e7e25b9ffdb4503809adab1f61636ffd9828687df8f0b9b39af6`. `evidence/e3-t07-digests.json` records exact byte digests for initial, patch, fallback, rename, binary, and oversize states.
- Browser evidence: `evidence/e3-t07-browser.txt` demonstrates initial text, two-session convergence, live patch, reconnect, full-write fallback, rename identity preservation, patch-after-rename, delete tombstone, binary/oversize refusal, corrupt-base refusal, zero direct `/streams/` requests, and 28 authorized projection requests. The Replay-Chromium MP4 is `recordings/e3-t07-final.mp4` (same-session capture source `recordings/e3-t07-final.capture.webm`).
- Replay: N/A (the machine's Replay MCP preflight fails because `npx -y replayio mcp` reports `unknown command 'mcp'`, and lifecycle recording `e6e83590-08cc-4946-ae7d-b1a608db5666` remained `recording` through the upload wait) + mitigation: verified Replay-Chromium MP4 plus Playwright console/network interrogation and the committed stream-layer independent replay evidence above. Details are in `evidence/e3-t07-replay.txt`.

### 2026-08-02 — critic — VERDICT: verified

- Falsification: predicted the displayed bytes and `data-state-digest` would equal an independent reducer replay at the final checkpoint; observed exact equality for digest `4f14e1dab217e7e25b9ffdb4503809adab1f61636ffd9828687df8f0b9b39af6` in `evidence/e3-t07-browser.txt` and `evidence/e3-t07-events.jsonl`.
- Adversarial paths: wrong base/result, truncated and reordered patch cases, reconnect-before/after mutation, rename/delete races, binary bytes, oversize bytes, malformed encoded separator, and NUL path all passed their visible refusal or preservation assertions. No changed browser transport opened `/streams/`; the journey observed only the authorized projection route.
- Coverage: the reducer, gateway projection join, SPA deep-link handling, route rendering, binary/oversize/error branches, path validation, and two independent live viewer contexts are exercised by the focused tests and browser journey. CSS and package/verify wiring are configuration/presentation changes covered by the same build and browser gates.
- Suite: promoted `file-content` reducer tests, gateway projection tests, SPA deep-link regression, canonical event/digest fixtures, and `verify-E3-T07`/cold-clone target. No finding refuted the claim.
- Commands: `git diff --check`; `pnpm exec vitest run packages/reducers/src/file-content.test.ts packages/platform/test/file-viewer.test.ts packages/platform/test/spa.test.ts`; `node tools/verify/e3_t07_evidence.mjs`; `make --no-print-directory verify-E3-T07`.
