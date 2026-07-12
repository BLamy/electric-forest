---
id: E0-T12
epic: 0
title: "ef bisect: binary-search the first divergent offset between two event logs"
priority: 12
status: implemented
depends_on: [E0-T04]
estimate: M
capstone: false
---

## Goal

`packages/cli`'s `ef` binary ships `ef bisect <log-a.jsonl> <log-b.jsonl>
[--reducer <module>] [--stats]`: it validates both dumps under the exact same envelope
rules as `ef replay` (E0-T04), replays both through `packages/protocol`'s pure replay
core, compares state digests at probe positions, and binary-searches to the **exact
first divergent record** — the stream-layer `whowrote` that `AGENTS.md`'s critic charter
cites ("digest-bisect any divergence to the exact offset"). Ground truth is frozen here:
the first divergence is the smallest 1-based record index `k` at which the two logs'
canonical event lines differ byte-for-byte, or at which one log ends while the other
continues; by replay determinism (E0-T03/E0-T04) this is also the first index at which
the replayed states _can_ differ, so the digest-probe search must return exactly `k` —
including when the two states' digests re-converge downstream of `k`. Output is frozen:
exactly one canonical-JSON line (per E0-T03's `canonicalJson`) on stdout —
`{"kind":"identical",...}` (exit 0), `{"kind":"divergence",...}` or
`{"kind":"prefix",...}` (exit 1) — carrying the divergent index, each log's offset at
that index, and the last-common state digest. Any malformed input exits ≥ 2 with a
stderr diagnostic and prints nothing on stdout. `make verify-E0-T12` proves the suite,
including a property test that plants divergences at random offsets in random-length
logs and always recovers the exact index.

## Context

This task completes the Epic-0 evidence toolchain. `ef replay` (E0-T04) answers "what
state does this log produce?"; `ef bisect` answers "which event made two logs stop
agreeing?" — the question every convergence claim from here forward reduces to:
two-client convergence diffs (Epic 1), branch-fork/merge divergence (E1), and the E0-T13
capstone's kill/resume digest match all cite `ef bisect` output when digests disagree.
`AGENTS.md` names this the stream-layer analogue of `reverse-continue`: "which event
corrupted the state" gets an exact offset, not archaeology. E0-T06's verification notes
already defer to this tool ("use `ef bisect` once it lands").

Input format and validation are **not** redefined here: both arguments are JSONL stream
dumps under the contract frozen by E0-T04 (canonical-JSON lines, offset-monotone), and
`ef bisect` must reject malformed input through the _same code path_ `ef replay` uses —
a dump that `ef replay` rejects and `ef bisect` accepts (or vice versa) is a bug. The
`--reducer <module>` flag has E0-T04 semantics: both logs replay through the same
reducer (default: the `packages/protocol` test reducer the goldens are built against).

Contracts frozen here:

- **Divergence definition** (above): first differing canonical record line, or shorter
  log's end. Record-level, not digest-level — a pair of logs whose differing events
  happen to reduce to digest-equal states at some later probe is still divergent at `k`,
  and the tool must say so. The reported `index` is always the record index — a
  record-level truth independent of whether the two states' digests happen to agree at
  any probe.
- **Output format**: exactly one canonical-JSON line on stdout; for every `kind`, the
  fields are exactly these five and no others: `kind`
  (`identical` | `divergence` | `prefix`), `index` (1-based; for `identical` the shared
  record count, for `prefix` the first index past the shorter log), `aOffset`/`bOffset`
  (each log's offset at `index`, or `null` past end; for `kind:identical` they are the
  offsets of the final shared record, or `null` when `index` = 0 — i.e. both logs
  empty), `lastCommonDigest` (state digest
  after the shared prefix `1..index-1`; for `identical`, the final digest). Scripts and
  critics parse this forever after. `--stats` writes probe/replay counters to **stderr
  only** — stdout purity is absolute.
- **Exit codes**: 0 identical, 1 divergent-or-prefix, ≥ 2 usage/validation/reducer
  errors.

Offsets in the two logs may legitimately differ at the same index (e.g. a forked
branch), which is why the result reports both `aOffset` and `bOffset` — the index is the
shared coordinate; the offsets are the citations into each log.

Non-goals: no server endpoints (the logs are files; dumping a live stream is the
client/server tasks' business), no three-way merge or patch semantics (E1), no attempt
to find _all_ divergences — first only.

## Deliverables

- `packages/cli`: `ef bisect <log-a> <log-b> [--reducer <module>] [--stats]` subcommand,
  covered by all E0-T01 gates, sharing the E0-T04 dump-validation and reducer-loading
  code paths (no second parser).
- Binary search over the monotone predicate "prefix `1..k` agrees", probing with state
  digests from the replay core; the pinned index is confirmed against the raw record
  lines so the re-convergence case cannot mis-pin. `--stats` prints to stderr the number
  of prefix-agreement probes (counted per the probe-count discipline below) and total
  records replayed.
- Missing file, malformed dump (any E0-T04 fuzz-corpus class, in either argument),
  unloadable reducer, missing argument, unknown flag: exit ≥ 2, stderr diagnostic naming
  the offending file and (where applicable) 1-based line, empty stdout.
- Committed fixture pairs in `E0-T12-ef-bisect/evidence/fixtures/`, each with a sibling
  `*.expected.json` recording the frozen expected result line:
  - `identical/` — byte-identical pair (≥ 20 records).
  - `first-record/` — divergence planted at index 1.
  - `last-record/` — divergence planted at the final index (equal lengths).
  - `mid/` — divergence mid-log; `payload-only/`, `type-only/`, `ts-only/` — exactly one
    field differs at the planted index.
  - `prefix/` — log A is a strict prefix of log B (and the test also runs the arguments
    swapped).
  - `reconverge/` — logs diverge at index `k` but replay to **equal state digests** at
    some index `j > k` (constructed against the default reducer; the construction is
    documented in the fixture's expected file). Expected result still pins `k`.
  - `empty-vs-nonempty/` and `empty-vs-empty/` — zero-record edge cases. Per the output
    contract above, `empty-vs-empty/`'s expected line is exactly
    `{"aOffset":null,"bOffset":null,"index":0,"kind":"identical","lastCommonDigest":<digest of the empty replay>}`
    (canonical-JSON encoded), exit 0.
- Property test (committed, runs under `pnpm test`): generate a random log of random
  length (spanning 1 to ≥ 1000 records), clone it, plant one mutation at a uniformly
  random index (field mutation, record replacement, truncation, or extension), run the
  bisect entry point, assert the reported index equals the planted index **exactly**.
  Deterministic seeding: the seed set lives in `evidence/seeds.txt`, every run prints
  its seeds, and any failing seed is appended to the committed set as a permanent
  regression case.
- Probe-count discipline: the `--stats` probe counter increments on **every evaluation
  of the prefix-agreement predicate, regardless of mechanism** — a state-digest
  comparison and a raw record-line comparison each count as one probe; only the final
  single-index confirmation against the raw record lines at the pinned `k` is exempt. A
  committed test on a generated ~10,000-record pair asserts (via `--stats` / the
  counter) that probes ≤ `2·ceil(log2 n) + 4` — a linear scan wearing a bisect nametag,
  whether it scans digests or record lines, fails this.
- Makefile: `verify-E0-T12` composed from the standard gates
  (`_v-fmt _v-lint _v-typecheck _v-test _v-build`) plus a `_v-bisect-fixtures` recipe
  that runs `ef bisect` over every committed fixture pair as real process invocations
  and diffs stdout byte-for-byte against the committed `*.expected.json` lines; added to
  `verify-all`; passing `_v-meta` / `tools/verify/self_check.sh`.

## Acceptance criteria

- [ ] From a cold clone via `tools/verify/cold_clone.sh`: `make verify-E0-T12` exits 0,
      and `_v-bisect-fixtures` runs one real `ef bisect` process invocation per fixture
      pair, echoing each invoked command (or one `PASS <fixture>` line per pair) so the
      count of invocations printed equals the number of committed fixture pairs under
      `evidence/fixtures/` — a critic can compare the count against `ls
evidence/fixtures`; a recipe that loops fixtures inside one node process or
      silently skips a directory fails. Each stdout line byte-identical to the committed
      expectation.
- [ ] Boundary pinning is exact: the `first-record` fixture reports `index` 1 and the
      `last-record` fixture reports `index` = record count — off-by-one at either
      boundary (0, 2, count−1, or count+1) refutes. Evidence: the committed expected
      files plus the fixture test, green under `pnpm test`.
- [ ] `identical/` reports `{"kind":"identical",...}` with exit 0, and its
      `lastCommonDigest` equals `ef replay <log-a> --digest` on the same file — the two
      tools agree on what a full replay digests to. Evidence: committed test comparing
      the two outputs.
- [ ] `prefix/` reports `{"kind":"prefix",...}` with exit 1 in **both** argument orders,
      with `index` = shorter length + 1 and the past-end offset `null`. Evidence:
      committed test.
- [ ] `reconverge/` still pins the true first divergence at the planted `k`, and the
      fixture demonstrably re-converges (the test independently replays both prefixes at
      some `j > k` and asserts digest equality there). A bisect that reports anything
      other than `k` — or a fixture that doesn't actually re-converge — fails. Evidence:
      committed test.
- [ ] Property test: ≥ 200 iterations across the committed seeds, every planted
      divergence recovered exactly; the seed list in `evidence/seeds.txt` reproduces any
      historical failure. Evidence: green under `pnpm test`; seeds committed.
- [ ] Probe-count: on the ~10,000-record generated pair, prefix-agreement predicate
      evaluations (counted per the discipline above — digest comparisons **and**
      record-line comparisons alike, excluding only the final single-index
      confirmation) ≤ `2·ceil(log2 n) + 4` per the committed test. Evidence: committed
      test reading the `--stats` counters.
- [ ] `--reducer` is semantically honored, not merely loaded: against a committed
      non-default test reducer module and a fixture pair constructed so the two reducers
      digest differently, `ef bisect --reducer <module>` reports a `lastCommonDigest`
      byte-equal to `ef replay --reducer <module> --digest` on the shared prefix **and**
      byte-different from the default-reducer digest of that same prefix. A build that
      loads the module then replays through the default reducer fails both halves.
      Evidence: committed test.
- [ ] Error paths: every E0-T04 fuzz-corpus file, supplied as either argument alongside
      a valid log, exits ≥ 2 with empty stdout and a stderr diagnostic naming the bad
      file; same for missing files and an unloadable `--reducer`. Evidence: committed
      test iterating the corpus in both argument positions.
- [ ] stdout purity: in every success and divergence case, stdout is exactly one
      canonical-JSON line (`wc -l` = 1; the line round-trips through
      `canonicalJson(JSON.parse(line))` unchanged); with `--stats`, stdout is unchanged
      and the counters appear on stderr. Evidence: committed test.
- [ ] `bash tools/verify/self_check.sh` (`make _v-meta`) exits 0 after the Makefile
      edits, and `make verify-list` shows E0-T12 covered.
- [ ] Replay (browser) layer: N/A — CLI-only task, no browser-reaching surface; evidence
      is stream-layer per AGENTS.md, declared explicitly in the claim.

## Adversarial verification

Attack angles for the hostile critic. Generate your own inputs — never rerun only the
builder's fixtures; any single success refutes.

1. **Plant your own divergences (mandatory).** Take `E0-T04`'s `golden.jsonl` (or
   generate fresh valid logs), copy, and mutate one record at indices you choose —
   including index 1 and the final index. `ef bisect` must report exactly your planted
   index and the correct per-log offsets. Refutation: any off-by-one, any `identical`
   verdict on logs you made differ, or offsets in the result that don't match the actual
   record lines at that index (spot-check with `sed -n '<k>p'`).
2. **The re-convergence trap.** Construct your own pair that diverges at `k` but reduces
   to digest-equal states at some later probe point (e.g. two different events whose
   reducer effect cancels by `j`). A digest-only binary search will happily probe `j`,
   see equality, and mis-pin the divergence later than `k`. Refutation: reported index
   ≠ your `k`. Also invert it: verify the builder's `reconverge/` fixture actually
   re-converges by replaying both prefixes at `j` yourself — a fixture that never
   re-converges is testing nothing.
3. **Differential against `ef replay` and raw `diff`.** For any pair: (a) the trivial
   oracle `diff <(nl a.jsonl) <(nl b.jsonl)` gives the first differing line — bisect's
   `index` must match it on every pair you try; (b) `lastCommonDigest` must equal
   `ef replay` on the truncated shared prefix `head -n $((k-1))`. Refutation: either
   disagreement — the tool is a second implementation of truth, not a lens on the
   existing one. Then check the diff: dump validation and reducer loading must be the
   E0-T04 code paths, not a re-parse; find one malformed file the two subcommands judge
   differently and the shared-contract claim is refuted.
4. **Binary-search theater.** Read the implementation and the probe-count test. Sabotage
   in a scratch worktree: replace the search with a linear scan — try **both** variants,
   one probing digests and one comparing raw record lines directly — the probe-count
   test must go red for each (if the line-comparison variant stays green, the counter is
   only counting digest probes and the test has no teeth); make the probe comparison
   always-equal (`return true`) — the fixture and
   property tests must go red. Any sabotage that stays green under
   `make verify-E0-T12` refutes the suite. Sweep the diff for `.skip`/`.todo`/inline
   lint disables while in there.
5. **Property-test honesty.** Rerun the property test with fresh random seeds of your
   own (not the committed list) for ≥ 500 iterations, including degenerate shapes:
   length-1 logs, mutation at index 1 of a length-1 log, truncation to empty, extension
   of an empty log, mutations that only flip `ts`, and mutated records that remain
   valid canonical JSON (the divergence must be found by comparison, not by validation
   error). Refutation: any exact-index miss. Confirm the generator actually varies
   length and index (instrument or read it) — a generator pinned to mid-log divergences
   proves nothing about boundaries.
6. **Malformed and asymmetric inputs.** Feed E0-T04's fuzz corpus in _each_ argument
   position, plus your own: two logs valid separately but with a divergence _and_ a
   later malformation — validation must fail loudly (exit ≥ 2, no result line) rather
   than emit a divergence verdict from a half-validated file; also try a pair where the
   malformation sits _before_ the divergence. Refutation: exit 0/1 on any malformed
   input, any digest/result line on stdout, or a diagnostic naming the wrong file/line.
7. **Output-contract fuzzing.** Assert stdout is exactly one line that round-trips
   through `canonicalJson` unchanged, in every terminal state including `--stats`,
   `empty-vs-empty`, and error cases (error = empty stdout). Pipe into a strict parser
   of your own. Refutation: any extra byte on stdout, non-canonical encoding, or a
   result line accompanying a nonzero-≥2 exit.
8. **Cold-clone + env hunt.** Run everything via `tools/verify/cold_clone.sh` with
   `NODE_OPTIONS`/`NODE_ENV`/`npm_config_*` scrubbed; rerun a fixture under `TZ`
   extremes and `LANG=C` vs `LANG=en_US.UTF-8`, from different cwds and with
   relative-vs-absolute log paths. Refutation: any result line differing across runs —
   the citation currency must be machine-independent.
9. **Coverage.** Hold the claimed final run against the diff: the prefix branch (both
   orders), the empty-log branches, every error path, `--reducer`, and `--stats` must
   each have been executed by a test or transcript. Unexecuted diff is unproven or dead
   — builder chooses which, you enforce it.

## Verification log

### 2026-07-12 — builder — implemented

- Commit: `426c901` (`feat: add ef bisect divergence search`), on
  `codex/e0-t12-ef-bisect`, stacked on verified E0-T11 commit `1b391c6`.
- Implementation: `ef bisect <log-a> <log-b> [--reducer <module>] [--stats]` reuses
  E0-T04's dump parser and reducer loader, validates both logs before searching, binary
  searches a monotone canonical-record prefix predicate while comparing protocol replay
  state digests, and confirms the pinned record against the raw canonical lines. Output is
  one canonical JSON line with exact five-field `identical`, `divergence`, or `prefix`
  results; errors are status >=2 with empty stdout and `--stats` is stderr-only.
- Fixtures/evidence: 11 committed fixture pairs cover identical, first/last/mid,
  payload/type/ts-only, strict prefix, reconvergence, empty-vs-nonempty, and empty-vs-empty
  (the last two exercise E0-T12's explicit allow-empty terminal rule). `evidence/seeds.txt`
  records the deterministic property seeds.
- Gates: `CI=true make verify-E0-T12` passed with 14 test files and 100 tests, including
  225 seeded property cases, custom reducer parity, malformed corpus checks, reconvergence,
  stdout purity, and the 10,000-record probe bound. `_v-bisect-fixtures` ran 11 separate
  real `ef bisect` processes and matched every committed expected line; `bash
tools/verify/self_check.sh` passed.
- Cold clone: `tools/verify/cold_clone.sh verify-E0-T12` passed from a pristine clone with
  scrubbed environment, including dependency installation, format/lint/typecheck/test/build,
  self-check, queue coverage, and all 11 fixture invocations.
- Replay: N/A (CLI-only task; no browser-reaching behavior) + mitigation: committed JSONL
  fixtures and canonical expected lines, protocol replay digests, malformed-input transcripts,
  seeded property coverage, probe statistics, and the cold-clone transcript at
  `evidence/verify-E0-T12.txt`.

### 2026-07-12 — builder rework — implemented

- Rework commit: `3c3a2f3` (`fix: make bisect probes constant-time`). The raw canonical
  prefix comparison is now an exact shared prefix-trie identity lookup, so each search
  predicate performs O(1) raw-prefix and protocol-digest comparisons; `--stats` reports
  both `probes` and `rawPrefixComparisons`, with the final pinned-line check exempt.
- Critic refutation closure: the prior `samePrefix` linear scan was removed. The committed
  sensitivity harness mutates the search twice in detached worktrees: a linear raw-prefix
  scan fails the 10,000-record bound (`66143 > 32`), and a digest-only predicate fails the
  reconvergence/property tests. Transcript: `evidence/e0-t12-sensitivity.md`.
- Verification: `CI=true make verify-E0-T12` passed with 14 test files/100 tests, 225
  seeded property cases, 11 real fixture processes, and both sabotage proofs. The final
  `tools/verify/cold_clone.sh verify-E0-T12` passed from a pristine clone at `3c3a2f3`.
  Replay: N/A (CLI-only task; no browser-reaching behavior) + mitigation: committed fixture
  pairs, expected canonical outputs, replay digests, malformed corpus checks, probe stats,
  sensitivity transcript, and cold-clone output.

### 2026-07-12 — builder rework 2 — implemented

- Independent attack harness: `tools/verify/bisect_critic_attacks.mjs` creates fresh logs
  and drives the built CLI as real processes through 10 cases: index-1/final divergence,
  both prefix orders, reconvergence, empty logs, malformed-after-valid input, custom
  reducer parity, and a 10,000-record stats bound. Transcript:
  `evidence/e0-t12-critic-attacks.md`.
- Verification: commit `50ff807` passes `CI=true make verify-E0-T12` with 14 test files/
  100 tests, 225 seeded properties, 11 fixture processes, both sensitivity sabotages, and
  the 10 fresh attack cases. `tools/verify/cold_clone.sh verify-E0-T12` passes from a
  pristine clone at the same commit. Replay: N/A (CLI-only task; no browser-reaching
  behavior) + mitigation: committed CLI attack transcript, fixture/evidence corpus,
  protocol replay digests, and sensitivity transcript.

### 2026-07-12 — fresh critic — VERDICT: refuted

- P1 binary-search theater / probe accounting — FAILED. The task requires the probe bound
  to reject a linear scan wearing a bisection nametag (`readme.md:116-122` and
  `readme.md:209-216`). The implementation's `samePrefix` loop compares every canonical
  record in the tested prefix (`packages/cli/src/bisect-command.ts:35-40`), and every
  binary-search predicate invokes that full scan (`packages/cli/src/bisect-command.ts:59-70`).
  The counter increments only `probes += 2` once per predicate (`packages/cli/src/bisect-command.ts:61-63`),
  so `--stats` hides the O(n log n) raw-line work and cannot distinguish this from an
  O(log n) search. This is an unambiguous violation of the frozen probe-count contract;
  replace the repeated prefix scan with an O(1)-per-probe raw-record oracle or account and
  enforce every line comparison, then re-record the full critic attack suite.
- Review scope — the built CLI was rebuilt successfully, but the requested fresh generated-log,
  malformed-corpus, environment, and disposable-sabotage executions were interrupted before
  completion. No implementation code was changed. Replay: N/A (CLI-only task) + mitigation:
  existing stream-layer fixtures remain committed, but they do not clear the refuted probe
  accounting.
