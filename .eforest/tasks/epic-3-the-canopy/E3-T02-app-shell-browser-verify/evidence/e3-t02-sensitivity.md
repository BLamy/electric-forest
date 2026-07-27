# E3-T02 shell sensitivity

All mutations were made independently in the disposable worktree
`/private/tmp/e3-t02-sabotage`, detached at implementation candidate `312eca7`.
Each receipt below came from the exact public command `make verify-E3-shell`; all
format, lint, typecheck, root tests, builds, and emulator checks ahead of the browser
assertion passed.

## Injected mount console error

Mutation: inserted
`console.error("E3-T02 sensitivity: injected mount error")` immediately before
`createRoot(root).render(<AppRoutes />)` in `apps/web/src/main.tsx`.

Result: RED (exit 2).

```text
AssertionError [ERR_ASSERTION]: console.error: E3-T02 sensitivity: injected mount error
console.error: E3-T02 sensitivity: injected mount error
at Object.assertClean (.../packages/browser-verify/dist/src/index.js:241:35)
make[1]: *** [_v-e3-shell] Error 1
make: *** [verify-E3-shell] Error 2
```

## Stale DOM offset

Mutation: replaced `data-ef-offset={identity.offset}` with the plausible prior head
`data-ef-offset="0000000000000000_0000000000000000"` in
`apps/web/src/identity.tsx`.

Result: RED (exit 2).

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ '0000000000000000_0000000000000000'
- '0000000000000000_0000000000000370'
                                 ^
at .../apps/web/test/shell.pw.ts:164:10
make[1]: *** [_v-e3-shell] Error 1
make: *** [verify-E3-shell] Error 2
```

## Plausible-looking false DOM digest

Mutation: replaced `data-ef-digest={identity.digest}` with the 64-hex literal
`0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` in
`apps/web/src/identity.tsx`.

Result: RED (exit 2).

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
- '7ccf4d7ccc97cf5584fe3a77064e8f2206075708282c1b6344a52206dcf6dd2a'
at .../apps/web/test/shell.pw.ts:166:10
make[1]: *** [_v-e3-shell] Error 1
make: *** [verify-E3-shell] Error 2
```

The expected digest above was independently produced by `ef replay --digest
--reducer packages/identity/reducer.mjs` over the fresh identity dump.
