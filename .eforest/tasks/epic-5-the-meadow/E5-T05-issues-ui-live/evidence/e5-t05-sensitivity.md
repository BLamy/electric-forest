# E5-T05 sensitivity proof

The ticket-local browser oracle was run against three isolated mutations in one detached
scratch worktree. Each mutation rebuilt only its affected package and the web app. No
dependency ticket target or root suite was rerun.

Command: `node tools/verify/e5_t05_sensitivity.mjs`

```text
E5_T05_SENSITIVITY mutation=drop-watcher-frame sensor=watcher-live-sync EXPECTED-FAIL OK
E5_T05_SENSITIVITY mutation=stale-board-offset sensor=board-at-offset-parity EXPECTED-FAIL OK
E5_T05_SENSITIVITY mutation=phantom-board-card sensor=board-literal-equality EXPECTED-FAIL OK
E5_T05_SENSITIVITY_OK cases=3
```

The mutations prove that the acceptance run detects a skipped follower frame, a board
digest paired with the preceding offset, and a card not present in the reduced board.
