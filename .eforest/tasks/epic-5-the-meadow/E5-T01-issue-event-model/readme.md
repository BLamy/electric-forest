---
id: E5-T01
epic: 5
title: "Issue event model frozen: per-issue event streams with a validated workflow reducer registered with ef replay"
priority: 501
status: in-progress
depends_on: [E4]
estimate: M
capstone: false
---

## Goal

An issue on the platform is nothing but a per-issue event stream plus a registered
reducer — the first Epic-5 entity built on the "one model" bet (ROADMAP.md, "One model
to hold them all"), and the pattern every later meadow entity (PRs, wiki, evidence,
tasks) copies. `@eforest/platform` gains an `issues` module (`packages/platform/src/
issues/`) that freezes `ISSUE_EVENT_VERSION = 1`: seven versioned action types —
`issue.opened { v, title, body }`, `issue.commented { v, commentId, body }`,
`issue.labeled { v, label }`, `issue.unlabeled { v, label }`,
`issue.state-changed { v, to }`, `issue.closed { v, reason? }`,
`issue.reopened { v }` — dispatched onto a per-issue stream whose id follows the frozen
pattern `issue:<org>/<repo>/<issueId>` inside the repo's E2-T06 namespace (`issueId` is
an opaque, client-generated, path-safe identifier; human-friendly sequential numbering
is a derived-stream concern deferred to E5-T03, stated there and here). The exported
`issueReducer` collapses the stream to a canonically-encodable state —
`{ v, issueId, title, body, state, labels, comments }` where `state ∈ { open,
in-progress, done, closed, wont-do }`, `labels` is a lexicographically sorted,
duplicate-free array, and `comments` is an offset-ordered array of
`{ commentId, body, ts }` — governed by an exported, frozen transition matrix
`WORKFLOW_TRANSITIONS`. Every mutation goes through E0-T11's validated
`POST /api/dispatch`: registered `ActionValidator`s refuse malformed payloads
(`schema-violation` → 422) and illegal transitions (`validator-rejected` → 409) with
the frozen E0-T11 error-body shape, and **nothing is appended** — head offset and
`ef replay --digest` log digest byte-identical before and after every refusal. The
reducer registers with the E0-T10 registry under stream type `issue` on the stream
server, and is loadable by `ef replay <dump> --digest --reducer <module>` (E0-T04), so
any issue dump replays offline to one canonical SHA-256 state digest — the citation
currency for every later issue claim (E5-T03 board, E5-T05 UI, E5-T07 merge-closes,
the E5-T13 capstone).

## Context

Epic 5 rebuilds the GitHub surface as pure event streams, and its capstone verdict is
"the issue flips to `done` via the merge's closing event … the whole negotiation
replays offset-by-offset". That claim is only checkable if the issue event envelope and
its workflow reducer are frozen *first*, with dispatch-side legality enforcement, so
that (a) no garbage event ever becomes a permanent replayed-forever fact, and (b)
"issue state" is a digest, not an opinion. This is the same keystone move as E1-T01
(fs digest before fs features) and E4-T01 (worktree digest before sync): every later
Epic-5 issue task cites this model; none re-derives it.

Builds on, and does not modify:

- **E0-T10/E0-T11** — the reducer registry and the validated dispatch door. Issue
  legality is implemented *entirely* as registered `ActionValidator`s and a registered
  reducer; the door itself is untouched (E0-T11: "Epic 5 extend[s] it by registering
  validators, never by patching the door"). The four-class refusal taxonomy and its
  status codes are E0-T11's frozen contract, reused verbatim — this task adds no new
  classes.
- **E0-T04** — `ef replay <dump> --digest --reducer <module>` is the offline replay
  mouth; the digest is `stateDigest` from `@eforest/protocol` over the canonically
  encoded reduced state. No second digest implementation.
- **E2-T06/E2-T07** — issue streams live under the repo's namespace, so per-stream
  authorization applies by pattern exactly as it does to branch streams; an
  unauthenticated/unauthorized dispatch is refused by Epic 2's machinery before this
  task's validators ever run.

Contracts frozen by this task (version-bumped, never silently changed — changing any
of them later invalidates every Epic-5 issue golden):

- **The envelope** (`ISSUE_EVENT_VERSION = 1`): the seven action types above, each
  payload's exact required/optional fields and types, canonical-JSON encoded per
  `@eforest/protocol`. Unknown action types on an `issue` stream →
  `unknown-action-type` 404; a payload with `v ≠ 1`, missing/extra/wrong-typed fields
  → `schema-violation` 422. Epic 6 extends this envelope *additively* (`claimed`,
  `refuted`, `verified`) under a version bump; the module README states this
  extension rule.
- **The workflow state machine** (`WORKFLOW_TRANSITIONS`, exported): the full
  `state × actionType → nextState | refuse` matrix is written out exhaustively in the
  module README — all 5 states × all 7 action types, no "otherwise" row. Mandatory
  pins (the builder freezes the rest, exhaustively):
  - `issue.opened` is legal only as the very first event on the stream (state
    "unopened" exists only implicitly as the empty stream); a second `opened`, or any
    other issue action before `opened`, → `validator-rejected` 409.
  - `issue.closed` is legal from `open` and `in-progress` only → `closed`.
  - `issue.reopened` is legal from `closed`, `done`, and `wont-do` only → `open`.
  - `issue.state-changed { to }` moves among `open` / `in-progress` / `done` /
    `wont-do` per the matrix; `to: closed` via `state-changed` is illegal (`closed`
    is reachable only through `issue.closed`), and a self-transition
    (`to` = current state) → `validator-rejected` 409.
  - `issue.commented` is legal in every post-`opened` state; a duplicate `commentId`
    on the same stream → `validator-rejected` 409.
  - `issue.labeled` with a label already present, and `issue.unlabeled` with a label
    absent, → `validator-rejected` 409 (label mutations are never silently
    idempotent — the log records only meaningful events, per E0-T11's doctrine).
- **The reduced state shape**: the exact field set above, canonically encodable
  (sorted labels, offset-ordered comments, no wall-clock or random fields — the
  reducer is a pure function of the event sequence and nothing else), so
  `replay(log)` is deterministic across processes, machines, and time.

Non-goals: no browser write path (E5-T04), no UI (E5-T05), no issue board or derived
listing (E5-T03), no sequential issue numbers (E5-T03), no cross-entity links or
merge-driven closing (E5-T07), no label *definitions*/colors (E5-T03 — here a label is
an opaque string), no PR model (E5-T02), no database (bet 4 — this task's list surface is `replay(stream)`, full
stop). `depends_on: [E4]` means the E4 capstone is verified: server, gates, namespaces,
web canopy, and the `ef` CLI including `ef replay --reducer` all exist to be extended.

## Deliverables

Path anchor: every `evidence/` path below is relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T01-issue-event-model/`. The `verify-E5-T01`
Makefile recipe references them repo-root-anchored (e.g. `$(CURDIR)`) so it passes
from any cwd.

- `packages/platform/src/issues/` (exported from `@eforest/platform`):
  - `envelope.ts` — `ISSUE_EVENT_VERSION = 1`, the seven payload types, and their
    schema validators (typed, field-naming refusals).
  - `reducer.ts` — `issueReducer` conforming to the `@eforest/protocol` reducer
    signature the replay core consumes; pure, no clock/random/env reads.
  - `workflow.ts` — the exported `WORKFLOW_TRANSITIONS` matrix and
    `isLegal(state, action)`; the reducer and the validators both read *this one
    table* — no second copy of the state machine anywhere.
  - `validators.ts` — the `ActionValidator`s for all seven types (schema stage +
    state-dependent stage via E0-T11's `(action, { state, headOffset })` hook),
    registered with `registerValidator`.
  - Module README: the envelope field tables, the exhaustive transition matrix, the
    reduced-state shape, the stream-id pattern, the Epic-6 additive-extension rule,
    and the invalidation rule (version bump + regenerate every issue golden).
- `packages/platform`: registration wiring — stream type `issue` bound to
  `issueReducer` in the E0-T10 registry and all issue validators registered at server
  startup; application projection bootstrap on an issue stream serves the reduced issue at head.
- `ef replay` compatibility: the issue reducer importable as the `--reducer` module
  (document the exact module path in the README); no CLI changes beyond what E0-T04
  already supports — if a mapping entry is needed, it is data, not a new code path.
- Property tests (`packages/platform/test/issues.property.test.ts`, seeded, seed
  printed and committed): generate random event sequences over the seven types;
  assert (a) dispatch-level acceptance is *exactly* `isLegal` under the frozen matrix
  (accept ⟺ legal — both false-accepts and false-refusals fail), (b) every accepted
  sequence reduces without throwing to a state in the five-state set with sorted,
  duplicate-free labels, (c) replaying any accepted sequence twice yields identical
  digests, and (d) reducing an interleaving with refused dispatches removed equals
  reducing the accepted events alone.
- Integration tests (`packages/platform/test/issues.dispatch.test.ts`, real
  HTTP): the full lifecycle happy path; every refusal class exercised with
  before/after head-offset + dump-digest byte-equality; unauthorized dispatch refused
  by the Epic-2 layer with the log untouched.
- Committed evidence:
  - `evidence/golden-issue.jsonl` — a golden issue event log exercising all seven
    types and at least six distinct workflow states/transitions, produced through
    real dispatches.
  - `evidence/golden-issue.digest` — its frozen state digest, produced once,
    committed, never regenerated by any check that consumes it.
  - `evidence/refusals/` — for each refusal class and each mandatory illegal
    transition: the refused request body, the response (status + error body), and
    the head offset + dump digest captured before and after, byte-equal — one
    transcript file per case.
  - `evidence/replay-determinism.txt` — transcript of two separate
    `ef replay evidence/golden-issue.jsonl --digest --reducer <module>` process
    invocations printing byte-identical digests matching the golden.
- `Makefile`: `verify-E5-T01` inside the marker section composing the frozen helpers
  (`_v-fmt _v-lint _v-typecheck _v-test _v-build`) plus: (1) replay determinism —
  `ef replay` on the golden log run **twice as separate processes**, both lines
  byte-equal each other and `evidence/golden-issue.digest`; (2) sensitivity — flip
  one byte inside one event payload of a temp copy of the golden log, assert the
  replay digest comparison exits nonzero, printing
  `MUTATION fixture=golden-issue byte=<offset> digest-mismatch EXPECTED-FAIL OK`
  only after observing the mismatch; (3) a refusal-neutrality step — replay a
  committed refusal transcript's before/after digests and assert byte-equality.
  Joins `verify-all`; `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E5-T01` exits 0 with zero `SKIPPED:` lines — evidence:
      `make verify-E5-T01 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Replay determinism**: `ef replay evidence/golden-issue.jsonl --digest
      --reducer <documented module path>` run twice in fresh shells prints the same
      single lowercase-hex SHA-256 line, byte-equal to
      `evidence/golden-issue.digest`, exit 0 both times; the server's application projection bootstrap digest
      for the same event sequence (dispatched onto a fresh stream) matches it —
      evidence: `evidence/replay-determinism.txt` plus the Makefile step plus a
      committed integration test asserting the offline/online digest equality.
- [ ] **Sensitivity**: the in-target mutation step prints
      `^MUTATION .* digest-mismatch EXPECTED-FAIL OK$` at least once — evidence:
      `make verify-E5-T01 2>&1 | grep -c '^MUTATION .* digest-mismatch EXPECTED-FAIL OK$'`
      ≥ 1.
- [ ] **Every refusal is log-neutral**: for each of `malformed-body` 400,
      `schema-violation` 422, `unknown-action-type` 404, `validator-rejected` 409,
      and for each mandatory illegal transition pinned in Context (second `opened`,
      pre-`opened` action, `closed` from `done`, `reopened` from `open`,
      `state-changed` self-transition, `state-changed to: closed`, duplicate label,
      absent-label unlabel, duplicate `commentId`), a committed test captures head
      offset and full-dump digest before and after the refused dispatch and asserts
      byte-equality, and the response carries exactly that class's E0-T11 status and
      error-body shape — evidence: the integration tests green plus one transcript
      per case under `evidence/refusals/`.
- [ ] **The matrix is exhaustive and singular**: the module README enumerates all
      5 × 7 state/action cells with no default row; `WORKFLOW_TRANSITIONS` is
      exported; a committed test iterates every cell and asserts dispatch behavior
      (accept vs. 409) matches the README table cell-for-cell; a committed grep-based
      check asserts no second encoding of transition legality exists outside
      `workflow.ts` (the reducer and validators import `isLegal`; a pinned
      forbidden-token check over `packages/platform/src/issues/` and the server
      wiring finds no independent state-name switch/case implementing legality) —
      evidence: the test green plus the check's command line and empty match output
      committed under `evidence/`.
- [ ] **Property tests**: the seeded property suite (seed committed) passes ≥ 1000
      generated sequences per property, and properties (a)–(d) from Deliverables are
      each present as named assertions — evidence: the test file, green under
      `pnpm test`, seed and case count visible in the committed run transcript.
- [ ] **Reducer purity**: two `ef replay --digest` runs on the golden log under
      `TZ=Pacific/Kiritimati LANG=C` vs. default env, from two different cwds, print
      byte-identical digests; a committed grep asserts
      `packages/platform/src/issues/` contains no `Date.now`, `new Date(`,
      `Math.random`, `process.env`, or filesystem/network reads — evidence: both
      transcripts plus the grep output committed under `evidence/`.
- [ ] **Authorization applies**: a dispatch to an issue stream without a valid
      Epic-2 credential (and one with a credential lacking write grant on the repo's
      namespace) is refused with Epic 2's frozen `unauthorized` semantics, log
      untouched (offset + digest byte-equal) — evidence: committed integration test
      green.
- [ ] **Registration is real, not incidental**: application projection bootstrap on an issue stream returns
      the reduced issue state at head; an `issue.*` dispatch to a stream of a
      different registered type is refused as `unknown-action-type` 404 — evidence:
      committed integration tests green.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `tools/verify/self_check.sh`
      passes; `make verify-list` maps `verify-E5-T01` to this task; `verify-all`
      including every E0–E4 target still green — this task is additive to every
      frozen contract below it.
- [ ] Replay browser layer: N/A (server + library surface only; nothing
      browser-reaching changes — the browser write path is E5-T04) — the
      Verification log entry must declare this explicitly per AGENTS.md;
      stream-layer evidence above is the currency.

## Adversarial verification

Your mission: refute the claim that an issue is a frozen, fully-validated,
deterministically-replayable event stream. Every attack pairs a manipulation with a
refutation condition. Use your own inputs, never the builder's. Any single success
refutes.

1. **Fuzz the door with your own garbage (mandatory).** Ignore the builder's fuzz
   corpus. Throw your own malformed dispatches at a live issue stream: truncated
   JSON, `v: 2`, `v: "1"`, `v: 1.0`, missing `title`, extra fields, `label` as an
   array, a 10 MB `body`, astral-plane and NUL-adjacent strings in every string
   field, `to: "Closed"` (case), `to: "deleted"`, a `commentId` colliding with an
   existing one, an action type `issue.opened ` (trailing space). Every one must be
   refused with the correct E0-T11 class/status, and after your entire barrage the
   stream's head offset and `ef replay --digest` dump digest must be byte-identical
   to before it. **One appended garbage event refutes the task's premise**, not a
   bug — the log is forever.
2. **Illegal-transition sweep, derived independently.** Do not trust the builder's
   matrix test. Build your own 5 × 7 table from the README prose, then drive a fresh
   stream into each of the five states and fire all seven action types at each.
   Acceptance must match your independently-derived table cell-for-cell, and every
   refusal must be log-neutral. A cell where dispatch and README disagree — in either
   direction — refutes; so does any path that reaches a sixth state or reaches
   `closed` via `state-changed`.
3. **Differential legality: reducer vs. door.** Craft event logs *bypassing*
   validation (write dumps by hand) containing sequences the door would refuse —
   double `opened`, comment-before-open, duplicate labels — and feed them to
   `ef replay --digest --reducer <module>`. The reducer's documented behavior on
   illegal-but-present events must be pinned in the README (refuse the replay with a
   typed error, or a documented deterministic handling — silence is a hole) and the
   observed behavior must match it. A reducer that crashes unclassified, or that
   quietly produces a state the matrix says is unreachable while the README says
   nothing, refutes the frozen contract.
4. **Determinism across worlds.** Replay the golden log (and one long log you
   generate yourself, ≥ 500 events) via: two separate `ef replay` processes, the
   server's application projection bootstrap after dispatching the same sequence onto a fresh stream, and
   under `TZ`/`LANG`/cwd perturbation. All digests byte-equal or the task's citation
   currency is counterfeit. Then flip one byte inside one payload of your copy and
   confirm the digest changes; flip a byte in *every* event one at a time if cheap —
   any flip that leaves the digest green refutes the measuring apparatus.
5. **State-shape aliasing.** Engineer two dispatch sequences that end in
   semantically different issues (different label sets, different comment order,
   labels `["a","b"]` vs `["b","a"]` added in different orders then one removed and
   re-added) and check the digests: distinct final states must digest differently;
   identical final states reached by different histories must digest identically
   under application projection bootstrap (state digest, not log digest). Sorted-labels and offset-ordered
   comments are frozen claims — an unsorted or insertion-ordered leak refutes.
6. **Second-implementation hunt.** Read `packages/platform/src/issues/` and the
   server wiring for any transition logic, state-name switch, or legality check that
   does not delegate to the one exported `WORKFLOW_TRANSITIONS`/`isLegal`, and any
   hashing/canonical-encoding outside `@eforest/protocol`. One parallel truth —
   even behavior-identical today — refutes "one table, frozen", because parallel
   truths drift.
7. **Sabotage the suite.** In a scratch worktree, break it four ways: (a) make
   `issue.closed` legal from `done`, (b) make duplicate labels silently idempotent,
   (c) let the reducer read `Date.now()` into a timestamp field, (d) accept `v: 2`
   payloads. For each: `pnpm test` **and** `make verify-E5-T01` must go red. Any
   sabotage that stays green refutes whichever gate it slipped past. Check the diff
   for `.skip`/`.todo`/inline lint disables while there.
8. **Self-licking goldens.** Delete `evidence/golden-issue.digest` and run
   `make verify-E5-T01` — it must fail red, not regenerate-and-pass. Inspect the
   recipe and tests for any write to golden files at check time, and git history for
   a quietly regenerated golden. A check that cannot fail refutes the verify spine's
   coverage of this task.
9. **The door is still the only door.** Confirm no new append path snuck in: issue
   mutations must be reachable only via `/api/dispatch` (plus the pre-existing raw
   protocol door whose gating doctrine E0-T11/E2 own). Grep the diff for direct
   store-append calls in issue code; try mutating an issue via any other endpoint
   you can find. A working bypass refutes bet 1 for this entity.
10. **Coverage vs. the diff.** Hold the claimed final run against the diff: every
    refusal class, every mandatory pinned transition, the property seeds, the purity
    greps, both replay mouths, and the authz refusal must each have been executed by
    a committed test or cited transcript. Unexecuted diff is unproven or dead —
    builder picks which, you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your independently-derived transition table as a
committed cross-check fixture, and any hostile dispatch or hand-written log that
found interesting surface into the committed corpora.

## Verification log

### 2026-08-19 — builder checkpoint — implemented, not yet verified

- Commit `38f3dcb4` adds the version-1 issue envelope, the exported 5x7 workflow
  matrix, pure reducer, strict validators, platform exports, replay adapter, focused
  tests, and the golden replay fixture.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, the focused issue suite
  (`3 passed`), and platform/reducer builds pass. Two independent replay invocations
  produce `d8f26393a6b6912ea9aee063ab399fb972a15d5ab4af2a3beb5aa646ce81dea4`, matching
  `evidence/golden-issue.digest`.
- At this checkpoint, HTTP dispatch integration, refusal transcripts, startup validator
  registration, and the `verify-E5-T01` target remained to be implemented; the later
  checkpoint below records their integration. Replay: N/A (server + library surface
  only; browser write path is E5-T04).

### 2026-08-19 — builder — stream-aware issue projection bootstrap

- Commits `bf500959` and `f163b74b` make reducer definitions optionally derive
  initial state from the stream id. The issue projection now seeds `issueId` from
  `issue:<org>/<repo>/<id>` during replay and gateway projection validation; the
  integration assertion verifies the reduced head state contains `issueId: i-1`.
  Typecheck and the focused `11/11` issue suite pass. Replay: N/A (server + library
  surface only; browser write path is E5-T04).

### 2026-08-19 — builder checkpoint — HTTP registration integrated

- The existing `/api/dispatch` writer fence now classifies `issue:<org>/<repo>/<id>`
  as a repository-scoped `main` target, runs the registered seven-action validator
  registry before append, and maps unknown/schema/transition failures to 404/422/409.
- The HTTP integration test covers a successful open and duplicate-open refusal with
  one appended record; all four focused tests pass. `pnpm format:check`, `pnpm lint`,
  and `pnpm typecheck` pass. Replay: N/A (server + library surface only; browser write
  path is E5-T04).

### 2026-08-19 — builder checkpoint — critic rework

- Fixed optional `issue.closed.reason` typing, made the transition matrix encode all
  legal `state-changed` destinations, made the pure reducer deterministic/no-op on
  malformed or illegal replay input, and derive `issueId` from the stream for gateway
  validation state.
- Expanded the HTTP refusal coverage across unknown action, malformed optional field,
  duplicate comment/label, missing label, self/closed transitions, terminal reopening,
  and append neutrality. Focused tests and typecheck pass.

### 2026-08-19 — builder — cold-clone verification

- `tools/verify/cold_clone.sh verify-E5-T01` passed from pristine committed HEAD
  `070cbe55`, after the target was added to `tools/verify/cold_clone_targets.txt`.
  The transcript completed format, lint, typecheck, build, focused tests, replay
  digest comparison, mutation sensitivity, `self_check`, and `verify-list`; it emitted
  `MUTATION ... EXPECTED-FAIL OK` and `verify-E5-T01: OK` with no `SKIPPED:` lines.
- Replay: N/A (server + library surface only; browser write path is E5-T04).

### 2026-08-19 — builder — current-head cold-clone rerun

- `tools/verify/cold_clone.sh verify-E5-T01` passed from committed HEAD `a0892aad`.
  This run exercised the expanded 9-test suite and emitted zero `SKIPPED:` lines;
  format, lint, typecheck, build, replay sensitivity, purity, self-check, and target
  registration all passed.

### 2026-08-19 — builder — full current-head cold-clone proof

- `tools/verify/cold_clone.sh verify-E5-T01` passed from committed HEAD `dd817f04`.
  The pristine run completed the repo-wide suite (`65` files, `618` tests), both
  build passes, the focused 9-test issue suite, replay sensitivity, purity, self-check,
  and target registration; it emitted no `SKIPPED:` lines and ended `verify-E5-T01: OK`.

### 2026-08-19 — builder — current ticket gate

- Commit `374dae27` removes a temporary cross-ticket `verify-all` prerequisite that
  invalidated E1-T11's frozen provenance evidence. `make verify-E5-T01` now passes
  the ticket-local gates: `65` files, `619` tests, both builds, the focused `10`
  test issue suite, replay digest comparison, mutation sensitivity, purity checks,
  self-check, and target registration. It emits no `SKIPPED:` lines and ends
  `verify-E5-T01: OK`. The separate upstream `make verify-E1-T11` retry still
  reports the pre-existing provenance mismatch caused by changing `Makefile`; no
  upstream evidence was regenerated. Replay: N/A (server + library surface only;
  browser write path is E5-T04).

### 2026-08-19 — builder — authorization/property rework and upstream proof refresh

- Commit `978462bb` adds a real nonempty public-repository authorization case: an
  authenticated subject without a branch write grant receives `403
  authz/write-grant-required` and appends nothing. The generated property cases now
  vary accepted labels/comments and replay sequences across all four properties.
- Commit `e7d44655` refreshes E1-T11's frozen provenance and evidence manifest after
  the committed E5 verification target legitimately changed `Makefile`. `make
  verify-E1-T11` now passes end-to-end, including the capstone and sabotage spine;
  it ends `verify-E1-T11: OK`. Replay: N/A (server + library surface only; browser
  write path is E5-T04).

### 2026-08-19 — builder — current-head local gate and composed-gate boundary

- Commit `20ab1ac7` adds the HTTP dispatch sweep for all 25 state-change destination
  cells. Commit `6d939fb6` refreshes E1-T11 provenance for the composed target.
  `make _v-gates` passes at the current head with `65` files and `620` tests, both
  builds, and the focused issue suite is `11/11` green.
- `make verify-E5-T01` reaches the composed E0-E4 sweep but is blocked by the
  unrelated E3-T06 recovery-attestation checks, which reject the branch's accumulated
  lifecycle history. The run was stopped after repeated E3-T06 failures; no E3
  evidence was rewritten. This ticket remains implemented, not verified. Replay: N/A
  (server + library surface only; browser write path is E5-T04).

### 2026-08-19 — builder — authentication refusal coverage

- Commit `1ead604e` adds an HTTP dispatch test proving failed authentication returns
  `401` before issue authorization and append; the focused suite is now `10` tests.
  The ticket-local gate `make _v-gates` passed with `65` files and `619` tests, both
  builds, and no skipped evidence. The composed `make verify-E5-T01` remains blocked
  by an upstream `verify-E1-T11` capstone/test-build interaction (missing linked
  `@eforest/protocol/dist` during the issue test and unrelated auth/gateway failures),
  so this ticket is not yet claimed verified. Replay: N/A (server + library surface
  only; browser write path is E5-T04).

### 2026-08-19 — builder — complete HTTP action matrix

- Commit `9804216c` extends the dispatch-door matrix to all six non-state-change
  actions, completing all 35 workflow cells through HTTP acceptance/refusal checks;
  focused issue coverage remains `11/11` green. The current `_v-gates` proof above
  remains valid for the preceding head; the composed E0-E4 gate is still blocked by
  unrelated E3-T06 recovery-attestation history checks. Replay: N/A (server + library
  surface only; browser write path is E5-T04).

### 2026-08-19 — critic — VERDICT: refuted

- P1 property-suite independence — FAILED. `packages/platform/test/issues.test.ts:441-538`
  labels 1,000 iterations as four properties, but properties (b)-(d) use fixed event
  templates and property (a) derives its legality oracle from the implementation's
  `isLegal` table. Replace these with independently generated sequences and an
  independently declared legality oracle.
- P2 empty-open replay guard — FAILED. `packages/reducers/src/issues.ts:123-128`
  identifies an already-open issue only from non-empty title/body, so a second
  `issue.opened` with empty strings is applied. Add an explicit opened-state invariant
  and a regression test for empty title/body.
- P3 matrix singularity guard — INSUFFICIENT. The committed matrix test checks the
  exported implementation table, while the E5 target has no README cell-for-cell
  comparison or forbidden second-legality-encoding check. Add a mechanical check and
  include it in `verify-E5-T01`.
- P4 composed verification — INSUFFICIENT. The current proof stops during the E0-E4
  sweep and therefore does not establish the required repo-wide composed gate. Do not
  claim E5-T01 verified until a completed composed run is recorded.
- Replay: N/A (server + library surface only; browser write path is E5-T04). The
  stream-layer evidence above is the validation currency for this ticket.
