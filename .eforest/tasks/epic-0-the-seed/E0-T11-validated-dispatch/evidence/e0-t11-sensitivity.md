E0-T11 sensitivity proof
Mutation: replaced schemaValidate(body) with an unconditional set action in a detached worktree.
Command: CI=true pnpm exec vitest run packages/server/src/dispatch.test.ts packages/server/src/dispatch.fuzz.test.ts
Expected: invalid-dispatch tests go red.
Observed exit=1
Failure summary:
 ❯ packages/server/src/dispatch.fuzz.test.ts (1 test | 1 failed) <timing>
 ❯ packages/server/src/dispatch.test.ts (3 tests | 3 failed) <timing>
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: fuzz case 1: expected [ 400, 404, 422 ] to include 201
 ❯ packages/server/src/dispatch.fuzz.test.ts:136:60
AssertionError: expected 404 to be 201 // Object.is equality
 ❯ packages/server/src/dispatch.test.ts:170:9
AssertionError: expected { …(4) } to match object { type: 'set', payload: 4, ts: 10 }
 ❯ packages/server/src/dispatch.test.ts:298:26
AssertionError: expected 404 to be 201 // Object.is equality
 ❯ packages/server/src/dispatch.test.ts:333:9
 Test Files  2 failed (2)

