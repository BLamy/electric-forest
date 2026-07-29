# E2-T06 sensitivity proof

Each run uses a detached disposable worktree at the exact source snapshot and
rebuilds the full compiled graph inside it (the namespace child executes dist/,
so a mutation must reach compiled code to count). A zero-mutation control must
pass every test before any sabotage is attributed, and each sabotage must fail
exactly its named sensor tests — parsed from vitest JSON results, not grepped
from stdout. Normal verification never modifies this evidence file.

## zero-mutation control

```text
pnpm run build && pnpm exec vitest run --reporter=json packages/platform/test/ns.test.ts
control-green exit=0 tests=21 failed=0
```

Result: CONTROL_GREEN

## uniqueness validator

Mutation: `uniqueness`.

```text
pnpm run build && pnpm exec vitest run --reporter=json packages/platform/test/ns.test.ts
expected-red exit=1
failed tests (exactly, parsed from vitest JSON):
- serializes at least twenty concurrent same-name creates to one winner
- freezes validation order and all five log-neutral refusal reasons
- mints no stream for any authenticated refusal, even on a fresh store
- refuses duplicate names from replayed durable state through a second gateway
```

Result: uniqueness_validator_SENSITIVITY_OK

## instance side table

Mutation: `instance-side-table`.

```text
pnpm run build && pnpm exec vitest run --reporter=json packages/platform/test/ns.test.ts
expected-red exit=1
failed tests (exactly, parsed from vitest JSON):
- refuses duplicate names from replayed durable state through a second gateway
```

Result: instance_side_table_SENSITIVITY_OK

## payload owner trust

Mutation: `payload-owner`.

```text
pnpm run build && pnpm exec vitest run --reporter=json packages/platform/test/ns.test.ts
expected-red exit=1
failed tests (exactly, parsed from vitest JSON):
- rejects actor, owner, sub, org, extras, and missing visibility as schema violations
```

Result: payload_owner_trust_SENSITIVITY_OK

