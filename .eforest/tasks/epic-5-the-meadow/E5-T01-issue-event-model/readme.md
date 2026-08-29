---
id: E5-T01
epic: 5
title: "Issue event model frozen: per-issue event streams with a validated workflow reducer registered with ef replay"
priority: 501
status: verified
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
server, and is loadable by `ef replay <dump> --digest --reducer <module> --stream-id
<issue-stream-id>` (E0-T04), so
any issue dump replays offline to one canonical SHA-256 state digest — the citation
currency for every later issue claim (E5-T03 board, E5-T05 UI, E5-T07 merge-closes,
the E5-T13 capstone).

## Context

Epic 5 rebuilds the GitHub surface as pure event streams, and its capstone verdict is
"the issue flips to `done` via the merge's closing event … the whole negotiation
replays offset-by-offset". That claim is only checkable if the issue event envelope and
its workflow reducer are frozen _first_, with dispatch-side legality enforcement, so
that (a) no garbage event ever becomes a permanent replayed-forever fact, and (b)
"issue state" is a digest, not an opinion. This is the same keystone move as E1-T01
(fs digest before fs features) and E4-T01 (worktree digest before sync): every later
Epic-5 issue task cites this model; none re-derives it.

Builds on, and does not modify:

- **E0-T10/E0-T11** — the reducer registry and the validated dispatch door. Issue
  legality is implemented _entirely_ as registered `ActionValidator`s and a registered
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
  → `schema-violation` 422. Epic 6 extends this envelope _additively_ (`claimed`,
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
merge-driven closing (E5-T07), no label _definitions_/colors (E5-T03 — here a label is
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
    `isLegal(state, action)`; the reducer and the validators both read _this one
    table_ — no second copy of the state machine anywhere.
  - `validators.ts` — the `ActionValidator`s for all seven types (schema stage +
    state-dependent stage via E0-T11's `(action, { state, headOffset })` hook),
    registered with `registerValidator`.
  - Module README: the envelope field tables, the exhaustive transition matrix, the
    reduced-state shape, the stream-id pattern, the Epic-6 additive-extension rule,
    and the invalidation rule (version bump + regenerate every issue golden).
- `packages/platform`: registration wiring — stream type `issue` bound to
  `issueReducer` in the E0-T10 registry and all issue validators registered at server
  startup; application projection bootstrap on an issue stream serves the reduced issue at head.
- `ef replay` compatibility: the issue reducer is importable as the `--reducer` module
  and exports `initialStateForStream`; the additive `--stream-id` input initializes the
  same `issueId` used by application projection bootstrap. The CLI never guesses identity
  from a filename, cwd, environment variable, or event payload.
- Property tests (`packages/platform/test/issues.property.test.ts`, seeded, seed
  printed and committed): generate random event sequences over the seven types;
  assert (a) dispatch-level acceptance is _exactly_ `isLegal` under the frozen matrix
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
    `ef replay evidence/golden-issue.jsonl --digest --reducer <module> --stream-id
    issue:maple/reading-room/golden-online` process invocations printing byte-identical
    digests matching the golden.
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
  --reducer <documented module path> --stream-id
  issue:maple/reading-room/golden-online` run twice in fresh shells prints the same
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
3. **Differential legality: reducer vs. door.** Craft event logs _bypassing_
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
   confirm the digest changes; flip a byte in _every_ event one at a time if cheap —
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

### 2026-08-19 — builder — critic rework checkpoint

- Commit `ee1ebe65` adds a non-serialized opened-state marker and a pre-open replay
  no-op guard, including a regression for a second empty `issue.opened`; it also
  corrects the closed-state `state-changed` matrix cell to `refuse`.
- The property suite now generates seeded randomized traces over all seven actions
  with an independently declared legality oracle and runs 1,000 cases for each named
  property (a)-(d). `tools/verify/e5_t01_matrix.mjs` compares all 35 README cells to
  the built table and reports zero forbidden second-legality matches; its output is
  committed at `evidence/matrix-singularity.txt`.
- `make _v-fmt _v-lint _v-typecheck _v-test _v-build` passed: 65 files, 621 tests,
  and both builds. The focused replay check matched
  `d8f26393a6b6912ea9aee063ab399fb972a15d5ab4af2a3beb5aa646ce81dea4` in three
  processes/worlds; mutation sensitivity, purity, `self_check`, and `verify-list`
  also passed. The composed E0-E4 `make verify-E5-T01` run has not yet completed,
  so this ticket remains in progress. Replay: N/A (server + library surface only;
  browser write path is E5-T04).

### 2026-08-20 — builder — serialized composed and cold-clone verification

- Commit `58709e0d0711b070a4e8d176b3107bea2dd2b0a1` is the exact implementation head
  proved here. `VITEST_MAX_WORKERS=1 make --no-print-directory verify-E5-T01` passed
  the composed E0-E4 sweep, including `verify-all: every defined verify target
passed`, the final 65-file/621-test gate, `E5_T01_MATRIX_OK cells=35
forbidden-matches=0`, the expected mutation digest mismatch, `self_check`, and
  `verify-E5-T01: OK`. The serialized worker setting is recorded because prior
  unserialized scheduler runs produced isolated watch-duplex/auth startup timeouts;
  the focused checks passed and this complete serialized run passed without an
  implementation change.
- `bash tools/verify/cold_clone.sh verify-E5-T01` then cloned that committed head
  into a pristine checkout with the verifier's scrubbed environment and trusted
  toolchain path. It passed every registered upstream target and ended with
  `cold_clone: verify-E5-T01 PASSED from a pristine clone` and exit `0`. A prior
  clean-clone attempt stopped at E3-T04 only because the machine exhausted its
  temporary disk while creating a test directory; no repository file was involved,
  and the successful retry is the cited cold-clone proof.
- Replay: N/A (server + library surface only; browser write path is E5-T04) +
  mitigation: stream-layer reducer tests, independent replay/digest checks,
  README matrix parity, composed `verify-all`, and pristine cold-clone proof.

### 2026-08-20 — critic — VERDICT: needs-evidence

- P1/MOCK/COVERAGE — issue integration bootstrap — INSUFFICIENT. The previous
  proof exercised `/api/dispatch` only against the in-memory `IssueAdapter`, while
  the projection assertion called `replayWithReducer` directly
  (`packages/platform/test/issues.test.ts:275-303` and `:452-587`). It did not
  prove that a real Durable Stream record, including server writer metadata, could
  bootstrap the registered issue projection, nor that an `issue.*` action aimed at
  another registered stream type was refused with `unknown-action-type` 404.
  Add a real-stream integration proof and re-record the composed/cold-clone gates.
  Replay: N/A (server + library surface only; browser write path is E5-T04).

### 2026-08-20 — builder — integration rework

- `packages/reducers/src/issues.ts` now gives the registered issue projection
  reducer the same server-metadata normalization as the filesystem projection:
  `actor` and `writer` are removed before strict issue-shape reduction, while the
  pure `issueReducer` remains strict for clean replay input.
- `packages/platform/src/gateway.ts` refuses issue actions on any non-issue stream
  before target mutation with the frozen `unknown-action-type` 404. The new
  `packages/platform/test/issues.test.ts` integration test starts a real
  `createDurableStreamTestServer`, dispatches an issue through the gateway into an
  `OfficialStreamAdapter`, bootstraps that durable stream, reduces the registered
  issue definition at head, and proves the cross-registered-type refusal leaves
  the other stream empty. Focused result: 13/13 tests passed.
- Replay: N/A (server + library surface only; browser write path is E5-T04) +
  mitigation: real Durable Stream dispatch/bootstrap, registered reducer state and
  digest, cross-type 404 neutrality, existing randomized reducer tests, and the
  composed/cold-clone gates to be re-earned at this rework head.

### 2026-08-20 — builder — exact-head composed gate

- Exact implementation head `e12ba5144bf29c3b87492a08aaaa822c6091b7b1` passed
  `VITEST_MAX_WORKERS=1 make --no-print-directory verify-E5-T01` with exit `0`.
  The serialized run completed `verify-all: every defined verify target passed`,
  the E4-T12 capstone, the final repository suite (`65` files, `622` tests),
  `E5_T01_MATRIX_OK cells=35 forbidden-matches=0`, the expected golden mutation
  digest mismatch, and `verify-E5-T01: OK`.
- The real-stream integration proof at this head records two Durable Stream records,
  server writer metadata normalization, registered issue bootstrap digest
  `aa2705cdef253a9a41747a50da43ef9a214b415c5740e6ac87847ac48149f423`, and a
  cross-type `404` refusal with the target stream untouched. The E4 capstone also
  ended with `conflict-events=1` and branch SHA-256
  `3f35967ab2d06d56bcd5f71a8854faffdb4fec8e8e8f91f65189458c2e402856`.
- Replay: N/A (server + library surface only; browser write path is E5-T04) +
  mitigation: real Durable Stream dispatch/bootstrap, registered reducer state and
  digest, cross-type refusal neutrality, randomized reducer tests, composed
  `verify-all`, and the exact-head cold-clone run started from this commit.

### 2026-08-20 — critic — VERDICT: refuted

- P1/ERROR unknown-action handling — FAILED. `isIssueActionType` uses inherited
  property lookup (`packages/reducers/src/issues.ts:105-107`), so `toString` and
  `constructor` can reach envelope parsing instead of the frozen `unknown-action-type`
  404 path and surface as a 502 (`packages/platform/src/gateway.ts:1158-1173,
  1272-1274`). Add own-property validation and regression coverage.
- P2/COVERAGE online/offline digest equality — INSUFFICIENT. The real-stream test
  dispatches two events and records `aa2705...` but never compares its registered
  projection with the offline golden digest `d8f263...`.
- P3/COVERAGE refusal evidence — INSUFFICIENT. `evidence/refusals/issue-http-cases.txt`
  omits request and full response bodies, and `verify-E5-T01` does not validate the
  transcript. Commit exact per-case HTTP evidence and a verifier check.
- P4/COVERAGE property evidence — INSUFFICIENT. The independent oracle runs 1,000
  seeds per property, but no committed seed/count transcript proves that run.
- P5/COVERAGE composed/cold-clone boundary — INSUFFICIENT. The claim names the
  composed gate and a started cold-clone run, but no committed transcript proves the
  exact head, zero `SKIPPED:` lines, or final markers. The cold clone was stopped after
  this refutation, so it is not a passing proof.
- E5-T02 may not advance. Rework E5-T01, re-record the missing deterministic evidence,
  and obtain a fresh critic verdict. Replay: N/A (server + library surface only;
  browser write path is E5-T04) + mitigation remains stream-layer evidence.

### 2026-08-21 — Sol critic — VERDICT: refuted

- P1 online/offline identity equality — FAILED at `b06ec41d`. The integration test
  created a stream-bound projection with `issueId=golden-online`, then asserted the
  frozen digest against a second replay that omitted the stream id and therefore used
  `issueId=""` (`packages/platform/test/issues.test.ts:386-398`). Independent canonical
  hashing observed stream-bound `e3f61f6f...` versus identity-free `d8f26393...`.
  Compare the actual registered projection with offline replay initialized from the
  same explicit stream identity; do not drop `issueId` from the state or digest.
- The inherited-name attacks, all 14 complete refusal transcripts, four 1,000-seed
  property markers, zero-skip composed transcript, and four upstream verifier repairs
  survived independent inspection. The in-flight cold clone was stopped after this
  semantic refutation because it could no longer establish the acceptance claim.
- Replay: N/A (server/library-only; browser write path E5-T04) + stream-layer mitigation.

### 2026-08-21 — builder — stream-identity rework

- Commit `1dfbcd743184b4458542cabc41f9581136c97b42` adds explicit stream-aware
  initialization to custom `ef replay` reducers. `packages/platform/issues-reducer.mjs`
  exports `initialStateForStream`; `--stream-id issue:maple/reading-room/golden-online`
  now initializes the same `issueId` as registered application projection bootstrap,
  without changing the seven-action envelope or excluding identity from `stateDigest`.
- The real Durable Stream projection and two separate offline CLI processes now match
  canonical digest `e3f61f6f10794dd008fc2629f4e6a342b3ed40ff9cec79c971ca879a7182f105`.
  Focused CLI tests pass `38/38`; focused issue tests pass `13/13`; evidence reports
  `14` refusal cases, four `1,000`-seed properties, all `35` matrix cells, and a payload
  mutation changes the digest as expected.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, the serialized repository suite
  (`65` files, `628` tests), and the production build pass. The composed exact-head and
  pristine cold-clone gates are being re-earned after this rework, so the task remains
  `in-progress` until those proofs and a fresh critic verdict exist.
- Replay: N/A (server/library-only; browser write path E5-T04) + stream-layer mitigation.

### 2026-08-21 — builder — inherited provenance refresh

- The first composed attempt after the stream-identity rework ran from exact head
  `830424de9277d170b94259b81b6e5738f2945820`. It passed format, lint,
  typecheck, the full `65`-file/`628`-test suite, all builds, and every verifier
  through E1-T10, then stopped at E1-T11 because that capstone's frozen transport
  provenance correctly detected the intentional Makefile and CLI changes. No E5-T01
  pass is claimed from that stopped run.
- `node tools/verify/e1_capstone.mjs --update-evidence` refreshed only E1-T11's
  transport provenance and manifest at commit
  `7e43e6ce0c6237f0d3b5040599803f645d5f3d81`. The normal capstone verifier then
  passed, and `node tools/verify/e1_capstone_sabotage.mjs` independently rejected all
  nine mutations: evidence drift, event mutation, invalid merge, materialized output,
  restart storage, transport closure, watcher order, writer race, and runtime closure.
- Replay: N/A (server/library-only; browser write path E5-T04) + stream-layer mitigation.

### 2026-08-21 — builder — E2 exact provenance closure repair

- The next composed attempt ran from exact head
  `4c40f63844116fb8d3ce5a7e393e1642a2c0d186`. It again passed all front gates,
  the `65`-file/`628`-test suite, all builds, and E0 through E1-T11. E2-T01's
  work-queue policy then passed all `148` scenarios before its exact provenance
  attester stopped on the intentional rebuilt `packages/cli/dist/src/reducer-worker.js`.
  No E5-T01 pass is claimed from that stopped run.
- Commit `011f8ec77d78ce72bd0b75b7d9cab99078104f26` explicitly adds only the
  stream-aware reducer worker source, its direct CLI regression test, and the two
  executed worker build artifacts to E2-T01's approved provenance inputs. The
  `376`-file closure attester passes, and the independent sensitivity verifier still
  rejects all `13` attacks before restoring a green baseline.
- A downstream preflight found E2-T08's no-database evidence needed the corresponding
  `packages/cli/src/cli.test.ts` line. Commit
  `fa25ec94746f68d5126750cd2de2159b7c9f55eb` refreshes that one-line transcript:
  the scan reports zero violations, both forbidden-storage probes go red, and removing
  the generated composed-gate exclusion also goes red as required.
- Replay: N/A (server/library-only; browser write path E5-T04) + stream-layer mitigation.

### 2026-08-21 — builder — inherited watcher provenance race repair

- The composed run from exact head `4f23c0bb295a97baea65093faa949c2ca2213304`
  passed the front gates, E0, E1, and E2-T01 through E2-T05 before E2-T06's nested
  repository suite exposed an E4-T08 race in
  `retires superseded coalesced apply notices before a later local revert`. The
  remote directory was already materialized, but its watcher notification could
  arrive before the downlink apply-journal commit and therefore never receive a
  post-commit suppression retry. No E5-T01 pass is claimed from that stopped run.
- Commit `5ddbc8c8` retries downstream provenance consumption at the committed
  downlink checkpoint. Its regression pauses the downlink after rename, forces the
  uplink to observe before the journal record exists, closes that watcher, and then
  proves the checkpoint handoff records the apply without echoing. Removing only the
  retry makes that exact test fail; restoring it passes the focused case, all `14`
  duplex watcher cases, the `65`-file/`628`-test suite, format, lint, typecheck, and
  the production build.
- The exact-head E2-T06 rerun then passed all behavior, replay, restart, and runtime
  checks before its frozen no-database transcript detected the intentional watcher
  and CLI test additions. Commit `3773c536` refreshes only that transcript. The
  attester reports `630` scanned files with zero unallowlisted and zero stale
  findings; its sensitivity suite turns all `11` forbidden side-state/fingerprint
  attacks red while allowing a content-preserving line shift.
- The subsequent composed run from `798446f6` passed the full front suite and all E0
  and E1 behavior through E1-T10, then E1-T11's frozen manifest rejected the rebuilt
  duplex transport output. Commit `edab4b62` refreshes only E1-T11's manifest and
  transport provenance; the capstone passes and all nine sabotage mutations are
  rejected. A proactive exact-head `verify-E2-T01` then passed all `148` queue-policy
  scenarios, its `376`-file provenance closure, and all `13` closure attacks.
- Replay: N/A (CLI/server regression repair) + mitigation: deterministic phase-gated
  race reproduction, mutation sensitivity, full duplex suite, and serialized root
  gates. The exact-head composed and pristine cold-clone proofs still must be
  re-earned, so E5-T01 remains `in-progress`.

### 2026-08-22 — builder — exact-head composed and pristine closure

- Code head `bbb6d1033cbfd8448b0b810fc0234af781ef5570` passed
  `VITEST_MAX_WORKERS=1 make --no-print-directory verify-E5-T01` with exit `0`.
  Commit `062ec9d5602ee54915dab8999f781ae3a22318c3` records that immutable run at
  `evidence/composed-gate.txt`; it contains the E4-T12 capstone,
  `verify-all: every defined verify target passed`, the final `65`-file/`628`-test
  suite, `E5_T01_REAL_STREAM_INTEGRATION_OK` with registered/offline digest
  `e3f61f6f10794dd008fc2629f4e6a342b3ed40ff9cec79c971ca879a7182f105`, all
  `14` refusal cases, four independently named `1,000`-seed properties, all `35`
  matrix cells, mutation sensitivity, and `verify-E5-T01: OK`.
- The watcher closure is part of the proved history: `026e3955` reaps the daemon
  before `ef watch stop` returns; `ad2a5986` and `cfc76291` refresh only the exact
  inherited provenance; Sol-authored `bbb6d103` tracks launcher and detached watcher
  PIDs through cleanup. Both the composed run and pristine clone exercise
  `TEARDOWN interrupted-run EXPECTED-FAIL tracked-children=4 tracked-watchers=2
  survivors=0 OK`; neither transcript contains `ENOTEMPTY` or a nonzero survivor.
- `bash tools/verify/cold_clone.sh verify-E5-T01` cloned exact committed head
  `062ec9d5602ee54915dab8999f781ae3a22318c3`, hydrated dependencies from the
  lockfile-verified pnpm store under a scrubbed environment, and exited `0` with
  `cold_clone: verify-E5-T01 PASSED from a pristine clone`. Transcript audit:
  `SKIPPED:` lines `=0`, `ENOTEMPTY=0`, nonzero survivors `=0`, and make/cold-clone failure
  markers `=0`.
- Replay: N/A (server/library-only; browser write path is E5-T04) + mitigation:
  real Durable Stream dispatch and registered projection bootstrap, explicit
  stream-identity offline replay parity, immutable refusal transcripts, seeded
  properties, matrix/singularity checks, mutation sensitivity, the full composed
  gate, and the pristine cold-clone proof above.

### 2026-08-22 — Sol critic — VERDICT: refuted

- P1 boundary validation — FAILED. The task's own adversarial boundary probes must be
  refused without append, but fresh HTTP attacks accepted all three: JSON `v: 1.0`
  returned `202` and moved head `-1 -> 0`; a `10 MiB` body returned `202` and moved
  head `-1 -> 0`; and astral/NUL-adjacent title/body text returned `202` and moved head
  `-1 -> 0`. Each accepted append also changed the replay digest. `request.json()`
  normalizes the numeric spelling `1.0` to `1`, while the issue envelope currently
  accepts unbounded strings and checks only the parsed value. Enforce the promised
  request-boundary policy and promote all three attacks into the committed HTTP/fuzz
  corpus before re-recording evidence.
- Stream identity — PASSED. Registered real-stream projection and two offline CLI
  processes matched
  `e3f61f6f10794dd008fc2629f4e6a342b3ed40ff9cec79c971ca879a7182f105` for
  `golden-online`; replaying the same events under `golden-other` produced a distinct
  identity-bound digest, and substituting only the expected `issueId` reconciled both
  state and digest.
- Refusal, matrix, property, watcher, and existing evidence checks — PASSED. Fresh
  inherited-name/schema/version/cross-type attacks and all 14 committed refusal cases
  had exact taxonomy and log neutrality; fresh seeds `40000..40999` passed all four
  1,000-case properties; the independently transcribed 35-cell matrix passed; the
  interrupted watcher harness ended with `tracked-children=4`, `tracked-watchers=2`,
  `survivors=0`, and `live-after=0`. The immutable composed and pristine-clone
  transcripts passed audit with zero `SKIPPED:`, `ENOTEMPTY`, nonzero survivors, or
  make/cold-clone failure markers, but they cannot override the boundary refutation.
- COVERAGE: issue reducer/envelope/validators, gateway/authz registration, CLI stream
  identity, real Durable Stream bootstrap, refusal paths, matrix/property checks, and
  watcher teardown repairs executed; generated provenance/type/export/documentation
  hunks are waived because their exact-head attesters ran; no dead code was identified.
  SUITE: no promotion until the refutation is repaired; then promote the three boundary
  probes as permanent regressions.
- Replay: N/A (server/library-only; browser write path is E5-T04) + mitigation: real
  Durable Stream projection/CLI parity, exact refusal neutrality, independent
  matrix/property attacks, mutation sensitivity, exact-head composed/cold-clone
  transcript interrogation, and focused teardown verification.

### 2026-08-22 — Sol critic — VERDICT: refuted

- P1 malformed UTF-8 neutrality — FAILED at evidence commit
  `2ddb8460b8195416d4a956b4fb3d8534ef137801`. Predicted a raw dispatch body containing
  invalid UTF-8 bytes `c3 28` inside `issue.opened.payload.body` would return the
  frozen malformed-body `400` and leave head/digest unchanged; observed HTTP `202`,
  one appended event, and stored replacement text `�(`. The Node HTTP adapter decoded
  request bytes non-fatally before `PlatformGateway`, and the gateway also used a
  non-fatal decoder (`packages/platform/src/server.ts`,
  `packages/platform/src/gateway.ts`). Preserve bytes through the HTTP adapter, decode
  UTF-8 fatally at the dispatch boundary, map failure to `malformed_json`, and promote
  the exact raw-byte no-append regression.
- Exact `10,485,760` request bytes are inclusive under the current module contract and
  are not a finding; the committed `10 MiB` issue-body attack remains over the request
  ceiling and over the issue-string ceiling. The pristine cold clone was stopped at
  exit `130` after this independent semantic refutation and is neither a pass nor a
  claimed proof.
- Replay: N/A (server/library-only; browser write path is E5-T04) + mitigation: focused
  live-TCP raw-byte reproduction, exact before/after stream digest and head, and the
  existing composed transcript. E5-T01 remains `in-progress`; E5-T02 may not advance
  until this refutation is repaired and re-verified.

### 2026-08-22 — builder — malformed UTF-8, deterministic seed, and exact-commit closure

- Commit `802eb3792e015f56af98db0f2e1c659ac715a514` preserves raw dispatch bytes through
  the Node HTTP adapter, decodes UTF-8 fatally at the dispatch boundary, maps malformed
  bytes to the frozen `malformed_json` response, and promotes the critic's exact
  `c3 28` live-TCP attack as a permanent no-append regression. The recorded refusal
  returns `400` with head `-1` and digest
  `ce0d1a44cd61cc6aea4dbc0da9f1c7d72e10ba1265d78abf070fc087489fa4ba`
  unchanged.
- Commit `dd82c29fd1723f509e3f770ebd71076b4276ad01` terminates and reaps the browser proof
  runner on interrupted verification. The composed and cold-clone proofs both execute
  `TEARDOWN interrupted-run EXPECTED-FAIL tracked-children=4 tracked-watchers=2
  survivors=0 OK`; neither contains `ENOTEMPTY` or a nonzero survivor.
- Commit `4109b17739fa16b36168134fea98c4a12960d4fb` injects the canopy seed clock into
  StreamFS and carries it across branches, making the generated corpus deterministic.
  Commit `5e1089c11b66aa5e99de8ac93ef3128d29b3f125` pins the resulting canopy digest
  `fafd5a1f443b5cb98c6a0c8db2251d011904cf2b8d57bebb8ad3392d4ad0e4ed`.
  Commits `f8f8783e82156ae6291979603d1ac1c172ef53a9` and
  `bf5509ee366349deffbbf167e04332be64f03e62` refresh only the exact inherited E1/E2
  provenance exercised by those repairs.
- Exact code head `bf5509ee366349deffbbf167e04332be64f03e62` passed
  `VITEST_MAX_WORKERS=1 make --no-print-directory verify-E5-T01` once with exit `0`.
  Commit `dceb70441f9bf9da5ac011b5e852f1ad5a780408` freezes that run at
  `evidence/composed-gate.txt`: SHA-256
  `ae8d9b39038e2a77c27086f6b04f31a4973c243297d5d80275635eb3a854a9eb`,
  `22,536` lines, `1,822,238` bytes. It includes `65` files / `634` tests,
  `verify-all: every defined verify target passed`, real Durable Stream integration,
  all `14` refusal cases, the malformed UTF-8 and lexical/boundary/scanner/recovery
  probes, four named `1,000`-seed properties, all `35` matrix cells, mutation
  sensitivity, and `verify-E5-T01: OK`. Audit counts are zero for `SKIPPED`,
  `ENOTEMPTY`, nonzero survivors, and make failures.
- `bash tools/verify/cold_clone.sh verify-E5-T01` ran exactly once from committed head
  `dceb70441f9bf9da5ac011b5e852f1ad5a780408` and passed from a pristine clone with
  exit `0`. The immutable external transcript `/tmp/e5-t01-final-cold-clone.txt` has
  SHA-256 `6d0132703778f1469bb7d3011db5c340a922d71e14de68a218117e804f6c3d33`,
  `22,855` lines, and `1,635,964` bytes; final lines are `verify-E5-T01: OK` and
  `cold_clone: verify-E5-T01 PASSED from a pristine clone`. Its audit counts are zero
  for `SKIPPED`, `ENOTEMPTY`, nonzero survivors, make errors, and cold-clone failures.
- Replay: N/A (server/library-only; browser write path is E5-T04) + mitigation: real
  Durable Stream dispatch and projection, exact online/offline identity-bound replay,
  committed raw-byte and boundary refusal evidence, deterministic corpus/properties,
  matrix and mutation sensitivity, the immutable exact-head composed proof, and the
  one pristine exact-commit cold-clone proof above.

### 2026-08-22 — Sol critic — VERDICT: verified

- P1 dispatch boundary and refusal neutrality — PASSED. Predicted malformed raw UTF-8
  `c3 28`, lexical versions `1.0`/`1e0`/`1E+0`, requests over `10,485,760` bytes,
  strings over `1,048,576` UTF-16 code units, and NUL/surrogate-bearing values would
  receive the frozen 4xx class without changing head or digest. A fresh live-TCP probe
  observed `c3 28 -> 400 malformed_json`; all `29` hostile refusals were neutral;
  exact request/string limits were accepted and each `+1` case was refused; all NUL
  and astral probes were `422`. Escaped path keys, duplicate last keys/payloads,
  ancestor objects, array decoys, and string decoys followed parsed last-key semantics
  across `7` fresh scanner cases. Transcript `/tmp/e5-t01-critic-probes.txt`, SHA-256
  `c74f369804c4e827fa26e11449db0511a801bfe16fcb5d7ffc23f1710776e732`.
- P2 precedence, recovery, matrix, and state shape — PASSED. Authentication won before
  lexical/schema checks; unknown/cross-type and prototype names (`toString`,
  `constructor`, `__proto__`, `hasOwnProperty`) returned `404`; schema validation won
  before workflow validation. A refused lexical request made zero mutation calls, the
  same stable operation id then accepted exactly once, and a later lexical retry could
  not recover the prior receipt. The independently transcribed workflow matched all
  `35` cells; illegal hand-written replay events were deterministic no-ops; equivalent
  label states had equal digests while distinct comment orders differed.
- P3 determinism and properties — PASSED. Fresh xorshift seeds `90000..90999`, `37`
  steps each, exercised all seven actions and five states: validator acceptance matched
  the independent oracle, accepted states stayed canonical, duplicate replays matched,
  and refused-event interleavings were neutral. A separately generated real Durable
  Stream of `500` events (`499` comments) bootstrapped at offset
  `0000000000000000_0000000000000499`; application projection, direct reduction, and
  two offline processes under different cwd/TZ worlds matched digest
  `343c18f7f672bfd95bbc50218ae0026c10f3e82cadb1f6daf08ef4f901546380`, while changing
  only stream identity changed the digest.
- P4 committed focused apparatus — PASSED. `CI=true pnpm exec vitest run
  --maxWorkers=1 --disableConsoleIntercept packages/platform/test/issues.test.ts`
  passed `18/18`; `node tools/verify/e5_t01_evidence.mjs
  /tmp/e5-t01-critic-focused-suite.txt` reported `14` refusal, `19` boundary, `3`
  precedence, `10` scanner, `1` recovery, and `4` property cases; `node
  tools/verify/e5_t01_matrix.mjs` reported `cells=35 forbidden-matches=0`. Focused
  transcript SHA-256
  `beea56744b305570d53ce8e4a47e55477ff09074e93a96846673db83a5fe321d`.
- P5 teardown, deterministic canopy, and exact-head provenance — PASSED. A fresh
  `tools/verify/e4-sync/run.sh --seed 424242 --mode lockstep --interrupt-after 2`
  attack exited nonzero as intended and reported `tracked-children=4`,
  `tracked-watchers=2`, `surviving-report=0`, `live-after=0` (transcript SHA-256
  `23b302d65452479b469ce6317938250625868e952d927d3404d5d5c7c1fd8c10`). Source/diff
  inspection confirmed the injected clock reaches normal and branch StreamFS repos;
  the exact-head gate exercised the clock regression and pinned canopy evidence digest
  `fafd5a1f443b5cb98c6a0c8db2251d011904cf2b8d57bebb8ad3392d4ad0e4ed`.
  The committed composed transcript is exactly SHA-256
  `ae8d9b39038e2a77c27086f6b04f31a4973c243297d5d80275635eb3a854a9eb`, `22,536`
  lines / `1,822,238` bytes, from code head `bf5509ee`; the external pristine-clone
  transcript is exactly SHA-256
  `6d0132703778f1469bb7d3011db5c340a922d71e14de68a218117e804f6c3d33`, `22,855`
  lines / `1,635,964` bytes, cloned from `dceb7044`. Both terminate in the claimed
  pass markers and contain zero `SKIPPED`, `ENOTEMPTY`, nonzero survivors, make errors,
  or cold-clone failures. Commit `7be12931` changes only this task claim and queue.
- SENSITIVITY — PASSED. In a detached scratch worktree at `7be12931`, replacing only
  `new TextDecoder("utf-8", { fatal: true })` with a non-fatal decoder made
  `CI=true pnpm exec vitest run --maxWorkers=1 packages/platform/test/issues.test.ts
  -t 'refuses malformed UTF-8 over live HTTP without append'` fail: predicted the
  regression would observe the old acceptance bug, and it observed HTTP `202` where
  `400` was required. Transcript `/tmp/e5-t01-critic-sabotage.txt`, SHA-256
  `53eadc0f14e6666c7f261457633e49aace3af25d7aaf6f5e854d81f6c33ecf07`. The scratch
  worktree was removed after the run.
- COVERAGE — issue reducer/envelope/scanner/validators, gateway/server byte boundary,
  authz and writer recovery ordering, CLI stream identity, registered real-stream
  projection, all workflow/refusal paths, properties, deterministic clock, and teardown
  repairs executed. Generated provenance, exports, docs, and configuration hunks are
  waived because their exact-head attesters ran. The diff contains no `.skip`, `.todo`,
  inline lint disable, or dead implementation identified by this review.
- SUITE — retain the committed raw-byte, boundary/scanner/recovery, 35-cell matrix,
  1,000-seed properties, clock, and teardown regressions. The disposable sabotage and
  fresh hostile inputs are discarded because they duplicate those now-proven permanent
  checks rather than add a new stable corpus shape.
- Replay: N/A (server/library-only; browser write path is E5-T04) + mitigation: live
  raw-TCP refusals, real Durable Stream projection and 500-event identity-bound parity,
  exact digest neutrality, fresh properties, matrix/state-shape attacks, teardown and
  mutation sensitivity, plus immutable composed and pristine-clone evidence.
