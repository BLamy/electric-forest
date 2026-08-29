# E5-T04 sensitivity transcript

Control: the focused browser oracle was green at `c080807b` and produced the committed
write-audit, refusal, digest, and event-log artifacts in this directory. The sensitivity
harness then reused that exact oracle in one detached scratch worktree, restoring the
control build before each source mutation and rebuilding only the affected package/app.

Command: `node tools/verify/e5_t04_sensitivity.mjs`

```text
E5_T04_SENSITIVITY mutation=optimistic-local-apply sensor=severed-tail-replay-only-label-rows EXPECTED-FAIL OK
E5_T04_SENSITIVITY mutation=client-only-refusal-server-accepts sensor=refusal-log-line-count EXPECTED-FAIL OK
E5_T04_SENSITIVITY mutation=hardcoded-confirmed-offset sensor=confirmed-offset-four-way-equality EXPECTED-FAIL OK
E5_T04_SENSITIVITY mutation=generic-refusal-string sensor=typed-refusal-code EXPECTED-FAIL OK
E5_T04_SENSITIVITY_OK cases=4
```

No root gate, dependency gate, or unrelated ticket verifier ran during this repair.
