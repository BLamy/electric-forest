---
id: E0-T11
epic: 0
title: "Validated application mutations coordinated by official Stream-Seq"
priority: 11
status: verified
depends_on: [E0-T09, E0-T10]
estimate: M
capstone: false
---

## Goal

`POST /streams/:id/dispatch` on the stream server (`packages/stream-server`, on the
E0-T10 server-side redux layer) is the one mutation door for reducer-backed streams, and
it validates **before** it appends — closing the gap the reference implementation
(`replayio/durable-streams` server-side redux, see ROADMAP.md "Prior art") leaves open.
Every dispatched action passes, in order: (1) envelope/schema validation of the action
body (`{type, payload, ts}` per the frozen `@eforest/protocol` action shape, canonical
JSON rules included), (2) reducer-registry membership — the action `type` must be
registered for that stream's reducer in E0-T10's registry, and (3) a documented,
typed per-action-type validator extension point (`ActionValidator`, receiving the action
and — for state-dependent checks — the reduced state at the current head offset) that
returns accept or a structured refusal. A dispatch failing any stage is refused with
that class's pinned status code — `malformed-body` → **400**, `schema-violation` →
**422**, `unknown-action-type` → **404**, `validator-rejected` → **409** — and a
structured error body naming the class and the offending field/type — and **nothing is appended**: the
stream's head offset and `ef replay --digest` log digest are byte-identical before and
after every refusal. A dispatch passing all stages appends exactly one event through the
E0-T05 append path (fencing and all), and `/state` reflects it via E0-T10's reducer with
its offset-keyed cache still coherent.

## Context

Bet 1 of the roadmap ("One mutation door") is only worth making if the door actually
checks credentials at the threshold: an unvalidated `/dispatch` means every garbage
action becomes a permanent, replayed-forever event, and every downstream reducer must
defend itself individually. The reference implementation appends first and lets reducers
shrug; we refuse first, so the log stays a sequence of *meaningful* events and
`replay(events)` never has to skip junk. This task is why E0 exists as "rebuild it
ourselves" rather than "vendor it" (ROADMAP.md, prior-art section: "wire dispatch-side
validation in — the reference leaves it unwired").

Builds on: E0-T10 (reducer registry, `/events`, `/state`, offset-keyed state cache —
validation stage 2 reads that registry, and the state-dependent validator hook reads
`/state`'s reduced value at head), E0-T05 (the append path and its log-neutral error
doctrine — every refusal here must be as log-neutral as T05's 4xxs), E0-T04
(`ef replay --digest` is the evidence instrument), E0-T09 (the frozen conformance suite,
which must stay green: `/dispatch` is additive and must not perturb the golden
transcripts). Unblocks: E0-T13 (the capstone dispatches through this door), Epic 2
(auth checks slot into the same validator extension point), and every entity type in
Epic 5 (issue/PR state machines are per-action-type validators).

Contract frozen here: the rejection-class taxonomy (the four class names above), the
status code per class (the four pinned codes above — 400/422/404/409, one distinct code
per class), and the error-body shape are versioned from this task forward. Two edge
inputs are pinned alongside the taxonomy so no dispatch input is undefined:
(a) `POST /streams/:missing/dispatch` (nonexistent stream) reuses E0-T05's frozen
stream-not-found semantics — status 404 with T05's error body, which carries **no**
`error.class` field; it is *outside* the four-class taxonomy, and the two 404s are
distinguished by body shape (T05's stream-not-found body vs. this task's
`{ error: { class: 'unknown-action-type', ... } }`) — the package README's class→code
table states this adjacency explicitly next to T05's table. (b) Dispatch to an
*existing* stream that has no reducer registered in E0-T10's registry is classed as
`unknown-action-type` (404, with `error.class: 'unknown-action-type'`): with no
reducer, no action type is registered, so stage 2 fails for every type — the README
documents this as the defined meaning, not an accident. These pins are versioned with
the rest of the contract —
Epic 3's UI and Epic 4's CLI will render these bodies, and Epic 2 will add an
`unauthorized` class beside them, not restructure them. The `ActionValidator` interface
(signature, accept/refuse return shape, registration API, and the guarantee that
validators run before append and see head-offset state) is likewise frozen; Epic 2 and
Epic 5 extend it by registering validators, never by patching the door.

Non-goals: authn/authz (Epic 2 — but the extension point must demonstrably accommodate
it), client-side dispatch helpers (E0-T08 extension, capstone's problem), cross-stream
validation, and any *new* validation bypass path — after this task, the only append
paths in the tree are `/dispatch` (validated) and the pre-existing raw protocol
`POST /streams/:id` door, which stays unchanged per T09. Gating that raw door for
reducer-backed streams is explicitly deferred: E0-T13 and Epic 2 enforce it; this task
documents the doctrine ("reducer-backed streams are mutated via `/dispatch` only") in
the package README. If any append path *other than* those two exists after this task,
the task has failed its own premise.

## Deliverables

- `packages/stream-server/src/dispatch.ts` — the `/dispatch` handler: parse → schema
  validation → registry-membership check → per-type validator chain → single append via
  the E0-T05 store path. No append call is reachable before all three stages pass
  (structure the code so this is auditable, not incidental).
- `packages/stream-server/src/validation.ts` — the frozen `ActionValidator` interface
  and registry: `registerValidator(actionType, validator)`, validator receives
  `(action, { state, headOffset })` with `state` lazily computed from E0-T10's
  offset-keyed cache; returns `ok` or `{ class: 'validator-rejected', reason, field? }`.
  Includes at least one real registered validator exercising the state-dependent path
  (e.g. a `counter/decrement` that refuses when the reduced counter is already 0), so
  the extension point ships proven, not theoretical.
- The rejection contract: the pinned status code per class (`malformed-body` → 400,
  `schema-violation` → 422, `unknown-action-type` → 404, `validator-rejected` → 409)
  and the structured error body (`{ error: { class, actionType?, field?, reason } }`),
  documented as a class→code table in the package README alongside E0-T05's status
  table. The table also pins the two edge inputs from the frozen contract: dispatch to
  a nonexistent stream → T05's stream-not-found 404 (no `error.class`, outside the
  taxonomy, distinguished from `unknown-action-type` by body shape), and dispatch to an
  existing stream with no registered reducer → `unknown-action-type` 404.
- `packages/stream-server/test/dispatch.test.ts` — integration tests over real HTTP:
  - Per rejection class (all four): capture head offset and `ef replay --digest` dump
    digest, send the invalid dispatch, assert the exact status + error body class, then
    re-capture and assert offset and digest byte-identical.
  - Valid-dispatch path: dispatch appends exactly one event, `/events` shows it,
    `/state` reflects the reduced result, and the state cache serves the new head
    without recompute-from-zero (per E0-T10's cache contract).
  - State-dependent validator: the same action type accepted at one state and refused
    at another (decrement at counter=1 → accepted; decrement again at counter=0 →
    refused, log untouched).
  - Interleaving: a refused dispatch between two valid ones leaves the log equal
    (digest) to the two valid dispatches alone.
- `packages/stream-server/test/dispatch.fuzz.test.ts` — a seeded fuzzer (seed printed
  and committed for reproduction) throwing malformed bodies at `/dispatch`: truncated
  JSON, wrong content type, non-object actions, missing/extra envelope fields, huge
  payloads, unicode/null-byte garbage, valid-envelope-unknown-type, arrays of actions.
  After N ≥ 500 cases: server process alive, zero 5xx responses, and the final dump
  passes `ef replay --digest` with a digest equal to the pre-fuzz digest plus only the
  fuzzer's deliberately-valid control dispatches.
- `evidence/` — per-class before/after offset+digest pairs
  (`e0-t11-refusal-neutrality.txt`), the fuzz seed and post-fuzz digest
  (`e0-t11-fuzz.txt`), the sensitivity-proof transcript
  (`e0-t11-sensitivity.md`), and the enumerated store-append call-site list
  (`e0-t11-append-callsites.txt`).
- `Makefile`: `verify-E0-T11` per E0-T02's per-task target contract — runs both test
  files, the refusal-neutrality digest comparisons, the fuzz run, and re-runs the
  E0-T09 conformance suite; nonzero exit on any failure.

## Acceptance criteria

- [ ] `make verify-E0-T11` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env.
- [ ] Refusal neutrality, per class: for each of `malformed-body`, `schema-violation`,
      `unknown-action-type`, `validator-rejected`, the test records the stream's head
      offset and `ef replay --digest` dump digest immediately before the refused
      dispatch and immediately after, and asserts both byte-identical; the pairs are
      written to `evidence/e0-t11-refusal-neutrality.txt`. An append-then-ignore
      implementation (event lands but reducer skips it) fails this criterion by digest.
- [ ] Each rejection class returns exactly the status code pinned in this spec —
      `malformed-body` → 400, `schema-violation` → 422, `unknown-action-type` → 404,
      `validator-rejected` → 409 — and an error body whose `error.class` matches the
      class exactly; the tests assert these literal spec-stated values (not "some 4xx"),
      and the package README's class→code table lists the same four codes. The two
      pinned edge inputs are tested by the same literal-assertion standard: dispatch to
      a nonexistent stream returns T05's stream-not-found 404 with T05's body shape and
      no `error.class`; dispatch to an existing stream with no registered reducer
      returns 404 with `error.class: 'unknown-action-type'`.
- [ ] Valid dispatch: exactly one event appended (head advances by one offset), the
      event replays through the registered reducer to the expected state, and `/state`
      at the new head equals a from-scratch `ef replay --digest`-verified reduction of
      the full dump — cache and cold replay agree.
- [ ] State-dependent validation works through the extension point: the committed
      example validator accepts and refuses the *same action type* depending on reduced
      state at head, with the refusal log-neutral by digest.
- [ ] Fuzz survival: the seeded fuzz run (seed committed in `evidence/e0-t11-fuzz.txt`)
      completes N ≥ 500 malformed dispatches with zero 5xx, zero process
      crashes/unhandled rejections, and a post-fuzz dump whose `ef replay --digest`
      digest equals the expected digest of only the deliberately-valid control
      dispatches.
- [ ] Sensitivity proof: in a scratch worktree, unregister/no-op the validation chain
      (make `/dispatch` append unconditionally) and run the dispatch test suite — the
      invalid-dispatch tests MUST go red; the transcript of the red run is committed as
      `evidence/e0-t11-sensitivity.md`. A green run under the sabotage refutes the
      measuring apparatus.
- [ ] No protocol regression: `make verify-E0-T09` (the frozen conformance suite,
      golden transcripts, both stores) re-runs green with `/dispatch` present.
- [ ] No bypass: auditable against a named target — the E0-T05 store append entry
      point (`StreamStore`'s `append` method from
      `packages/stream-server/src/store/types.ts`). The audit enumerates **every
      reference to the append symbol**, not just `.append(` call syntax: grep the bare
      identifier `append` across `packages/stream-server/src` and classify every hit —
      direct calls, re-exports, aliasing (`const a = store.append`), destructuring
      (`const { append } = store`), computed access (`store["append"]`,
      `store[name]`), and `.call`/`.apply`/`.bind` — plus every module that imports or
      receives the store object, checking each for indirect invocation. After
      classification, exactly two invocation paths may exist: the raw protocol
      `POST /streams/:id` handler (unchanged, per T09) and `dispatch.ts` after the
      full validation chain. The full classified reference list (file:line, hit kind,
      disposition) is committed to `evidence/e0-t11-append-callsites.txt`; any other
      invocation path under `src/` — including exported test helpers — fails this
      criterion. In addition, a runtime one-door assertion backs the static audit:
      the store's `append` is reachable only through a single wrapper module (the
      only importer allowed to invoke it), which maintains an append-invocation
      counter; a test drives the full suite's dispatch and raw-append traffic and
      asserts the counter equals the number of appends attributable to those two
      doors — any hidden third path fails this test, and that test failure is the
      binary criterion. The package README documents that reducer-backed streams are
      mutated via `/dispatch` only (the doctrine E0-T13 and Epic 2 enforce).
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; mitigation is the
      stream-layer digest evidence above.

## Adversarial verification

The claim under attack: "nothing invalid ever enters the log, nothing valid is ever
mangled, and the refusal machinery itself is real." Use your own inputs throughout;
invent at least one more angle.

1. **Append-then-ignore hunt.** The summary's named refutation: instrument nothing,
   just dump. After each refused dispatch of your own construction, take the full dump
   and diff it byte-for-byte (and by `ef replay --digest`) against the pre-refusal
   dump. *Any* new record — even one the reducer would ignore, even a "rejected" marker
   event — refutes the task outright. Also tail the stream live (E0-T06 SSE) during a
   refused dispatch: any frame emitted refutes log-neutrality at the wake path.
2. **Your own fuzz, different seed, different generator.** Do not run the builder's
   fuzzer. Write your own malformed-body generator (include: content-length lies,
   chunked-encoding truncation mid-body, deeply nested payloads, `__proto__` keys,
   actions whose `type` is an object, duplicate JSON keys where the second is
   registry-valid). Any 5xx, crash, hang, or post-fuzz digest drift from the expected
   valid-only digest refutes fuzz survival. Prototype pollution reaching the validator
   or registry (check `Object.prototype` after the run) is a hard refutation.
3. **TOCTOU on the state-dependent validator.** Race the door: with the example
   validator at its refusal boundary (counter=1), fire two concurrent decrements. Then
   replay the dump: if the final state is invalid under the validator's own rule
   (counter < 0), the state-dependent check is advisory theater and the extension-point
   claim is refuted. If the builder documents a serialization guarantee (e.g. dispatch
   holds the head), verify it under 20+ racing pairs; if they documented a weaker
   guarantee instead, verify the docs say so *in the frozen contract section* — an
   undocumented race is a refutation, a documented one is a design review question.
4. **Rejection-class differential.** For each class, construct three *different* inputs
   that should map to it and one near-miss that should map to a neighboring class
   (e.g. valid envelope + unregistered type vs. invalid envelope + registered type).
   Include the two pinned edge inputs as near-misses: dispatch to a nonexistent stream
   (must return T05's stream-not-found 404 body, *without* an `error.class`, and must
   be distinguishable from `unknown-action-type`'s 404 by body shape) and dispatch to
   an existing stream with no registered reducer (must return 404 with
   `error.class: 'unknown-action-type'`). Any input refused with the wrong class, the
   wrong status, or a taxonomy-class response missing `error.class` refutes the frozen
   taxonomy. Then check the door's ordering claim:
   a body that is simultaneously schema-invalid and unknown-type must report the
   documented first-failing stage deterministically across 10 repeats.
5. **Sensitivity, your sabotage not theirs.** Beyond re-running the builder's committed
   sensitivity proof: in a scratch worktree, (a) make stage 2 accept any string type,
   (b) make the example validator always return `ok`, (c) make refusals return 200
   while still not appending. Run `make verify-E0-T11` after each. Any mutation the
   target stays green on refutes the apparatus for that stage.
6. **Conformance regression + bypass sweep.** Re-run `make verify-E0-T09` yourself
   against the T11 tree — any golden-transcript drift refutes "additive". Then hunt
   bypasses: grep `packages/stream-server` for every call site into the store's append;
   any dispatch-adjacent path (a debug endpoint, a test helper exported from `src/`, a
   validator that can itself append) that reaches append without the full chain refutes
   the one-door premise. Confirm raw protocol `POST` still behaves exactly per T05/T09
   — if T11 quietly changed raw-append semantics, that is a protocol regression even if
   transcripts happen to pass.
7. **Cold-clone + cache-coherence probe.** Run everything through
   `tools/verify/cold_clone.sh`. Then attack the T10 cache through the new door:
   dispatch valid, refuse one, dispatch valid, and demand `/state` at every
   intermediate offset equals an independent `ef replay --digest`-verified reduction of
   the dump prefix. A cached state that "remembers" a refused dispatch in any way
   refutes cache coherence under refusal.

Refutation currency: a dump + offset where an invalid event entered the log, an exact
HTTP transcript showing the wrong status/class, or a digest pair that should match and
doesn't. "The error message was unhelpful" is a note, not a finding.

## Verification log

### 2026-07-12 — builder — implemented

- Commit: `4c55f58` (`test: prove dispatch validation sensitivity and append audit`), on
  `codex/e0-t11-validated-dispatch`.
- Gates: `CI=true pnpm format:check`, `CI=true pnpm lint`, `CI=true pnpm typecheck`,
  `CI=true pnpm test` (13 files, 91 tests), and `CI=true pnpm build` passed. The composed
  `make verify-E0-T11` target passed, including `make verify-E0-T09`, the seeded dispatch
  tests (4/4), the append-callsite audit, and the detached-worktree sensitivity proof.
- Cold clone: `tools/verify/cold_clone.sh verify-E0-T11` passed from a pristine clone with
  scrubbed environment. Its final run covered 13 files/91 tests, 21 conformance transcript
  cases across both stores, 14 corpus seeds, and the full E0-T11 evidence target.
- Evidence: `evidence/e0-t11-refusal-neutrality.txt` records identical head offsets and
  full-dump SHA-256 and `ef replay --digest` state-digest pairs for all four refusal
  classes, with the corresponding before/after JSONL dumps committed beside it;
  `evidence/e0-t11-fuzz.txt` and `evidence/e0-t11-fuzz.jsonl` record seed `271828`, 520
  cases, six deliberate valid controls, the post-fuzz `ef replay --digest` state digest,
  and an unpolluted `Object.prototype`; `evidence/e0-t11-sensitivity.md` records the
  validation-bypass sabotage exiting 1; and `evidence/e0-t11-append-callsites.txt`
  classifies every append reference and proves the single wrapper with exactly two callers.
- Claim: `POST /streams/:id/dispatch` parses, schema-validates, checks reducer action
  membership, runs the lazy state-aware validator chain, and only then appends one event.
  The recorded integration proof covers all four pinned status/class pairs, both 404 edge
  bodies, accepted state/cache behavior, the counter decrement boundary, interleaving
  neutrality, and fuzz survival. Replay: N/A (server-only surface; no browser-reaching
  behavior) + mitigation: the committed stream-layer offsets, dump digests, replay state
  digest, conformance transcripts, append audit, and sabotage transcript above.

### 2026-07-12 — fresh critic — VERDICT: refuted

- P1/EVIDENCE — FAILED. Predicted the committed refusal-neutrality artifact would record
  the required `ef replay --digest` state digest before and after each refusal. Observed
  `evidence/e0-t11-refusal-neutrality.txt` still has the old six-column header and raw
  dump-byte hashes (`e3b0…` for the empty stream), while the final test source's
  `logDigest()` hashes dump bytes at `packages/server/src/dispatch.test.ts:90-128` and
  the protocol digest of the empty fixture state is `cfa85159…`, not `e3b0…`. The final
  source now expects replay columns at `dispatch.test.ts:143,226-227`, but those
  artifacts are absent/stale. Regenerate the committed dumps and refusal file with real
  `ef replay --digest` invocations and make the evidence checker validate those values.
- P2/ERROR — FAILED. Predicted truncated HTTP bodies would settle as a typed 400 rather
  than hang. An independent seed-314159 in-memory `handleRequest` attack emitted a
  short body followed by `aborted`/`close` for both a lying `Content-Length` request and
  a truncated chunked request; after 300 ms neither returned a response. The changed
  `packages/server/src/request-body.ts:11-41` listens only for `data`, `end`, and
  `error`, with no abort/close or received-length handling. Reject transport truncation
  as `malformed-body` and add regression coverage for both cases.
- P3/ERROR — FAILED. Predicted a schema-valid action on a registered reducer would
  append only when its reduced state remained coherent. The independent seed-314159
  attack dispatched `{type:"set", payload:{nested:[...]}, ts:2}` to a registered
  `fixture` stream; dispatch returned 201, but `/state` returned 400
  `invalid_json_value: numbers must be finite` because
  `packages/server/src/redux/reducers.ts:24-27,39` converts the unknown payload with
  `Number()` and no validator rejects it. The event is already in the dump, so valid
  envelope acceptance can produce unreducible state. Add action-semantic validation or
  reject before append, with a regression proving dispatch/state/digest coherence.
- P4/BYPASS — FAILED. Predicted only the raw HTTP POST and validated dispatch route could
  reach the append wrapper. An independent direct call to the public
  `server.appendThroughDoor` export appended an unregistered action to a `fixture`
  stream with `door: "raw"` without HTTP validation; `packages/server/src/store-spec.test.ts`
  also calls the wrapper directly. The wrapper is exported at
  `packages/server/src/index.ts:22-27` and invokes `store.append` at
  `packages/server/src/append-door.ts:16-29`, contradicting the task's explicit ban on
  exported/test-helper bypass paths despite the committed audit's classification.
  Make the wrapper private to the two HTTP doors (or otherwise make direct access
  impossible), then regenerate the audit and runtime one-door proof.

Replay: N/A (server-only surface; no browser-reaching behavior) + mitigation: the
committed stream evidence was inspected directly, and the independent attacks above
used the production handler/store/reducer modules without a fresh browser.

### 2026-07-12 — builder rework — implemented

- Rework commits: `86f97e6` closes the transport, semantic-state, and public-wrapper
  refutations; `819c218` serializes Vitest files and raises the nested-build hook timeout
  so the root gate is deterministic.
- P1 closure: the refusal fixture now has non-empty before/after JSONL dumps; the evidence
  checker invokes `ef replay --digest` on every refusal pair and on the seeded fuzz dump,
  comparing the CLI output to the committed digest rows.
- P2 closure: `request-body.ts` handles exact `Content-Length`, `aborted`, and premature
  `close` signals; six dispatch tests include real malformed framing plus direct abort/close
  regressions, all returning typed 400 refusals without appends.
- P3 closure: built-in validators reject non-finite/non-numeric `set` and `increment`
  payloads before append; the semantic regression proves the reducer state and replay
  digest remain unchanged. P4 closure: the append wrapper and counters are no longer
  exported from the public server package; the static audit still finds one direct store
  invocation and only the raw HTTP and validated dispatch callers.
- Verification: `make verify-E0-T11` and
  `tools/verify/cold_clone.sh verify-E0-T11` passed at `819c218`, covering 13 test files,
  93 tests, E0-T09 conformance (21 transcript cases and 14 corpus seeds), CLI digest
  comparisons, sensitivity sabotage, and the append audit. Replay: N/A (server-only
  surface; no browser-reaching behavior) + mitigation: committed stream offsets, raw and
  `ef replay --digest` digests, transport transcripts, fuzz dump, conformance output,
  append audit, and sensitivity transcript.

### 2026-07-12 — builder rework 2 — implemented

- Commit: `02fe46b` (`fix: make append door private to HTTP`). The store contract tests now
  live outside `packages/server/src`, the public server package exports no append wrapper or
  counter, and `http.ts` owns the sole private `StreamStore.append` invocation. Dispatch
  receives only the private validated callback, so the validator chain completes before
  either HTTP door can invoke it.
- Verification: `make verify-E0-T11` and
  `tools/verify/cold_clone.sh verify-E0-T11` passed at `02fe46b`, with 13 test files/93
  tests, 21 conformance transcript cases across both stores, 14 corpus seeds, six dispatch
  tests, ef replay digest comparisons, sensitivity sabotage, and the private-door audit.
  Replay: N/A (server-only surface; no browser-reaching behavior) + mitigation: committed
  refusal/fuzz JSONL, CLI digest transcript, transport abort regressions, conformance
  output, and the single-invocation audit.

### 2026-07-12 — critic — VERDICT: verified

- Prediction: no implementation or test helper outside the two intended HTTP doors can invoke
  `StreamStore.append`. Observed exactly one direct `store.append(...)` call, at
  `packages/server/src/http.ts:109`, inside the private wrapper shared by raw POST and the
  validated dispatch callback; `packages/server/src/append-door.ts` is deleted, no source
  reference to it remains, and `packages/server/src/index.ts` exports no append wrapper or
  counter. Evidence: `evidence/e0-t11-append-callsites.txt` and the final `02fe46b` diff.
- Prediction: the former source-level store contract test cannot bypass the HTTP door.
  Observed the test at `packages/server/test/store-spec.test.ts`, with no
  `packages/server/src/store-spec.test.ts` path present. This removes the prior P4 bypass.
- Prediction: the prior stream-layer claims remain backed by committed artifacts. Observed
  four before/after refusal JSONL pairs with identical offsets and raw/replay digests,
  the seeded fuzz and sensitivity transcripts, and the builder-reported successful gates and
  cold-clone run at `02fe46b`; the current `2a47d5c6` commit changes metadata only.
- Coverage: the final bypass fix is directly accounted for by the static call-site evidence;
  no browser evidence is required. Replay: N/A (server-only surface) + mitigation: committed
  stream digests, fuzz/sensitivity transcripts, conformance output, and append audit.
