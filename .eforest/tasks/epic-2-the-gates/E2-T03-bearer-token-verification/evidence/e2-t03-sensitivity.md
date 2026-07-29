# E2-T03 sensitivity proof

The first two attacks ran from disposable worktrees at implementation commit `6697bfd`.
The non-finite `nbf` attack ran from a disposable worktree at fix commit `c264eb5`.
None of the mutations touched the builder worktree.

## Signature bypass

Mutation: replace the initial RS256 verification result with `true` in
`packages/platform/src/auth.ts`, then run:

```text
pnpm exec vitest run packages/platform/test/gateway.test.ts
```

Observed exit: `1`. The frozen refusal table failed because the forged token returned
HTTP 202 instead of 401. The same-`kid` rotation test also failed because no refresh
occurred (`fetches` remained 1 rather than 2). Result: the suite is sensitive to both
forged-signature acceptance and stale cached-key acceptance.

## Client actor precedence

Mutation: disable the client-`actor` check and order the payload merge so the supplied
actor overwrites the verified subject, then run the same focused test command.

Observed exit: `1`. `rejects a client-supplied actor without touching streams` failed
because the sabotaged gateway returned HTTP 202 instead of the required typed 400.
Result: the suite detects a client identity crossing the authenticated dispatch door.

## Non-finite not-before

Mutation: remove the `Number.isFinite` guard from the optional JWT `nbf` validation in
`packages/platform/src/auth.ts`, then run the same focused test command.

Observed exit: `1`; 11 tests passed and the frozen refusal-table test failed. The signed
raw JWT payload containing `"nbf":-1e9999` returned HTTP 202 instead of 401, reproducing
the critic's refutation exactly. Result: the regression suite detects acceptance of a
JSON numeric exponent that JavaScript parses as negative infinity before the adapter can
be accessed.
