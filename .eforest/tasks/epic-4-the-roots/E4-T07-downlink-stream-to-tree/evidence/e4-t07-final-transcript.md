# E4-T07 rework verification transcript

Date: 2026-08-07
Worktree: `/private/tmp/electric-forest-e4-t07`
Implementation: `1d18e939` (`fix: make E4-T07 stream sensitivity executable`)

## Commands

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
CI=true pnpm exec vitest run --maxWorkers=1 packages/cli/test/downlink.test.ts
bash tools/verify/watch_down.sh
node tools/verify/e4_t07_stream_proof_sensitivity.mjs
make --no-print-directory verify-E4-watch-down
make --no-print-directory verify-E4-T07
tools/verify/cold_clone.sh verify-E4-T07
```

The root gates completed with `Test Files 55 passed (55)`, `Tests 561 passed
(561)`, and a successful Vite production build. The focused downlink suite
completed with `Test Files 1 passed (1)` and `Tests 9 passed (9)`. The cold
clone repeated the scrubbed full target and emitted both `verify-E4-watch-down:
OK` and `verify-E4-T07: OK`.

## Live convergence

```text
E4-T07 live convergence OK checkpoint=0000000000000000_0000000000000045 applied=16 worktree=9bcb598c2b38d1a443e1cda3ab571397dba7c78d49fa78d2c840319fc1bd59e3 materialize=9bcb598c2b38d1a443e1cda3ab571397dba7c78d49fa78d2c840319fc1bd59e3 live-latency-ms=314.4 verified 16 apply journal entries server-head-before=0000000000000000_0000000000000029 server-head-after=0000000000000000_0000000000000045
watch_down: unit, crash-recovery, live-tail, read-only, and journal checks passed
verify-E4-watch-down: OK
verify-E4-T07: OK
E4-T07 stream-proof append sensitivity: EXPECTED-FAIL OK
```

The verifier seeds the committed E3-T01 `maple/reading-room` corpus, clones that
branch, and sends the scripted mutations through the authorized HTTP
`/api/dispatch` door. The live sequence covers three patches, a full rewrite,
rename-then-edit, tombstone/recreate, and nested directory operations. The
dispatch-to-checkpoint measurement is `314.4ms <= 2000ms` without restart.

Before/after stream proof enumerated all 13 metadata/content streams and ran the
CLI `ef replay <dump> --digest` command for each. The metadata head moved from
`...0029` to `...0045` only because of the scripted dispatches; the downlink
engine appended nothing. The metadata replay digests were
`aced2ecc81fffd0756fbfb38d9d90c6db253b89706ab290fc382a1711b6dbe9a` before and
`c1cfa2ce6ea69065f8bb1b292b6de2dd1b368500d4344844bbba8ecb3e230f62` after, and
all existing content streams remained present with their expected heads/digests.
The verifier also compares every actual stream record list against the exact
before-records plus the scripted client's known appends, after the engine has
reached the final checkpoint, and compares each actual replay digest against an
independently dumped expected stream. A separate spawned sensitivity run
actually appends one record to an untouched content stream after convergence;
the proof exits nonzero and reports `E4-T07 stream-proof append sensitivity:
EXPECTED-FAIL OK`.

The pristine-clone run also completed with:

```text
cold_clone: verify-E4-T07 PASSED from a pristine clone
```

Its captured target output included both `verify-E4-watch-down: OK` and
`verify-E4-T07: OK` after hydrating dependencies from the lockfile-verified
store and scrubbing the environment.

The verifier compares the actual working tree through `ef tree-digest` against
an independently generated `ef materialize --at` projection and confirms that
the server dump is unchanged by the downlink engine.

## SIGKILL recovery matrix

Each line is a separate child-process watcher run. The process was killed by
`SIGKILL`, then restarted without the failpoint. The deterministic permutation
targets ten distinct event ordinals across all five phases: `1, 8, 4, 12, 6,
14, 3, 10, 5, 9`. Every recovered journal has 15 gapless entries and the same
final digest.

```text
E4-T07 kill/resume OK runs=10
kill=1 phase=before-intent signal=SIGKILL targetOrdinal=1 preJournal=0 preIntent=absent recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=2 phase=after-intent signal=SIGKILL targetOrdinal=8 preJournal=7 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=3 phase=after-rename signal=SIGKILL targetOrdinal=4 preJournal=3 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=4 phase=after-journal-commit signal=SIGKILL targetOrdinal=12 preJournal=12 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=5 phase=before-checkpoint signal=SIGKILL targetOrdinal=6 preJournal=6 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=6 phase=after-intent signal=SIGKILL targetOrdinal=14 preJournal=13 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=7 phase=after-rename signal=SIGKILL targetOrdinal=3 preJournal=2 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=8 phase=after-journal-commit signal=SIGKILL targetOrdinal=10 preJournal=10 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=9 phase=before-checkpoint signal=SIGKILL targetOrdinal=5 preJournal=5 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=10 phase=before-intent signal=SIGKILL targetOrdinal=9 preJournal=8 preIntent=absent recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
```

Replay: N/A (CLI + stream-layer task; no browser-reaching surface) +
mitigation: the committed apply journal, workspace checkpoint, CLI digest
parity, replayed stream proofs, corruption/dirty-base tests, and the
real-process SIGKILL transcript are the stream-layer evidence.
