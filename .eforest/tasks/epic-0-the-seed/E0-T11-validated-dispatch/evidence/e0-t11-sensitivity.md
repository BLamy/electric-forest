E0-T11 sensitivity proof
Mutation: replaced schemaValidate(body) with an unconditional set action in a detached worktree.
Command: CI=true pnpm exec vitest run packages/server/src/dispatch.test.ts packages/server/src/dispatch.fuzz.test.ts
Expected: invalid-dispatch tests go red.
Observed exit=1
Failure summary:
 ❯ packages/server/src/dispatch.fuzz.test.ts (1 test | 1 failed) <timing>
 ❯ packages/server/src/dispatch.test.ts (5 tests | 4 failed) <timing>
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: fuzz case 1: expected [ 400, 404, 422 ] to include 201
 ❯ packages/server/src/dispatch.fuzz.test.ts:136:60
AssertionError: expected 404 to be 201 // Object.is equality
 ❯ packages/server/src/dispatch.test.ts:253:9
AssertionError: expected { …(4) } to match object { type: 'set', payload: 4, ts: 10 }
 ❯ packages/server/src/dispatch.test.ts:381:26
AssertionError: expected 201 to be 409 // Object.is equality
 ❯ packages/server/src/dispatch.test.ts:475:30
AssertionError: expected 404 to be 201 // Object.is equality
 ❯ packages/server/src/dispatch.test.ts:502:9
 Test Files  2 failed (2)

