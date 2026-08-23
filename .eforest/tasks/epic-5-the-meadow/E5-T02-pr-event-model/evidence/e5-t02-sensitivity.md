# E5-T02 sensitivity proof

Recorded 2026-08-22 from checkpoint `a11b1393` with:

```text
node tools/verify/e5_t02_sensitivity.mjs
E5_T02_SENSITIVITY mutation=merge-without-approval-check-deleted core-exit=2 EXPECTED-FAIL OK
E5_T02_SENSITIVITY mutation=changes-requested-no-longer-revokes core-exit=2 EXPECTED-FAIL OK
E5_T02_SENSITIVITY mutation=golden-lifecycle-one-byte-flip core-exit=2 EXPECTED-FAIL OK
```

Each mutation ran `make --no-print-directory _verify-E5-T02-inner` in a fresh detached
scratch worktree with the committed dependency/runtime artifacts linked in. The first
mutation deleted the merge-approval validator, the second made a latest
`changes-requested` verdict count as approved, and the third changed one byte in the
merged lifecycle golden. All three independently made the read-only E5-T02 core verifier
red; the source worktrees were removed after each run.
