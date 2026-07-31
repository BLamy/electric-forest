---
id: E3-T04
epic: 3
title: "Live repository and organization browse from the registry event stream"
priority: 304
status: verified
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

### 2026-07-31 — critic — VERDICT: needs-evidence

- P1 authorized replay and convergence — PASSED. Predicted the committed authorized dump
  would independently reduce to the claimed live digest; `ef replay` through the shared
  registry reducer produced
  `660090db9949ddc8e0f247e4d7040114b00ace19a9f207fa1a57613c4c2415b2`, equal to
  `evidence/e3-t04-digest.txt` and the two-client transcript at checkpoint
  `0000000000000000_0000000000000003`. Evidence:
  `evidence/e3-t04-authorized-registry.jsonl`,
  `evidence/e3-t04-browser.txt`, and `evidence/e3-t04-digest.txt`.
- P2 hidden identifier and count suppression — PASSED. Predicted prepending a complete
  unrelated private org/project/repo hierarchy would leave the authorized projection
  byte-identical; an independent projection attack produced the same three events and
  contiguous checkpoint `0000000000000000_0000000000000002`, with none of the hidden org,
  project, repo, stream prefix, or owner strings present. The product code rebuilds this
  projection only from `__registry__`; no list database, side cache, local storage, or
  session storage appears in the diff. Attack:
  `work/critic_projection_attack.mts`; implementation:
  `packages/platform/src/registry/doors.ts`.
- A1 task attack 1 — NEEDS EVIDENCE. Predicted the final browser run would concurrently
  create one public and one private repository in two organizations, as the task's attack
  list requires. The run seeds `reading-room` as public before either client opens, then
  concurrently creates `oak/hidden-vault` private and `maple/new-leaf` private
  (`apps/web/test/registry-live.pw.ts:30-35,110-130`). Record a two-client run that
  concurrently dispatches a public repo in one organization and a private repo in the
  other, then prove the visible rows, exact digest/checkpoint, and response-body privacy
  scans from that run.
- COVERAGE loading/empty/refusal branches — NEEDS EVIDENCE. Predicted the browser proof
  would execute every changed user-reachable branch. It exercises the populated live
  list and organization route, but never the loading, empty, or refusal DOM branches in
  `apps/web/src/routes.tsx:216-238`. Extend the browser proof to exercise and assert all
  three states with zero console/page/request failures.
- SENSITIVITY frozen digest — NEEDS EVIDENCE. The exact live digest assertion at
  `apps/web/test/registry-live.pw.ts:166,181` is a plausible oracle, but the submitted
  evidence contains no reducer-mutation run demonstrating that the acceptance target
  exits nonzero. Mutate one state-affecting registry-reducer byte in a disposable
  worktree, run `make verify-E3-T04`, and commit the red transcript naming the failed
  digest assertion.
- Replay fallback — WAIVED. `Replay: N/A (Replay CLI is not authenticated and the
  installed CLI exposes no MCP command) + mitigation` is loud and correctly names the
  fallback layers. The fallback itself is acceptable; the Playwright evidence still must
  cover the missing cases above.
- SUITE: retain the shared registry tests, exact digest golden, authorized event dump,
  hidden-count attack, and `verify-E3-T04` target. Promotion is deferred until the three
  evidence gaps close.

Commands: `node packages/cli/dist/src/bin.js replay
.eforest/tasks/epic-3-the-canopy/E3-T04-repo-list-live/evidence/e3-t04-authorized-registry.jsonl
--digest --reducer packages/platform/registry-reducer.mjs`; `pnpm vitest run
packages/platform/test/registry.test.ts packages/reducers/src/index.test.ts
packages/web-hooks/src/useStreamReducer.test.ts` (30/30 passed);
`node --experimental-strip-types
.eforest/tasks/epic-3-the-canopy/E3-T04-repo-list-live/work/critic_projection_attack.mts`.

### 2026-07-31 — builder rework — CLAIM: implemented

- Rework candidate: `e1a7896` (browser evidence `f25aede`, committed sensitivity
  transcript `e1a7896`).
- Task attack 1 now runs literally: two clients are live before concurrent creation of
  public `maple/new-leaf` and private `oak/hidden-vault` in different organizations.
  Both clients converged without reload at checkpoint
  `0000000000000000_0000000000000003`; browser and independent CLI replay produced
  digest `e553794824d8e921f588e9e951745fbb34a8cdfe091e784a7ca4866d5fdfdb05`.
  Response-body scans found none of `hidden-vault`, `fs:oak/`, or `auth0|outsider`.
- Browser coverage now holds the initial projection request to assert the loading DOM,
  navigates without a document reload to an organization with no authorized rows to
  assert the empty DOM, and injects an invalid authorized projection to assert the
  refusal DOM. The complete run still reports zero console errors, page errors, or
  request failures. Evidence: `evidence/e3-t04-browser.txt`.
- Reducer sensitivity now has a committed expected-red transcript. In a disposable
  worktree at `f25aede`, changing `registryStateDigest` caused
  `make --no-print-directory verify-E3-T04` to exit 2 with two exact digest assertion
  failures (435 tests remained green); the cheap deterministic gate stopped the target
  before browser publication. Evidence: `evidence/e3-t04-reducer-sensitivity.txt`.
- Unmutated exact-head gauntlet: `make --no-print-directory verify-E3-T04` passed format,
  lint, typecheck, all 437 tests, production build, emulator/auth/security checks,
  inherited E3-T02 and E3-T03 browser proofs, 30 focused tests, and the revised E3-T04
  browser proof.
- Replay: N/A (Replay CLI is not authenticated and the installed CLI exposes no MCP
  command) + mitigation: committed authorized event log and exact CLI digest,
  two-client Playwright proof covering concurrent public/private creation plus
  loading/empty/refusal states, response-body leak scans, forced reconnect, zero browser
  errors, committed reducer-mutation sensitivity, and the full local gauntlet.

All three critic evidence demands are now directly covered by committed artifacts. The
implementation remains unchanged: this rework makes the final proof exercise the exact
public/private concurrency attack, every new user-reachable state, and the digest
apparatus's expected-red behavior.

### 2026-07-31 — re-critic — VERDICT: verified

- P1 concurrent public/private live creation — PASSED. Predicted both clients would be
  live before concurrent creation of public `maple/new-leaf` and private
  `oak/hidden-vault`, then converge without reload on the authorized public row and the
  independent replay digest. `make --no-print-directory verify-E3-T04` reproduced
  checkpoint `0000000000000000_0000000000000003`, digest
  `e553794824d8e921f588e9e951745fbb34a8cdfe091e784a7ca4866d5fdfdb05`,
  `cli=equal`, `reloads=0`, and two converged clients. Evidence:
  `evidence/e3-t04-browser.txt`, `evidence/e3-t04-authorized-registry.jsonl`, and
  `evidence/e3-t04-digest.txt`; browser driver:
  `apps/web/test/registry-live.pw.ts`.
- P2 privacy and browser-state coverage — PASSED. Predicted the same run would exercise
  loading, empty, and refusal DOM branches while exposing none of the hidden private
  repo, stream prefix, or outsider owner in captured response bodies. The run reported
  `loading=true`, `empty=organizations/oak`, `refusal=invalid-authorized-projection`,
  `hidden-vault=false`, `fs:oak=false`, `outsider=false`, and zero console, page, or
  request failures. The public row also carried `data-visibility=public`; the empty org
  contained zero repository rows.
- P3 reducer sensitivity — PASSED. Predicted a disposable mutation making
  `registryStateDigest` hash an added `sensitivityMutation` state field would make the
  registry gates red. An independent detached-worktree reproduction at candidate
  `f25aede` produced exactly two digest assertion failures while the other 23 focused
  registry tests passed: CLI replay no longer equaled `registryStateDigest` at
  `packages/platform/test/registry.rebuild.test.ts:464`, and the authorized projection
  digest no longer equaled canonical state at `packages/platform/test/registry.test.ts:223`.
  The committed full-target transcript likewise records exit 2 with those same two
  assertions after 435/437 tests remained green. Evidence:
  `evidence/e3-t04-reducer-sensitivity.txt`.
- P4 immutable candidate and prior findings — PASSED. Direct CLI replay of the committed
  four-event authorized dump returned exactly
  `e553794824d8e921f588e9e951745fbb34a8cdfe091e784a7ca4866d5fdfdb05`.
  The full unmutated `verify-E3-T04` target passed format, lint, typecheck, all 437 tests,
  build, inherited E3-T02/E3-T03 proofs, 30 focused tests, and the revised browser run.
  The earlier hidden-count projection attack and no-side-storage inspection remain
  intact; the rework changes only test/evidence artifacts.
- Replay fallback — WAIVED. `Replay: N/A (Replay CLI is not authenticated and the
  installed CLI exposes no MCP command) + mitigation` remains a loud declaration. The
  committed stream dump/digest, full-wire Playwright response scans, two-client live
  proof, exact reducer sensitivity, zero-error assertions, and full local target are a
  coherent fallback for this run.
- SUITE: retain the shared registry tests, authorized event dump, exact digest golden,
  two-client browser proof including all three UI states, response-body privacy scans,
  reducer-mutation transcript, and `verify-E3-T04` target.

Commands: `make --no-print-directory verify-E3-T04`; `node
packages/cli/dist/src/bin.js replay
.eforest/tasks/epic-3-the-canopy/E3-T04-repo-list-live/evidence/e3-t04-authorized-registry.jsonl
--digest --reducer packages/platform/registry-reducer.mjs`; disposable candidate
mutation followed by `pnpm exec vitest run packages/platform/test/registry.test.ts
packages/platform/test/registry.rebuild.test.ts --maxWorkers=1`.
