# E2-T03 sensitivity proof

Both attacks ran from disposable worktrees at implementation commit `6697bfd`; neither
mutation touched the builder worktree.

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
