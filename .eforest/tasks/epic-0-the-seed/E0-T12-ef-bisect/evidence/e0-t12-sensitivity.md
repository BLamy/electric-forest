E0-T12 sensitivity proof
Command: detached worktree vitest run packages/cli/src/bisect.test.ts
Expected: both search-mechanism sabotages fail the committed tests.
- linear raw-prefix scan sabotage: expected red, observed exit=1
 ❯ packages/cli/src/bisect.test.ts (7 tests | 1 failed) <timing>
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected 66143 to be less than or equal to 32
 ❯ packages/cli/src/bisect.test.ts:234:34
 Test Files  1 failed (1)
- digest-only search sabotage: expected red, observed exit=1
 ❯ packages/cli/src/bisect.test.ts (7 tests | 3 failed) <timing>
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: reconverge: expected +0 to be 1 // Object.is equality
 ❯ packages/cli/src/bisect.test.ts:90:35
AssertionError: expected { aOffset: '0024', …(4) } to match object { kind: 'divergence', index: 8 }
 ❯ packages/cli/src/bisect.test.ts:156:20
AssertionError: 271828/11/ts: expected 962 to be 587 // Object.is equality
 ❯ packages/cli/src/bisect.test.ts:281:62
 Test Files  1 failed (1)
