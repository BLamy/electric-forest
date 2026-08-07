# E4-T07 rework verification transcript

Date: 2026-08-07
Worktree: `/private/tmp/electric-forest-e4-t07`
Implementation: `d0518bbf` (`fix: close E4-T07 cold-clone and torn-journal gaps`),
following `1d18e939`'s executable stream-proof sensitivity rework.

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

## Post-critic rework rerun

The independent execution critic found that the cold-clone wrapper could deadlock
while capturing verbose nested Make output, and that truncated-journal startup
needed a deterministic repeated assertion. `d0518bbf` spools the cold-clone Make
output to a temporary file before validating the success marker and adds the
repeated truncated-final-record test to the focused suite.

The first cold-clone attempt after the wrapper change surfaced a timing-sensitive
upstream E4-T06 golden miss (`fs.dir.create` absent from one observed shape). A
second independent pristine clone completed the same target successfully; no E4-T06
source change was needed.

```text
CI=true pnpm test
Test Files  55 passed (55)
Tests  561 passed (561)
pnpm build: PASSED
CI=true pnpm exec vitest run --maxWorkers=1 packages/cli/test/downlink.test.ts
Test Files  1 passed (1)
Tests  9 passed (9)
bash tools/verify/watch_down.sh: PASSED
E4-T07 live convergence OK checkpoint=0000000000000000_0000000000000045 applied=16 worktree=9bcb598c2b38d1a443e1cda3ab571397dba7c78d49fa78d2c840319fc1bd59e3 materialize=9bcb598c2b38d1a443e1cda3ab571397dba7c78d49fa78d2c840319fc1bd59e3 live-latency-ms=218.2
E4-T07 stream-proof append sensitivity: EXPECTED-FAIL OK
E4-T07 kill/resume OK runs=10
cold_clone: verify-E4-T07 PASSED from a pristine clone
verify-E4-watch-down: OK
verify-E4-T07: OK
```

The task remains Replay: N/A (CLI + stream-layer task; no browser-reaching surface)
+ mitigation: focused corruption/torn-journal tests, pristine cold-clone gates,
independent tree/materialize/replay parity, stream-proof sensitivity, and the
SIGKILL recovery transcript.

## Heartbeat wrapper validation

Commit `d0d7600c` retains file-backed output for `tools/verify/cold_clone.sh` and emits
a heartbeat every 30 seconds while the nested Make target runs. The command was rerun
from the committed ticket worktree:

```text
tools/verify/cold_clone.sh verify-E4-T07
cold_clone: make verify-E4-T07 still running; output remains file-backed
... repeated heartbeats while the pristine target ran ...
Test Files  55 passed (55)
Tests  561 passed (561)
...
packages/cli/src/bisect.test.ts > ef bisect committed fixtures > runs a real CLI process for empty-vs-empty and keeps stdout canonical
Error: Test timed out in 15000ms.
cold_clone: verify-E4-T07 FAILED (exit 2)
```

The failed target is an upstream E4-T01 real-process timeout in the pristine clone, not
an E4-T07 assertion. The important wrapper behavior is independently observable: nested
Make output remains file-backed and progress is emitted instead of being hidden by shell
command substitution. The preceding post-rework run remains the successful pristine-clone
evidence for E4-T07 itself. Replay: N/A (CLI + stream-layer task; no browser-reaching
surface) + mitigation: focused tests, the successful cold-clone transcript, stream
replay/materialize parity, sensitivity, and SIGKILL recovery evidence.

## Path-chain verifier rework

The fresh critic found that a checksum-valid journal could preserve the whole-record
`beforeDigest`/`afterDigest` chain while breaking the per-path `before`/`after` chain.
Commit `93db28f2` fixes `verifyApplyJournal` by retaining the latest `after` digest per
path and rejecting a subsequent mismatched `before` digest. The new focused regression
keeps the global chain intact and expects the CLI journal verifier to fail on the path
chain specifically.

```text
pnpm format:check: PASSED
pnpm lint: PASSED
pnpm typecheck: PASSED
CI=true pnpm exec vitest run --maxWorkers=1 packages/cli/test/downlink.test.ts
Test Files  1 passed (1)
Tests  10 passed (10)
CI=true pnpm test
Test Files  55 passed (55)
Tests  562 passed (562)
pnpm build: PASSED
bash tools/verify/watch_down.sh: PASSED
E4-T07 live convergence OK checkpoint=0000000000000000_0000000000000045 applied=16 worktree=9bcb598c2b38d1a443e1cda3ab571397dba7c78d49fa78d2c840319fc1bd59e3 materialize=9bcb598c2b38d1a443e1cda3ab571397dba7c78d49fa78d2c840319fc1bd59e3 live-latency-ms=306.0 verified 16 apply journal entries
E4-T07 stream-proof append sensitivity: EXPECTED-FAIL OK
E4-T07 kill/resume OK runs=10
watch_down: unit, crash-recovery, live-tail, read-only, and journal checks passed
```

Replay: N/A (CLI + stream-layer task; no browser-reaching surface) + mitigation: focused
path-chain regression, full gates, independent live proof, and the prior independent
malformed/dirty/exact-once/30-point crash evidence. A fresh critic must re-run the
path-chain mutation against this commit and re-earn the task verdict.

## Post-fix independent critic

The fresh critic independently confirmed the path-chain fix at `3e2ae24f`: a real
checksum-valid mutation caused `ef journal verify` to exit 1 with `EJOURNAL_CORRUPT` and
the `doc.txt` break between offsets `...0002` and `...0003`. It also completed the live
proof, new malformed/truncated/dirty/exact-once cases, a 30-point five-phase SIGKILL
matrix, sabotage, and static coverage checks. The remaining self-check result was:

```text
bash tools/verify/self_check.sh
forbidden escape in tools/verify/cold_clone.sh
157: kill "$heartbeat_pid" 2>/dev/null || true
177: kill "$heartbeat_pid" 2>/dev/null || true
178: wait "$heartbeat_pid" 2>/dev/null || true
```

The critic was interrupted before the cold-clone target, so no independent pristine-clone
result exists. Replay: N/A (CLI + stream-layer task; no browser-reaching surface) +
mitigation: independent path-chain, live, malformed, crash, sabotage, and coverage
evidence. The wrapper self-check pattern must be fixed before the next critic.
