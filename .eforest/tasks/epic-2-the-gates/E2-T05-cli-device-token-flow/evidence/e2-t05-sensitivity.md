# E2-T05 sensitivity proof

The initial mutations ran from detached disposable worktrees at implementation commit
`833e68e` on 2026-07-18. The critic-rework mutations ran from sealed rework commit
`faae737d2aea47d266a449c466178aa119841824`. No mutation touched the builder worktree.

## Revocation check no-op

Worktree: `/private/tmp/e2-t05-revocation-sensitivity`.

Mutation: replace the active-status guard in
`packages/platform/src/auth/grants.ts`:

```diff
- if (grant?.status !== "active") throw new TokenRevokedError();
+ if (grant === null) throw new TokenRevokedError();
```

Command:

```text
pnpm exec vitest run packages/platform/test/cli-tokens.test.ts
```

The suite went red with exit 1 at the exact measuring assertion:

```text
event-backed CLI grants > mints once, lists without a secret, revokes, and flips the same door log-neutrally
AssertionError: expected 202 to be 401
packages/platform/test/cli-tokens.test.ts:222
Tests: 1 failed, 2 passed
```

Result: `REVOCATION_SENSITIVITY_OK` — a verifier that admits a revoked grant cannot
survive the committed test.

## Golden one-byte mutation

Worktree: `/private/tmp/e2-t05-golden-sensitivity`.

Mutation: change the first hexadecimal byte of the device grant's `tokenHash` from
`1` to `a` in `e2-t05-identity-golden.jsonl`, leaving the committed digest untouched.

Command:

```text
CI=true make verify-E2-T05
```

All 22 root files / 278 tests and the focused 7 tests passed first. The full verifier
then went red with exit 2 at `_v-e2-t05`'s silent exact digest comparison. Independent
values at that point were:

```text
mutated:  4b8f1deaf8fbc2e95876c944aad801d6f259a7130a6f7233618aa9b446fc3f19
committed: eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7
make[1]: *** [_v-e2-t05] Error 1
make: *** [verify-E2-T05] Error 2
```

Result: `GOLDEN_SENSITIVITY_OK` — one changed input byte changes the replay digest and
fails the full task target before transcript or browser evidence can be accepted.

## Critic rework: remove the post-body authorization boundary

Worktree: `/private/tmp/e2-t05-race-sensitivity-2` at `faae737`.

Mutation: make `PlatformGateway` append with the identity captured before request-body
parsing instead of invoking `withAuthorizedMutation` after parsing:

```diff
- return await this.verifier.withAuthorizedMutation(header, mutate);
+ return await mutate(preliminaryIdentity);
```

Command:

```text
tools/verify/e2_t05_loopback.sh pnpm exec vitest run packages/platform/test/cli-tokens.test.ts
```

The suite went red with exit 1 on the critic's exact stalled-body interval:

```text
rechecks the grant after a stalled request body before entering the append boundary
AssertionError: expected 202 to be 401
packages/platform/test/cli-tokens.test.ts:424
Tests: 1 failed, 6 passed
```

Result: `TOCTOU_SENSITIVITY_OK` — removing the post-parse atomic grant boundary admits a
mutation after revocation and is caught deterministically.

## Critic rework: move grant lookup before JWT signature verification

Worktree: `/private/tmp/e2-t05-forgery-sensitivity` at `faae737`.

Mutation: restore the refuted order in `GrantAwareVerifier`, resolving the token hash from
the identity stream before invoking E2-T03's bearer verifier.

Command:

```text
tools/verify/e2_t05_loopback.sh pnpm exec vitest run packages/platform/test/cli-tokens.test.ts
```

The suite went red with exit 1 at both the direct and production-wiring measurements:

```text
verifies JWT signatures before grant lookup and preserves the E2-T03 taxonomy
expected {error:{code:"unauthorized",reason:"invalid_signature"}}
received {error:{class:"token-revoked"}}

wires the grant-aware gateway in the production composition
expected {error:{code:"unauthorized",reason:"malformed_token"}}
received {error:{class:"token-revoked"}}
Tests: 2 failed, 5 passed
```

Result: `FORGERY_ORDER_SENSITIVITY_OK` — a verifier that consults grants before signature
and claim verification cannot survive the committed suite.

## Cross-runtime rework: remove the durable in-use revoke guard

Worktree: `/private/tmp/e2-t05-cross-runtime-sensitivity` at `5787b19`.

Mutation: delete the identity reducer check that refuses
`identity.grant.revoked` while a matching
`identity.grant.operation.started` remains active. This preserves both independent
runtime objects and all transport behavior while removing the shared durable ordering
boundary that replaced the refuted process-local mutex.

Command:

```text
pnpm exec vitest run packages/platform/test/cli-tokens.test.ts \
  -t "serializes a cross-runtime"
```

The strengthened test races an explicit `revokeAttempted` hook against successful revoke
completion. The mutation went red in 159 ms at the exact ordering assertion:

```text
serializes a cross-runtime in-flight append before revocation and survives restart
AssertionError: expected 'committed' to be 'blocked'
packages/platform/test/cli-tokens.test.ts:374
Tests: 1 failed, 6 skipped
```

Restoring the durable reducer guard with the same explicit race passed (1 passed,
6 skipped). The test no longer relies on a microtask or timer to infer that revocation
attempted entry. The previous critic's local-lock mutation is intentionally superseded:
the final implementation has no process-local grant lock participating in correctness.

Result: `CROSS_RUNTIME_REVOCATION_SENSITIVITY_OK` — if revoke can commit while another
runtime holds a durable active operation, the permanent regression fails immediately.

## Run 4: break orphan-recovery producer sequencing

Worktree: task-local disposable `work/sensitivity-run4` at sealed implementation commit
`32a35b0`.

Mutation: change only the revoker's recovered Durable Streams `Producer-Seq` from `0` to
`1`. This removes the exactly-once producer tuple shared with the original runtime while
leaving operation planning, completion, and the reducer revoke guard intact.

Command:

```text
pnpm vitest run packages/platform/test/cli-tokens.test.ts \
  -t "recovers orphaned operations exactly once"
```

The mutation went red at the before-target-append crash point:

```text
recovers orphaned operations exactly once across both target-append crash points
FetchError: HTTP Error 409 at .../streams/orphan-before-target: Producer sequence gap
packages/platform/src/auth/provision.ts:285
Tests: 1 failed, 8 skipped
```

The identical command at untouched commit `32a35b0` passed (1 passed, 8 skipped). This
also proves that the test reaches the official Durable Streams producer-sequence branch,
not merely the in-memory adapter.

Result: `ORPHAN_RECOVERY_IDEMPOTENCY_SENSITIVITY_OK` — a recovered mutation that does not
reuse the original producer tuple cannot survive the permanent crash regression.

## Run 5: misclassify unavailable-target termination as success

Worktree: disposable `/tmp/e2-t05-run5-sensitivity` at sealed implementation commit
`19f94f3`.

Mutation: in the official-server recovery path, replace the durable
`identity.grant.operation.aborted` transition for a 404 target with
`identity.grant.operation.completed`. This still closes the operation and permits
revocation, so the probe distinguishes an auditable terminal abort from merely making the
revoker stop waiting.

Command:

```text
pnpm --filter @eforest/platform build
pnpm exec vitest run packages/platform/test/cli-tokens.test.ts \
  -t "aborts a missing-target|fences a late original" --reporter=verbose
```

The untouched sealed checkout passed both official Durable Streams regressions (2 passed,
9 skipped). The mutation made both regressions red:

```text
aborts a missing-target operation durably and permits revocation
expected status: "aborted", abortReason: "target-unavailable"
received status: "completed"
packages/platform/test/cli-tokens.test.ts:540

fences a late original runtime after its deleted target operation is aborted
expected status: "aborted", abortReason: "target-unavailable"
received status: "completed"
packages/platform/test/cli-tokens.test.ts:612
Tests: 2 failed, 9 skipped
```

Result: `UNAVAILABLE_TARGET_ABORT_SENSITIVITY_OK` — completing a plan whose target never
accepted its event cannot masquerade as a successful append; the durable terminal reason
and late-runtime fence are measured by permanent official-server tests.

## Run 6: remove the target commit-boundary epoch advance

Worktree: disposable `/private/tmp/e2-t05-run6-fence-sensitivity` at sealed implementation
commit `5688131`.

Mutation: change only the terminal close fence's `Producer-Epoch` from `1` back to `0`.
The identity-stream active check, target close, abort event, and revocation all remain in
place, but the close no longer makes the paused original epoch-0 writer stale at the
official transport's atomic producer boundary.

Command:

```text
pnpm --filter @eforest/platform build
pnpm exec vitest run packages/platform/test/cli-tokens.test.ts \
  -t "fences a late epoch-0 writer paused after its active check" --reporter=verbose
```

The untouched sealed checkout passed (1 passed, 13 skipped). The one-line mutation made
the exact post-check regression red:

```text
fences a late epoch-0 writer paused after its active check
AssertionError: promise resolved "undefined" instead of rejecting
packages/platform/test/cli-tokens.test.ts:705
Tests: 1 failed, 13 skipped
```

Result: `TARGET_COMMIT_FENCE_SENSITIVITY_OK` — a snapshot-only active check plus a
same-epoch close cannot survive the permanent official-server regression. The test goes
red unless the target commit boundary advances the operation producer epoch.
