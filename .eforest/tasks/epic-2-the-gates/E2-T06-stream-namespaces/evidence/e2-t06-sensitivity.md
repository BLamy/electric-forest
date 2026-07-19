# E2-T06 sensitivity proof

Each mutation ran in a detached disposable worktree at the exact source snapshot.
Normal verification never modifies this evidence file.

## uniqueness validator

Mutation: `uniqueness`.

```text
pnpm exec vitest run packages/platform/test/ns.test.ts
expected-red exit=1 sensor=serializes at least twenty concurrent
```

Result: uniqueness_validator_SENSITIVITY_OK

## payload owner trust

Mutation: `payload-owner`.

```text
pnpm exec vitest run packages/platform/test/ns.test.ts
expected-red exit=1 sensor=rejects actor, owner, sub
```

Result: payload_owner_trust_SENSITIVITY_OK

