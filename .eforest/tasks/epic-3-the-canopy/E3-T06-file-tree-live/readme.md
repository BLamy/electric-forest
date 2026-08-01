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

### 2026-07-31 — critic — VERDICT: verified (harness re-review)

- Commit: `4be1be8`; the fresh critic confirms `route.fallback()` composes the shared request guard with the E3-T06 page interceptors, while intentional `abort()` and `fulfill()` branches remain terminal. The previous `Route is already handled` cold-clone failure is cleared without weakening assertions.
- Cold-clone evidence: `tools/verify/cold_clone.sh verify-E3-T06` passed from a pristine clone with 39 test files / 447 tests, all dependency gates, E3-T03/T04/T05, the E3-T06 browser journey, and `E3_T06_INDEPENDENT_REPLAY_OK events=20 rows=11`.
- Replay: N/A (the committed proof artifact remains covered by the tenant policy waiver for direct Replay upload) + mitigation: the focused Replay-Chromium/Playwright transcript, canonical replay/tamper verifier, cold-clone gate, and Replay QA journey `run-ms9b93tp-gs1s` through the ready project tunnel.

### 2026-07-31 — independent critic follow-up — VERDICT: refuted

- Encoded directory navigation contradicts the branch/path route claim. `Route` splits
  `window.location.pathname` without decoding its segments, while tree links percent-encode
  every directory segment. A canonical StreamFS directory such as `team docs/über` is
  therefore selected with the non-matching prefix `team%20docs/%C3%BCber` and renders empty.
- The terminal Replay QA recordings prove spaced filenames and ordinary ASCII directory
  navigation, but none navigates through a directory whose own name contains spaces or
  non-ASCII characters. The run named "spaced paths" only reaches `archive-docs/my file.md`.
- Demand: decode each route segment exactly once, fail closed on malformed escapes or an
  encoded path separator, and promote pointer plus keyboard navigation through spaced and
  Unicode directories as a permanent browser regression. Re-record the corrected route and
  submit it to a fresh critic before restoring `verified`.

### 2026-07-31 — builder — rework 6 — IMPLEMENTED

- Implementation commit: `765ff6401eb6e30a39b2925eaff3c385f8b8bfca`. Dynamic tree-route
  segments now decode exactly once before constructing the canonical StreamFS prefix. The
  route fails closed on malformed percent escapes, decoded separators, and paths rejected by
  `isValidFsPath`.
- Permanent browser regression: `apps/web/test/file-tree.pw.ts` navigates the literal
  directory `percent%2Fname` through `%252F`, pointer-clicks `team docs`, keyboard-activates
  `über`, rejects malformed and encoded-separator paths without a document navigation, and
  retains the complete rename/delete/recreate/reconnect/loading/refusal scenario. The same
  regression against the pre-fix router exited 1 while waiting for `über/` after entering
  `team docs/`.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (39 files / 447
  tests), `pnpm build`, and `make --no-print-directory verify-E3-T06` all passed from the
  immutable implementation commit inside the loopback network sandbox.
- Stream evidence: `evidence/e3-t06-events.jsonl` contains 27 canonical events;
  `evidence/e3-t06-digests.json` and `evidence/e3-t06-browser.txt` report 16 final canonical
  rows at checkpoint `0000000000000000_0000000000000026`, digest
  `997c2e90fc5aa4be0c52987b5f18007db21fb10b307f7976463a86b6707da0f2`.
  `E3_T06_INDEPENDENT_REPLAY_OK events=27 rows=16` passed with exact literal-percent,
  spaced, and Unicode row assertions.
- Browser evidence: Replay
  https://app.replay.io/recording/7ae17703-7eb0-4615-be27-19a20042fef8 and
  `recordings/e3-t06-encoded-path-final-v2.mp4` are the same 22.4-second Replay Chromium
  session. It proves exactly-once decoding, pointer and keyboard traversal, visible nested
  files, one unchanged document-navigation entry, malformed-percent / encoded-separator /
  non-NFC 404s, and recovery to the live root tree. Chromium rejects `%00` before an
  application pathname exists, so that input is fail-closed at the browser boundary.
- Replay MCP note: the first post-upload indexing sweep timed out and its immediate retry
  returned `LinkerCrash:New | Hanged`; the fresh critic must retry the uploaded recording's
  console/exception and source-coverage interrogation rather than infer cleanliness from the
  MP4.

### 2026-07-31 — fresh replay critic — VERDICT: needs-evidence

- Recording `7ae17703-7eb0-4615-be27-19a20042fef8` remained wholly uninterrogable after
  independent retries. Recording overview, console, uncaught and React exceptions, network,
  Playwright steps, interactions, annotations, screenshots, React tree, source listing, and
  source search all returned `[Error] LinkerCrash:New | Hanged`.
- No Replay point can therefore prove the exactly-once, spaced/Unicode, 404, live-root, or
  navigation-count claims, and the MP4 plus deterministic transcript cannot substitute for
  the uploaded timeline.
- Changed-code coverage is also insufficient: the recording supplies no source hits for
  `decodeRouteSegment` or `parseTreeRoute`, and the NUL guard is neither executed nor waived
  by interrogable browser-boundary evidence. Supply a clean, indexable recording covering
  every reachable changed path and delete or separately justify unreachable code.

### 2026-07-31 — builder — rework 7 — IMPLEMENTED

- Implementation commit: `f587b3a921e68904d5a2788d39d28c9d81590f30`. The unreachable
  application-level NUL check is deleted because Chromium rejects a `%00` URL before React
  receives a pathname; every remaining route branch is browser-reachable and covered.
- Commands: `pnpm format:check && pnpm lint`, `pnpm typecheck`, `pnpm test` (39 files / 447
  tests), `pnpm build`, and `make --no-print-directory verify-E3-T06` all passed from the
  immutable implementation commit. The composed verifier ran inside the loopback-only
  network sandbox and ended `verify-E3-T06: OK`.
- Stream evidence: `evidence/e3-t06-events.jsonl` contains 27 canonical events;
  `evidence/e3-t06-digests.json` and `evidence/e3-t06-browser.txt` report 16 final canonical
  rows at checkpoint `0000000000000000_0000000000000026`, digest
  `997c2e90fc5aa4be0c52987b5f18007db21fb10b307f7976463a86b6707da0f2`.
  `E3_T06_INDEPENDENT_REPLAY_OK events=27 rows=16` passed with tamper sensitivity intact.
- Browser evidence: Replay
  https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8 and
  `recordings/e3-t06-encoded-path-final-v3.mp4` are the same 17.6-second Replay Chromium
  session. The verified MP4 is H.264 1280x720 at 30fps, 326338 bytes, SHA-256
  `5acb33d70c0ba361d6c59d10392b829f175df9722c186ff0b4345ff94f8ac811`.
- Replay interrogation is healthy: overview, console, uncaught-exception, and React-exception
  sweeps report zero errors or warnings. Source execution covers the decoder entry 34 times,
  parsed-route construction 9 times, path decoding 7 times, the malformed-percent catch,
  encoded-separator rejection, and two canonical-path refusals. The final open live long-poll
  has no terminal status because recording close ended it; the immediately preceding requests
  are successful.
- Direct proof points: [literal `%252F` decoded exactly once](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=39266744993114254660248518464110599&time=129833.84321290776),
  [pointer navigation through `team docs`](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=71718600359532355073199416274845703&time=184049.36106256553),
  [keyboard navigation through `über`](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=102872381511370738740156924040314887&time=244764.39719626168),
  [malformed-percent refusal](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=117475716426277006929700044004130821&time=268642.0000040568),
  [encoded-separator refusal](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=124939643160441619196734235389984775&time=291385.2398523985),
  [non-NFC canonical refusal](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=134026162662897272128097873947525139&time=319423.95825659914),
  and [live return to the root tree](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=145708830594619825823657176263032851&time=371885.0985093973).

### 2026-07-31 — fresh replay critic — VERDICT: needs-evidence (artifact parity)

- The encoded-path rework is correct in the indexable recording: literal `%252F`, pointer
  navigation through `team docs`, keyboard navigation through `über`, malformed-percent,
  encoded-separator, and non-NFC refusals all hold; navigation count and `timeOrigin` remain
  stable, runtime error sweeps are empty, and the two incomplete requests are expected live
  polls rather than failures.
- Original mutation/artifact coverage is insufficient in that recording. Its navigation-only
  fixture ends at checkpoint `0000000000000000_0000000000000006` with digest `f4f9…` and two
  root rows, rather than replaying the committed 27-event artifact through checkpoint
  `0000000000000000_0000000000000026`, digest `997c…`, and 16 canonical rows. See the
  [recorded final live point](https://app.replay.io/recording/215816ff-c0d7-40eb-9c7f-fd816beefbc8?point=147655941916595428792357780788871187&time=373158.00440577156).
- Changed-code coverage also misses `routes.tsx:167`, the aggregate refusal after decoding
  `org`, `repo`, and `branch`. Record malformed or encoded-separator input in an identifier,
  plus the complete rename/delete/recreate/reconnect/populated-directory-rename sequence with
  exact DOM checkpoint/digest parity, before resubmitting to another fresh critic.

### 2026-07-31 — builder — rework 8 — IMPLEMENTED

- Implementation remains `f587b3a921e68904d5a2788d39d28c9d81590f30`; this rework changes no
  tracked code or artifacts. The already-earned immutable gates remain `pnpm format:check &&
  pnpm lint`, `pnpm typecheck`, `pnpm test` (39 files / 447 tests), `pnpm build`, and the
  loopback-only `make --no-print-directory verify-E3-T06` ending
  `E3_T06_INDEPENDENT_REPLAY_OK events=27 rows=16` and `verify-E3-T06: OK`.
- The replacement helper reads the committed event log and digest artifact directly. It
  reproduced the exact initial state at 22 events / checkpoint
  `0000000000000000_0000000000000021` / digest
  `263482b567e6cb93205fea831645e26706f985a7ae56c630213edede6587d610`, then
  appended the five committed mutations in order and independently reached 27 events /
  checkpoint `0000000000000000_0000000000000026` / digest
  `997c2e90fc5aa4be0c52987b5f18007db21fb10b307f7976463a86b6707da0f2` /
  16 canonical rows.
- Browser evidence: Replay
  https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b and
  `recordings/e3-t06-comprehensive-final-v4.mp4` are the same session. The verified MP4 is
  H.264 1280x720 at 30fps, 29.3 seconds, 829933 bytes, SHA-256
  `64c442d902dfbe5cb1a2ed8e300d1810e781e0c1975d18481468f735e67d1ca7`.
- Replay reports healthy with zero errors or warnings, zero console messages, no uncaught or
  React exceptions, and 613 network requests: 608 successful 2xx, zero failed requests, and
  five no-response live polls attributable to four TreeBrowser unmounts plus the poll open at
  recording close. The DOM observed 37 projection/event requests and no direct `/streams/`
  access.
- Changed source coverage is complete: `decodeRouteSegment` ran 58 times, its malformed catch
  once, encoded-separator refusals twice, path-canonical refusals twice, and the previously
  uncovered aggregate identifier-refusal body at `routes.tsx:167` once. The demanded branch is
  visible at the [encoded branch identifier refusal](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=94759417670732750392326824220688389&time=140178.61336828308);
  route behavior is also pinned at [literal `%252F`](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=43160967637438848061974504032698375&time=65386.41348469212),
  [Unicode keyboard traversal](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=74639267343212139408813465544949779&time=108063.52462809917),
  [malformed percent](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=93461343456091273947174620236873733&time=139403.65885416666),
  [encoded path separator](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=94110380563411222994980801662156807&time=139663.61241830065),
  and [non-NFC refusal](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=94434899117071987846575334728138771&time=140028.79250862493).
- Original E3-T06 behavior now shares that same recording: [exact initial DOM parity](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=20120150327096424644773893715787776&time=40078),
  reconnecting at checkpoints [23](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=149927571795155214707945992389394461&time=241399.48772931105),
  [24](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=186922686913245720224430890864869405&time=303718.00024390244),
  [25](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=210937059884809566798607484780019741&time=343477.0002437835),
  and [26](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=247607656449502473326139443439992861&time=404708.0000006394),
  [renamed nested route empty at exact final digest](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=261237435703211035106978289636343821&time=423311.00073333335),
  [loading](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=363460780107957972638869041040064514&time=617180.9973332064),
  [refusal alert](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=417655378569720352227203819543461901&time=730605.4017094017),
  and the [final live root at checkpoint `…0026` / digest `997c…`](https://app.replay.io/recording/58d475ea-3e78-4a2b-b359-d7cec14b827b?point=438100047450922797702808401413668877&time=760451.5).
