E0-T11 sensitivity proof
Mutation: replaced schemaValidate(body) with an unconditional set action in a detached worktree.
Command: CI=true pnpm exec vitest run packages/server/src/dispatch.test.ts packages/server/src/dispatch.fuzz.test.ts
Expected: invalid-dispatch tests go red.
Observed exit=1

Scope: all 7 workspace projects
Recreating /Users/brettlamy/Dev/electric-forest/node_modules
✓ Lockfile passes supply-chain policies (verified 22m ago)
Lockfile is up to date, resolution step is skipped
Already up to date

devDependencies:
+ @eslint/js 10.0.1
+ @types/node 26.1.1
+ eslint 10.6.0
+ prettier 3.9.4
+ typescript 6.0.3
+ typescript-eslint 8.63.0
+ vitest 4.1.10

Done in 1s using pnpm v11.7.0

 RUN  v4.1.10 /private/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/eforest-dispatch-sensitivity.uszj1T

 ❯ packages/server/src/dispatch.fuzz.test.ts (1 test | 1 failed) 104ms
     × survives 520 malformed and unknown actions with controls only in the log 102ms
 ❯ packages/server/src/dispatch.test.ts (3 tests | 3 failed) 142ms
     × refuses each taxonomy class without changing head or dump digest 84ms
     × accepts one action through the reducer and keeps the cache coherent 37ms
     × accepts and then refuses the same state-dependent action, and preserves interleaving 18ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/server/src/dispatch.fuzz.test.ts > validated dispatch seeded fuzz > survives 520 malformed and unknown actions with controls only in the log
AssertionError: fuzz case 1: expected [ 400, 404, 422 ] to include 201
 ❯ packages/server/src/dispatch.fuzz.test.ts:136:60
    134|         });
    135|         if (isControl) expect(response.status, `fuzz case ${index}`).t…
    136|         else expect([400, 404, 422], `fuzz case ${index}`).toContain(r…
       |                                                            ^
    137|         expect(response.status, `fuzz case ${index} must not be 5xx`).…
    138|       }

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  packages/server/src/dispatch.test.ts > validated dispatch door > refuses each taxonomy class without changing head or dump digest
AssertionError: expected 404 to be 201 // Object.is equality

- Expected
+ Received

- 201
+ 404

 ❯ packages/server/src/dispatch.test.ts:128:9
    126|           )
    127|         ).status,
    128|       ).toBe(201);
       |         ^
    129|
    130|       const cases: ReadonlyArray<{

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 FAIL  packages/server/src/dispatch.test.ts > validated dispatch door > accepts one action through the reducer and keeps the cache coherent
AssertionError: expected { …(4) } to match object { type: 'set', payload: 4, ts: 10 }
(1 matching property omitted from actual)

- Expected
+ Received

  {
-   "payload": 4,
-   "ts": 10,
+   "payload": 0,
+   "ts": 0,
    "type": "set",
  }

 ❯ packages/server/src/dispatch.test.ts:242:26
    240|       const records = json<Array<Event & { offset: string }>>(events.b…
    241|       expect(records).toHaveLength(1);
    242|       expect(records[0]).toMatchObject({ type: "set", payload: 4, ts: …
       |                          ^
    243|
    244|       const expected = replay(records, fixtureReducer, fixtureInitialS…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 FAIL  packages/server/src/dispatch.test.ts > validated dispatch door > accepts and then refuses the same state-dependent action, and preserves interleaving
AssertionError: expected 404 to be 201 // Object.is equality

- Expected
+ Received

- 201
+ 404

 ❯ packages/server/src/dispatch.test.ts:277:9
    275|           )
    276|         ).status,
    277|       ).toBe(201);
       |         ^
    278|       expect(
    279|         (

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯


 Test Files  2 failed (2)
      Tests  4 failed (4)
   Start at  11:52:33
   Duration  700ms (transform 444ms, setup 0ms, import 620ms, tests 246ms, environment 0ms)

