# E4-T07 final builder transcript

Date: 2026-08-07
Worktree: `/private/tmp/electric-forest-e4-t07`

## Commands

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
CI=true pnpm exec vitest run --maxWorkers=1 packages/cli/test/downlink.test.ts
bash tools/verify/watch_down.sh
make --no-print-directory verify-E4-watch-down
make --no-print-directory verify-E4-T07
```

The root gates completed with `Test Files 55 passed (55)`, `Tests 557 passed
(557)`, and a successful Vite production build. The focused downlink suite
completed with `Test Files 1 passed (1)` and `Tests 5 passed (5)`.

## Live convergence

```text
E4-T07 live convergence OK checkpoint=0000000000000000_0000000000000019 applied=16 worktree=59ff27d3f38f0eadd1020c1699463867c4ed7281bc255c952bcb62d243076890 materialize=59ff27d3f38f0eadd1020c1699463867c4ed7281bc255c952bcb62d243076890 verified 16 apply journal entries server-head-before=0000000000000000_0000000000000003 server-head-after=0000000000000000_0000000000000019
watch_down: unit, crash-recovery, live-tail, read-only, and journal checks passed
verify-E4-watch-down: OK
verify-E4-T07: OK
```

The same scripted sequence contains three patch events, a rename-then-edit,
tombstone/recreate, and nested directory operations. The verifier compares the
actual working tree through `ef tree-digest` against an independently generated
`ef materialize --at` projection and confirms that the server dump is unchanged
by the downlink engine.

## SIGKILL recovery matrix

Each line is a separate child-process watcher run. The process was killed by
`SIGKILL`, then restarted without the failpoint. Every recovered journal has 15
gapless entries and the same final digest.

```text
E4-T07 kill/resume OK runs=10
kill=1 phase=before-intent signal=SIGKILL preJournal=0 preIntent=absent recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=2 phase=after-intent signal=SIGKILL preJournal=0 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=3 phase=after-rename signal=SIGKILL preJournal=0 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=4 phase=after-journal-commit signal=SIGKILL preJournal=1 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=5 phase=before-checkpoint signal=SIGKILL preJournal=1 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=6 phase=before-intent signal=SIGKILL preJournal=0 preIntent=absent recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=7 phase=after-intent signal=SIGKILL preJournal=0 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=8 phase=after-rename signal=SIGKILL preJournal=0 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=9 phase=after-journal-commit signal=SIGKILL preJournal=1 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
kill=10 phase=before-checkpoint signal=SIGKILL preJournal=1 preIntent=present recovered=0000000000000000_0000000000000018 journal=15 digest=2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71
```

Replay: N/A (CLI + stream-layer task; no browser-reaching surface) +
mitigation: the committed apply journal, workspace checkpoint, CLI digest
parity, corruption/dirty-base tests, and the real-process SIGKILL transcript
are the stream-layer evidence.
