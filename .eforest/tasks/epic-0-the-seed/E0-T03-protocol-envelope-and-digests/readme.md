---
id: E0-T03
epic: 0
title: Protocol package frozen — event envelope, canonical JSON, opaque lexicographic offsets, SHA-256 digests, pure replay core
priority: 3
status: implemented
depends_on: [E0-T01, E0-T02]
estimate: M
capstone: false
---

## Goal

`packages/protocol` exists, builds, and is **frozen at version `1`**: it exports the
`Event` envelope type `{ type: string, payload: unknown, ts: number }`, a
`canonicalJson(value): string` encoder with byte-exact stable output (lexicographic key
order, exact number/string encoding rules documented in the package), an opaque `Offset`
type with `compareOffsets(a, b)` / `isOffsetBefore(a, b)` helpers whose ordering is plain
lexicographic string comparison per the durable-streams HTTP protocol v1.0 draft
(including the sentinel `-1` = "before the first event"), `stateDigest(state): string`
returning the lowercase-hex SHA-256 of the canonically-encoded reduced state, and a pure
`replay(events, reducer, initialState)` core with zero I/O, zero `Date`/`Math.random`,
and no dependency outside `node:crypto`. Golden fixtures — sample event logs with their
committed canonical encodings and digests — live in `packages/protocol/fixtures/`, and
`make verify-E0-T03` proves the whole apparatus: replays every golden to its committed
digest twice with identical results, and goes red when a single fixture byte is flipped.

## Context

This package is the evidence currency of the entire repo. Every later claim — replay
determinism (E0-T04's `ef replay`), server conformance transcripts (E0-T09), two-client
convergence (Epic 1), digest bisect (E0-T12), the capstone's two-terminals-identical-
digest demo (E0-T13) — bottoms out in "canonically encode, hash, compare exactly." If
canonical encoding or the envelope shifts after golden logs are committed, every golden
in the repo silently rots. So the contract is **frozen here and versioned**: the package
exports `PROTOCOL_VERSION = 1`, and any change to the envelope, encoding rules, offset
semantics, or digest recipe requires a version bump plus regeneration of every golden —
which is exactly the loud, deliberate event it should be.

Prior art (read-only, per AGENTS.md): ElectricSQL's durable-streams protocol v1.0 draft
defines offsets as opaque strings whose only guaranteed property is lexicographic
ordering within a stream — clients must never parse or fabricate them, only compare and
echo them. This package encodes that discipline in the type system: `Offset` is a branded
type, and the only sanctioned operations are the exported comparison helpers.

Canonical JSON rules frozen by this task (documented verbatim in the package readme and
enforced by tests):

- Object keys sorted by UTF-16 code unit (JavaScript's default string `<`), recursively.
- No whitespace; separators `,` and `:` only.
- Strings: JSON.stringify escaping (shortest form, `\uXXXX` only where required).
  Lone surrogates do **not** throw: they encode as `\udXXX` escapes, exactly as
  well-formed `JSON.stringify` does — this is part of the frozen contract, so the
  same lone-surrogate input always yields the same escaped bytes.
- Numbers: only finite numbers are encodable; `NaN`/`Infinity`/`-Infinity` throw.
  Integers within safe range print without exponent or trailing `.0`; `-0` encodes as
  `0`; other numbers use ECMAScript `Number::toString` (shortest round-trip).
- `undefined`, functions, symbols, and `bigint` anywhere in the tree throw — never
  silently dropped the way `JSON.stringify` drops object-valued `undefined`.

Non-goals: no HTTP, no server, no store, no CLI (E0-T04/T05 build on this). The reducer
registry is E0-T10. This task depends on E0-T01 (the workspace and its gates) and
E0-T02 (the frozen verify spine — `cold_clone.sh`, `self_check.sh`, `verify-list`, and
the `_v-*` helper recipes this task's target composes and measures itself with).

## Deliverables

- `packages/protocol/package.json` — workspace package `@eforest/protocol`, wired into
  the root `pnpm format:check` / `lint` / `typecheck` / `test` / `build` gates.
- `packages/protocol/src/version.ts` — `export const PROTOCOL_VERSION = 1`.
- `packages/protocol/src/envelope.ts` — `Event` type `{ type, payload, ts }`, plus
  `isEvent(value): value is Event` runtime guard (rejects missing/extra-typed fields).
- `packages/protocol/src/canonical.ts` — `canonicalJson(value): string` implementing the
  frozen rules above; throws `CanonicalJsonError` on unencodable input.
- `packages/protocol/src/offset.ts` — branded `Offset` type, `OFFSET_BEFORE_FIRST`
  (`-1`), `compareOffsets(a, b): -1 | 0 | 1`, `isOffsetBefore(a, b): boolean`,
  `maxOffset(a, b)`; ordering is exact lexicographic string comparison, no parsing.
- `packages/protocol/src/digest.ts` — `stateDigest(state): string` = lowercase-hex
  SHA-256 (via `node:crypto`) over `canonicalJson(state)` bytes (UTF-8).
- `packages/protocol/src/replay.ts` — `replay<S>(events: Iterable<Event>, reducer:
  (state: S, event: Event) => S, initialState: S): S`; pure, no I/O, no ambient time or
  randomness.
- `packages/protocol/fixtures/` — committed goldens: at least three sample event logs
  (`*.events.jsonl`, one event per line in canonical encoding), each with a sibling
  `*.expected.json` recording `{ protocolVersion, eventCount, canonicalSha256OfLog,
  finalStateDigest }` computed with a fixed reference reducer exported from
  `fixtures/reducer.ts`. Fixtures cover: empty log, a multi-event counter-style log, and
  a log exercising nasty encoding surface (unicode keys/values, nested objects with
  unsorted source order, negative zero, large safe integers, deep arrays).
- Unit tests (`packages/protocol/src/*.test.ts`): exact-string assertions for
  `canonicalJson` against hand-written expected bytes; throw-cases for every unencodable
  input; offset comparison truth table including `-1` sentinel and prefix cases
  (`"1" < "10" < "9"` lexicographically — the tests pin the *lexicographic* answers);
  digest against an independently computed known vector (e.g. `stateDigest({})` ===
  sha256 of `{}` = `44136fa3...`); envelope guard accept/reject matrix.
- Property tests (fast-check or equivalent, seeded and committed): encode-determinism
  (`canonicalJson(x) === canonicalJson(clone-with-shuffled-key-insertion-order(x))`),
  parse-round-trip (`JSON.parse(canonicalJson(x))` deep-equals `x` for generated
  encodable values, where deep equality uses **SameValueZero** semantics for numbers —
  `-0` and `0` compare equal — because the frozen canonical rule normalizes `-0` to
  `0`, so a generated `-0` legitimately round-trips to `0`; do not use
  `assert.deepStrictEqual`'s SameValue comparison for this property, and do not filter
  `-0` out of the generator), digest sensitivity (distinct canonical encodings → distinct
  digests across the generated corpus), replay-fold equivalence (`replay` equals a
  hand-rolled left fold), offset-comparison total-order laws (antisymmetry,
  transitivity, consistency of `isOffsetBefore` with `compareOffsets`).
- `tools/verify/replay_goldens.sh` (or equivalent script the Makefile calls) — for every
  fixture: verify the log file's canonical re-encoding matches byte-for-byte, replay it
  through the reference reducer **twice in two separate node processes**, and compare
  both digests to the committed `finalStateDigest`; then the **sensitivity proof**: copy
  a fixture to a temp dir, flip one byte of one event, and assert the digest comparison
  exits nonzero. Any green on the mutated copy fails the whole target.
- `Makefile`: `verify-E0-T03` target inside the marker section composing the frozen
  helper recipes (`_v-fmt _v-lint _v-typecheck _v-test _v-build`) plus the golden-replay
  + sensitivity script; joins `verify-all`'s prerequisites; `tools/verify/self_check.sh`
  still passes.

## Acceptance criteria

- [ ] `make verify-E0-T03` exits 0 from a pristine cold clone
      (`tools/verify/cold_clone.sh` path), and its output contains zero `SKIPPED:`
      lines — evidence: `make verify-E0-T03 2>&1 | grep -c '^SKIPPED:'` prints `0`.
      No attribution judgment is permitted; if shared infrastructure emits a
      `SKIPPED:` line, the criterion fails until that line is removed upstream.
- [ ] The golden-replay step replays every fixture log to its committed
      `finalStateDigest` **twice, in two separate node processes**, and asserts the two
      runs' digests are byte-identical to each other and to the committed value —
      evidence: the target's output prints per-fixture `fixture=<name>
      run1=<digest> run1.pid=<p1> run2=<digest> run2.pid=<p2> expected=<digest> OK`,
      where each `pid` is the `process.pid` reported by the node process that computed
      that run's digest and `p1 != p2` (the harness fails the fixture if they are
      equal). Corroborating check on the committed script:
      `grep -c 'node ' tools/verify/replay_goldens.sh` (or the equivalent path the
      Makefile calls) shows the harness invokes `node` as two separate exec calls per
      fixture rather than looping inside one process.
- [ ] The sensitivity proof runs inside `make verify-E0-T03`: with one byte of a
      fixture-event copy flipped, the digest comparison exits nonzero, and the target
      prints exactly one line per mutation of the form `MUTATION fixture=<name>
      byte=<offset> digest-mismatch EXPECTED-FAIL OK` — the harness may only print
      the `EXPECTED-FAIL OK` suffix after observing the nonzero exit. A mutated
      fixture that replays green fails the whole target. Evidence:
      `make verify-E0-T03 2>&1 | grep -c '^MUTATION .* digest-mismatch EXPECTED-FAIL OK$'`
      prints a number >= 1.
- [ ] `canonicalJson` output is byte-exact against committed expected strings: for each
      fixture log, re-encoding every parsed event reproduces the committed
      `*.events.jsonl` lines byte-for-byte, and `canonicalSha256OfLog` in
      `*.expected.json` matches — evidence: `pnpm test --filter @eforest/protocol`
      exit 0 with these assertions present in the committed test files.
- [ ] Unencodable inputs (`NaN`, `Infinity`, `bigint`, `undefined` inside objects and
      arrays, functions, symbols, circular references) each throw
      `CanonicalJsonError` — evidence: named unit tests, one per input class, in the
      committed suite.
- [ ] Offset helpers implement pure lexicographic order: the committed truth-table test
      includes `compareOffsets("1","10") === -1`, `compareOffsets("10","9") === -1`,
      `compareOffsets("-1", x) === -1` for every non-sentinel fixture offset `x`, and
      equal-string reflexivity — evidence: `pnpm test` exit 0 with the table committed.
- [ ] Property tests run with committed seeds and pass; the seeds appear in the test
      source, not in env — evidence: grep for the seed values in the diff plus
      `pnpm test` exit 0.
- [ ] `packages/protocol` has no runtime dependency other than `node:crypto` and no
      import of `Date.now`, `Math.random`, `fs`, `net`, `http`, or `child_process` in
      `src/` — evidence, both commands binary and both required:
      `jq -e '((.dependencies // {}) | length) == 0' packages/protocol/package.json`
      exits 0 (zero runtime dependencies; `node:crypto` is a builtin, not a dependency),
      and `grep -rnE --exclude='*.test.ts' "Math\.random|Date\.now|(from ['\"]|require\(['\"]|import\(['\"])(node:)?(fs|net|http|child_process)['\"/]?"
      packages/protocol/src` returns nothing — covering static `from` imports,
      `require(...)`, and dynamic `import(...)` forms alike. The command exactly as
      written, including the `--exclude='*.test.ts'` flag, is the binding check: it
      excludes the `src/*.test.ts` unit tests, and `fixtures/` lives outside `src/`
      so it is never scanned.
- [ ] All five workspace gates pass repo-wide: `pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0.
- [ ] `tools/verify/self_check.sh` passes and `make verify-list` shows `verify-E0-T03`
      mapped to this task.
- [ ] Durable evidence is committed per AGENTS.md's stream-layer fallback (until
      `ef replay` lands in E0-T04, the currency is deterministic test output captured
      to `evidence/`): the final recorded run's full `make verify-E0-T03` output —
      including every per-fixture `fixture=<name> run1=... run2=... expected=... OK`
      line and the `MUTATION ... EXPECTED-FAIL OK` sensitivity marker — is committed
      under this task's `evidence/` directory (e.g.
      `.eforest/tasks/epic-0-the-seed/E0-T03-protocol-envelope-and-digests/evidence/verify-E0-T03.txt`),
      and the Verification log entry cites that file path and the digests it contains.
- [ ] Replay browser layer: N/A (no browser-reaching surface; protocol core only) —
      mitigation: stream-layer evidence above is the currency; the Verification log
      entry must declare this explicitly per AGENTS.md.

## Adversarial verification

Your mission is to refute the claim that this measuring apparatus measures anything.
Every attack below pairs a manipulation with an explicit refutation condition. Run them
with your own inputs, never the builder's.

1. **Sensitivity proof, your own byte.** The builder's harness flips a byte of its own
   choosing. You choose differently: mutate a *different* fixture, a *different* event,
   and separately (a) flip one byte inside a string payload, (b) swap two adjacent
   events in the log, (c) delete the last line, (d) change a `ts` by 1. Each mutation
   must turn the digest comparison red. **Any mutation that replays green refutes the
   apparatus entirely** — file it as a refutation of the task, not a bug.
2. **Self-licking goldens.** Verify the committed `*.expected.json` digests were not
   generated by the same code path at test time: recompute `finalStateDigest` for one
   fixture **independently** — parse the jsonl yourself, fold with the reference
   reducer, canonicalize with a from-scratch encoder (python:
   `json.dumps(obj, separators=(',',':'), sort_keys=True, ensure_ascii=False)` is close
   enough to cross-check simple fixtures; where it disagrees, hand-derive the bytes)
   and `shasum -a 256`. A committed digest that only the package's own encoder can
   reproduce, with no independent derivation possible, is **needs-evidence**; an
   independent derivation that disagrees is a **refutation**.
3. **Canonicalization fuzz (differential).** Generate objects with shuffled key
   insertion orders, unicode keys (astral plane, combining characters, lone
   surrogates — which per the frozen string rule must encode deterministically as
   `\udXXX` escapes, never throw and never vary), `-0`, `1e21`,
   `Number.MAX_SAFE_INTEGER`, empty objects/arrays nested deep. For each:
   `canonicalJson(a)` must equal `canonicalJson(shuffle(a))` byte-wise, and
   `JSON.parse` must round-trip deep-equal (SameValueZero for numbers, per the
   property-test contract above). A lone-surrogate input that throws, or that
   produces different bytes across runs, refutes the string rule. One pair of semantically-equal inputs
   with different canonical bytes refutes the encoder; one silently-dropped
   `undefined` field (encoder returns bytes instead of throwing) refutes the
   throw-contract.
4. **Offset order sabotage.** The v1.0 draft guarantee is lexicographic, not numeric.
   Probe the helpers with offsets where the two orders disagree (`"9"` vs `"10"`,
   `"0002"` vs `"1"`, mixed-width padded forms) and with the `-1` sentinel against
   offsets that sort lexicographically *before* `"-1"` (e.g. `"+"`, `"-0"`): the
   package must either order `-1` first by documented special-case or the docs must
   forbid such offsets — an undocumented wrong answer refutes the offset contract.
   Also verify the `Offset` brand actually prevents `compareOffsets(3 as any, ...)`
   from typechecking in a scratch consumer file.
5. **Purity hunt.** Grep `packages/protocol/src` for `Date.now`, `Math.random`,
   `process.env`, `fs`, dynamic `import(`, and any dependency in `package.json` beyond
   dev tooling. Then prove replay determinism environmentally: run the golden replay
   under `TZ=Pacific/Kiritimati LANG=C node ...` and under defaults — digests must be
   identical. Any environment-sensitive digest refutes the "pure" claim.
6. **Sabotage-check the tests.** In a disposable worktree, break the implementation
   three ways — (a) make `canonicalJson` skip key sorting, (b) make `stateDigest` hash
   `JSON.stringify` output instead of canonical bytes, (c) make `replay` apply events
   in reverse — and confirm `pnpm test` **and** `make verify-E0-T03` each go red for
   every sabotage. A sabotage that stays green refutes the suite it slipped past.
7. **Cold-clone + double-process check.** Run `make verify-E0-T03` via
   `tools/verify/cold_clone.sh` with scrubbed env. Then verify the "twice" in the
   claim is real: inspect the harness script and confirm the two replays are separate
   OS processes, not two calls in one process sharing warmed state; run the second
   replay yourself in a fresh shell and match the digest. Same-process "twice" is a
   **needs-evidence** finding.
8. **Freeze audit.** Confirm `PROTOCOL_VERSION` is exported and that the package readme
   states the invalidation rule (bump + regenerate goldens). Change one canonical rule
   in a scratch worktree (e.g. add a space after `:`) and confirm at least one
   committed golden goes red — a canonicalization change that all goldens survive
   refutes the claim that the goldens pin the contract.
9. **Version-skew trap (invent more like this).** Check `verify-all` includes
   `verify-E0-T03`, `self_check.sh` passes, and no test in the diff is `.skip`/`.todo`,
   no inline lint disable touches `src/`, and the property-test seeds are committed
   constants rather than time-derived.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your independently-derived digest cross-check as a
committed test, and any fuzz input that found interesting encoding surface into the
fixture corpus.

## Verification log

### 2026-07-11 — builder — reworked after refutation

Implementation commit: `0ea7e85bc2416240476038c7f99f136dff706f83`
(`fix: make E0-T03 replay proofs order-sensitive`).

The reference reducer now includes `set`, and both the counter golden and left-fold unit
test use `set` before `increment`. Reversing replay changes the final count, so the exact
critic sabotage now makes both `pnpm test` and `make verify-E0-T03` fail red.

Commands: all five standard gates; `make verify-E0-T03`; the reverse-replay sabotage
against both test entrypoints; and `tools/verify/cold_clone.sh verify-E0-T03`.

Evidence: `evidence/verify-E0-T03.txt` and `evidence/reverse-sabotage.txt`.

Replay: N/A (protocol core has no browser-reaching surface) + mitigation: pristine
two-process golden replay plus a committed sensitivity transcript proving reversed event
order is detected by both the unit suite and the composed verification target.

Claim: the replay apparatus is now order-sensitive. The pristine committed-HEAD target
passes at `0ea7e85`, while reversing the implementation fails two independent assertions
and both required test entrypoints.

### 2026-07-11 — builder — implemented

Implementation commit: `f94cc2930c83b24671d9c65ad1fb7cd990c9e3f2`
(`feat: freeze E0-T03 protocol core`).

Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`;
`pnpm test --filter @eforest/protocol`; `pnpm build`; `make verify-E0-T03`;
`jq -e '((.dependencies // {}) | length) == 0' packages/protocol/package.json`;
the binding forbidden-import grep from Acceptance Criteria; and
`tools/verify/cold_clone.sh verify-E0-T03`.

Evidence: `evidence/verify-E0-T03.txt`. Golden state digests:
empty `cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021`;
counter `5dcad1de965e75030a61ce33905b6418919237631bdd4f8aaa08ca955397f57d`;
encoding `0a10c9142683c3094343b973ae6974d868207a2f59cc89e3a9339388c9b1054e`.

Replay: N/A (protocol core has no browser-reaching surface) + mitigation: the committed
stream-layer transcript records a pristine committed-HEAD run, two distinct OS-process
replays per fixture, exact golden digests, and byte-mutation expected failures.

Claim: protocol version 1 freezes the event envelope, canonical JSON rules, sentinel-first
opaque lexicographic offsets, SHA-256 state digests, and pure left-fold replay. The seeded
unit/property suite passes 33 tests; every fixture re-encodes byte-for-byte and reproduces
its log and final-state digests in separate processes; both mutated copies fail red.

### 2026-07-11 — critic — VERDICT: refuted

- P1 replay-order sensitivity — FAILED. Predicted that sabotaging
  `packages/protocol/src/replay.ts:8` to iterate `Array.from(events).reverse()` would make
  both required measuring surfaces exit nonzero; observed `pnpm test` exit `0` (33/33)
  and `make verify-E0-T03` exit `0`, including all three fixture digests and both mutation
  markers. The committed unit probe uses two increments (`src/protocol.test.ts:92-101`),
  while the golden fixture operations affect independent fields or commute
  (`fixtures/counter.events.jsonl:1-3`, `fixtures/encoding.events.jsonl:1-2`), so neither
  surface distinguishes a left fold from a reverse fold. Demand: add an order-sensitive
  replay test and order-sensitive golden fixture, then rerun all gates and record fresh
  evidence.
- SUITE: n/a until the P1 refutation clears; no critic artifact is promoted from an
  apparatus proven insensitive to the task's required replay-order sabotage.

Commands: patch `replay` to reverse its iterable; `pnpm test`; `make verify-E0-T03`;
restore the submitted implementation. Replay: N/A (protocol-only task) + mitigation:
deterministic process exit codes and exact fixture digest output above.
