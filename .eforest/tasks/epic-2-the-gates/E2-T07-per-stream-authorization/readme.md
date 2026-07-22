---
id: E2-T07
epic: 2
title: "Platform authorization: per-repository read, follow, and dispatch decisions before official-stream access"
priority: 207
status: in-progress
depends_on: [E2-T05, E2-T06]
estimate: L
capstone: false
---

## Goal

Every application operation is authorized in `@eforest/platform` before the official
Durable Streams client is invoked. A pure decision function joins the E2-T01 identity
view with the E2-T06 namespace view and decides `read`, `follow`, or `dispatch` for
a logical repo/branch stream. Electric owns stream transport; electric-forest owns who
may ask the platform to use it.

Public repositories permit anonymous reads and follows. Private repositories require
membership or a scoped read grant. Every write requires a branch-scoped write grant.
Refusals reveal no private-stream existence and append nothing.

## Deliverables

- `packages/platform/src/authz/decide.ts`: one total, pure authorization function.
- Gateway integration for application reads, live follows, and `POST /api/dispatch`.
- Stable public/private not-found behavior and typed refusal taxonomy.
- A real-HTTP matrix using Auth0 emulator identities and the official Durable Streams service.
- Golden decision and no-side-effect transcripts.

## Acceptance criteria

- [ ] The pure matrix covers anonymous, member, non-member, admin, read-grant,
      write-grant, revoked-grant, public, and private combinations.
- [ ] Every gateway operation calls the same decision function before using
      `@durable-streams/client`.
- [ ] Private unauthorized and nonexistent resources are indistinguishable.
- [ ] A refused read, follow, or dispatch performs no official-stream operation and
      leaves all logs unchanged.
- [ ] Grant revocation takes effect at the next replayed identity-view offset without
      restarting the platform.
- [ ] `make verify-E2-T07` passes from a cold clone against the pinned Auth0 emulator
      and published Durable Streams server.

## Adversarial verification

1. Enumerate every platform route that can resolve a stream; any route bypassing
   `authorize` refutes the task.
2. Race grant revocation with a dispatch and prove the accepted/refused result cites the
   exact identity-view offset used for the decision.
3. Probe private ids, malformed ids, encoded separators, and cross-tenant ids; any
   existence oracle or append is a refutation.
4. Search for authorization changes inside `@eforest/server` or copied Durable Streams
   code; those changes are out of bounds.

## Verification log

(appended by builder and critic)

### 2026-07-22 — builder — implementation claim

- Commits: `62402e0` (authorization core), `09329e4` (verify apparatus, goldens,
  E2-T06 standing follow-ups), `8327bef` (case-alias pin), `09270a1` (revocation-race
  and membership-revocation sensors, approved E1 provenance refresh). All recorded
  runs execute at exact commit `09270a137ee2cd22f868e2569851804c4fb8427b`; this claim
  and the finished cold-clone transcript land in its direct evidence child — the code
  tree is byte-identical between the two.
- **One total pure decision** — `packages/platform/src/authz/decide.ts`.
  `decideStreamAuthorization` joins the replayed E2-T01 identity view (users, orgs,
  memberships, grants) with the replayed E2-T06 namespace view (org/repo visibility,
  owners) and decides `read`/`follow`/`dispatch` for every target class: repo
  (`fs:<org>/<repo>:<branch>:<meta|file:…>` or `org/repo/branch` path),
  namespace-control (`ns:*` with a namespace-admin event), legacy sandbox (the frozen
  E2-T03 dispatch surface), internal (`__*__`, `ns:*` for application events), and
  malformed. It never throws, consults nothing outside its inputs (no clock, no
  randomness, no I/O), and every decision — allowance with a named basis or one of
  five typed refusals (`authz/malformed-target`, `authz/grant-revoked`,
  `authz/unauthenticated`, `authz/not-found`, `authz/write-grant-required`) — cites
  the exact identity-view offset it replayed. The pure matrix (authz.test.ts, 12
  tests) covers anonymous, member, admin, non-member, repo-owner, org-owner,
  read-grant, write-grant, wrong-branch write-grant, bare-scope, revoked, unknown,
  and cross-grant principals against public/private/nonexistent/malformed targets.
- **Every gateway operation is decided before `@durable-streams/client`.** The
  dispatch door classifies every stream id and calls the same decision function
  before any official-stream operation; the new authorized application read and
  live long-poll follow (`GET /api/repos/<org>/<repo>/<branch>/events[?live=1…]`,
  forwarded by the PlatformWebApp front door) go through the identical decision.
  Repo decisions replay only the two view surfaces — `__identity__` (via
  IdentityStore snapshot) and `ns:root`/`ns:org:<org>` (via a NamespaceViewReader
  that replays inside the E2-T06 permission-denied namespace runtime child) — and
  a refused operation performs no create/append/read/follow on any target stream
  and appends nothing anywhere (observed-adapter assertion + per-stream digest
  equality). Sandbox and control dispatches keep their frozen E2-T03/E2-T05/E2-T06
  door bodies byte-for-byte; internal streams (`__identity__`, raw `ns:*` appends —
  previously reachable by any grant holder) now refuse as `authz/not-found`.
- **Public/private not-found indistinguishability**: a private repo the principal
  cannot read refuses byte-identically to a nonexistent repo/org, asserted three
  ways: deep-equal over the pure matrix, byte-equal HTTP bodies in
  authz.gateway.test.ts, and the committed golden (`private-vs-nonexistent=
  byte-identical` in e2-t07-decision-matrix.txt). Case-variant prefixes
  (`FS:`/`Ns:`) are pinned as distinct sandbox streams, never repo/control aliases
  (the reference server resolves ids case-sensitively).
- **Every write requires a branch-scoped write grant on the presented credential**
  (`repo:write:<org>/<repo>:<branch>`): roles and ownership alone never dispatch
  (403 `authz/write-grant-required` where the repo is visible, 404 where it is
  not); a write grant for another branch reads but never writes; capabilities
  never leak across grants of the same subject.
- **Revocation at the next replayed offset, no restart**: grant revocation refuses
  the next dispatch/read with `authz/grant-revoked` citing an offset >= the
  revocation event's offset (gateway test + matrix transcript:
  `accepted-offset=…8452 < revocation-offset=…9737 <= refused-offset=…9737`); a
  revocation racing an in-flight dispatch is re-decided at the sequence-guarded
  `identity.grant.operation.started` append and refused citing that exact offset
  (RacingIdentityStore test); membership revocation flips private reads to
  `authz/not-found` at the next replayed view.
- **Real-HTTP matrix** (`tools/verify/e2_t07_matrix.mjs`): production wiring
  (GrantAwareVerifier + IdentityStore + NamespaceDispatcher) over real HTTP, seven
  Auth0-emulator-issued identities (pinned emulator `82eb8359…`), the published
  Durable Streams reference server, namespace and branch streams seeded through the
  door. The full scenario runs TWICE against fresh servers and the transcripts must
  be byte-identical before comparison with the committed goldens:
  `evidence/e2-t07-decision-matrix.txt` (all 192 pure decisions),
  `evidence/e2-t07-http-matrix.txt` (door behavior + revocation ordering),
  `evidence/e2-t07-no-side-effect.txt` (79 refused cases, per-stream SHA-256
  digests unchanged, created-streams-delta=0).
- **Sensitivity** (`tools/verify/e2_t07_sensitivity.mjs` + `e2_t07_probe.mjs`):
  green control on a copied unmutated dist, then three anchored sabotages of the
  compiled decision — visibility-leak, write-grant-bypass, existence-oracle — each
  drives the end-to-end probe red at exactly its predicted case
  (`E2_T07_SENSITIVITY_OK control=green cases=3`).
- **E2-T06 standing follow-ups folded in** (judge round-10 SUSTAINED demands):
  `cold_clone.sh` now scrubs the `*_OS_SANDBOX_ACTIVE` family; `e2_t06_loopback.sh`
  (and the new `e2_t07_loopback.sh`) print an engaged/inherited attestation line;
  the run-10 builder claim wording is corrected in place ("workshop repros",
  gitignored `work/`, never committed). E2-T06 apparatus maintenance at this head:
  runtime-boundary manifest regenerated for the changed gateway/grants bytes;
  no-database allowlist anchor for provision.ts shifted (:93 → :111) and six
  dispositions added for the E2-T07 evidence apparatus writes; evidence transcript
  regenerated; the approved E1 provenance artifacts refreshed via the sanctioned
  `--refresh-approved-e2` path for the Makefile (approved changed input) edit.
  `CI=true make verify-E2-T06` re-earns green inside the chain at this head.
- Commands (all at `09270a1`, exit 0): `pnpm format:check && pnpm lint`;
  `pnpm typecheck`; `CI=true pnpm test` (26 files, 342/342); `CI=true pnpm build`;
  `CI=true make verify-E2-T07` — loopback sandbox engaged (attested), gates,
  authz suites 24/24, `E2_T07_MATRIX_OK runs=2 deterministic=true`,
  `E2_T07_SENSITIVITY_OK control=green cases=3`, no-emulator-import and
  frozen-`packages/server` guards, then chained `verify-E2-T06: OK` (including
  `verify-E2-T01: OK`, `verify-E2-T03: OK`, `verify-E0-T11: OK`), ending
  `verify-E2-T07: OK`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T07` ran TO COMPLETION
  at exact commit `09270a137ee2cd22f868e2569851804c4fb8427b`, exit 0, terminal
  `verify-E2-T07: OK` and `cold_clone: verify-E2-T07 PASSED from a pristine clone`,
  zero `SKIPPED` lines; full transcript committed at
  `evidence/e2-t07-cold-clone.txt`; pristine clone retained clean at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.88sVdKCpBM/repo`, pinned to
  the claim commit. The transcript shows the *_OS_SANDBOX_ACTIVE scrub and the
  engaged/inherited loopback attestations end-to-end.
- Attack-angle notes for the critics: (1) the streams-resolving surface is exactly
  `/api/dispatch` and `/api/repos/<org>/<repo>/<branch>/events` — both decided;
  the PlatformWebApp auth/cli-token routes operate on `__identity__` through
  IdentityStore under session/device authentication and take no stream id from
  the request; unknown `/api/repos` shapes 404 before any resolution. (2) The
  begin-race refusal and the accepted 202 both cite the sequence-guarded offset
  (`decidedAt` = the replayed offset of the reducer decision whose append the
  durable sequence precondition serialized). (3) Probes for encoded separators
  (`%2F`, double-encoding), uppercase, traversal, malformed fs ids, internal
  streams, and cross-tenant ids are golden-pinned refusals with digest-proven
  neutrality. (4) `packages/server` is byte-identical to its E2-T03 pin
  (`git diff 4df852d…HEAD -- packages/server` empty, enforced in `_v-e2-t07`);
  no Durable Streams code is copied or modified.
- Replay: N/A (server-side authorization door: platform gateway, pure decision
  function, verifier plumbing — no browser-reachable UI surface changed; the web
  app pages are byte-identical except the front-door forwarding of `/api/repos`,
  which is exercised headlessly in authz.gateway.test.ts) + mitigation: committed
  golden decision/HTTP/no-side-effect transcripts with per-stream digests, live
  two-run determinism proof inside the matrix apparatus, exact-attribution
  three-case sensitivity proof over an end-to-end probe, 24 permanent authz tests
  (pure matrix + real-HTTP integration incl. the revocation race), and the
  completed pristine cold-clone transcript at this exact commit.

### 2026-07-22 — critic — VERDICT: needs-evidence (run 1)

No recorded claim was falsified. All three assigned acceptance-criteria attacks, the
route enumeration, an independent-principal probe stack (own orgs/grants over real HTTP),
the mock/env hunt, and an 8-mutation sabotage check survived; matrix determinism
(`E2_T07_MATRIX_OK runs=2 deterministic=true`), sensitivity
(`E2_T07_SENSITIVITY_OK control=green cases=3`), and a fresh pristine cold clone
(EXIT=0, zero SKIPPED) all reproduced at the claim commit (`09270a1`, code tree
byte-identical to `e3393a3`). Seven confirmed coverage gaps stand — new diff lines on
claimed surfaces that no recorded run ever executed. Each was cross-examined
independently (instrumented zero-hit probes in a scratch clone at `e3393a3`, validated
by positive controls on adjacent lines; vitest istanbul + raw `NODE_V8_COVERAGE` over
the matrix/sensitivity/chained-verifier apparatus).

- COVERAGE GrantAwareVerifier credential-confusion arms — INSUFFICIENT. Predicted every
  changed `grants.ts` line executed in the evidence run; observed seven arms with zero
  executions across the 342-test suite, both matrix runs, all sensitivity probes, and
  the chained verifiers: `packages/platform/src/auth/grants.ts:137` (JWT-shaped token
  hash-matching a web-mint grant → revoked), `:138-142` (web-mint opaque token resolving
  a principal at the gateway — the success path never runs anywhere), `:144` (verified
  JWT whose `sub` mismatches the hash-matched grant's `sub`), `:226`/`:231` (the same
  two arms in `resolveGrant`), `:192` (rethrow; reformat-only, weakest). The claim
  "capabilities never leak across grants of the same subject" is never executed at the
  verifier layer for presented tokens — a real production path (routes.ts mints
  web-mint tokens). Demand: record gateway runs presenting (a) a web-mint opaque token
  as Bearer, (b) a JWT-shaped token whose hash matches a web-mint grant, (c) a
  validly-signed JWT for sub A hash-matching a grant issued to sub B, asserting the
  revoked/principal outcomes.
- COVERAGE fail-closed view machinery — INSUFFICIENT. Predicted the claimed fail-closed
  authorization path executed at least once; observed `AuthzViewUnavailable` never
  constructed: `packages/platform/src/authz/view.ts:12-14`, `:47` (viewFor catch),
  `:55-56` (missing stream replays as empty — deciding on a platform where `ns:root`
  does not yet exist never ran), `packages/platform/src/gateway.ts:344` and `:392-393`
  (503 `authz_view_unavailable`) all zero-hit; "the gateway fails CLOSED" is asserted
  only by a comment. Demand: a run forcing namespace-view replay failure asserting 503
  plus per-stream digest equality (no append), and a decision run against a platform
  with no `ns:root` stream.
- COVERAGE read-route error mapping — INSUFFICIENT. Predicted the new read/follow route
  exercised with failing credentials; observed the entire `decideRepo` catch
  (`gateway.ts:386-395`: TokenRevokedError → 401 token-revoked; UnauthorizedError, e.g.
  garbage/malformed Bearer → 401; view-unavailable → 503; rethrow) zero-hit — every
  recorded read/follow had no credential or a resolvable one. An end-to-end probe
  proved the branch live (`Basic …` → 401 malformed_authorization, `Bearer
  aaaa.bbbb.cccc` → 401 malformed_token) but those bodies are asserted nowhere. Demand:
  malformed-Bearer and revoked-throwing-verifier cases against
  `GET /api/repos/<org>/<repo>/<branch>/events`, goldens re-recorded.
- COVERAGE undecodable percent-escapes — INSUFFICIENT. Predicted attack angle 3
  ("malformed ids, encoded separators") fully exercised on the read route; observed only
  decodable separators ran (`%2F`, authz.gateway.test.ts:459-461); the
  `decodeURIComponent` catch substituting the three-NUL sentinel
  (`gateway.ts:373-377`, NUL literal at `:376` — makes plain grep treat the file as
  binary) had zero executions in every recorded run, including all 79 no-side-effect
  cases. Demand: a committed probe of undecodable escapes (`%zz`, `%c0%af`, truncated
  `%`) on the read route asserting `authz/malformed-target` with no side effect.
- COVERAGE malformed write-scope branch segment — INSUFFICIENT. Predicted the pure
  matrix covered every write-scope parse outcome; observed
  `packages/platform/src/authz/decide.ts:194` (`repo:write:<org>/<repo>:` prefix with
  empty/malformed branch segment → refuse) zero-hit across the 192-decision golden and
  all suites — yet it is the sole guard preventing such a scope from conferring read on
  a private repo (via the `decide.ts:275` write-grant-confers-read path), and none of
  the three sensitivity sabotages covers it. Demand: pure-matrix cases with grant
  scopes `repo:write:acme/forest:` and `repo:write:acme/forest:bad branch` asserting no
  capability is conferred; regenerate the decision-matrix golden.
- COVERAGE follow/read degenerate paths — INSUFFICIENT. Predicted the claimed live
  long-poll follow exercised on its contractual degenerate paths; observed zero
  executions of `gateway.ts:419` (400 `invalid_follow_parameters`), `:457` (follow of a
  nonexistent physical stream → `[]`), `:458-462` (the "or empty after waitMs" timeout
  arm — every recorded follow completed by finding an item, never by timeout),
  `:436`/`:464` (rethrows); `gateway.ts:435` (read not-found → `[]`) executed only
  inside the visibility-leak sabotage probe, never in the unmutated system. Demand:
  tests asserting the long-poll returns an empty event list after waitMs, invalid
  after/waitMs return 400, and an authorized read/follow of a repo whose physical
  stream has no events returns `[]` unmutated.
- COVERAGE dispatch revocation-vs-body ordering — INSUFFICIENT. Predicted the door's
  new revocation classification fully exercised; observed `gateway.ts:205` (revoked
  credential + unparseable JSON body → 401 token-revoked — an ordering decision this
  diff introduced by deferring revocation past body parse) and `:196` (defensive
  catch-all: non-UnauthorizedError/non-TokenRevoked verifier throw → 401
  malformed_token) each zero-hit in every recorded run; behavior byte-preserves the
  frozen door, so this is a coverage hole, not misbehavior. Demand: a gateway test
  sending a revoked credential with an unparseable JSON body asserting 401
  token-revoked (optionally a stub verifier throwing an unexpected error asserting 401
  malformed_token).
- SUITE: n/a until the coverage demands clear (critic probes — refused-op digest
  batches with independent principals, case-sensitivity probe of `FS:`/`fs:` ids —
  remain in `work/` for promotion on the next run).
Commands: git diff ce4ce4a..e3393a3; CI=true npx vitest run authz.test.ts
authz.gateway.test.ts (24/24); CI=true pnpm test (26 files, 342/342) with
@vitest/coverage-v8 istanbul mapped against diff-added lines; NODE_V8_COVERAGE over
tools/verify/e2_t07_matrix.mjs (E2_T07_MATRIX_OK runs=2 deterministic=true),
tools/verify/e2_t07_sensitivity.mjs (control=green cases=3), and the chained
e2_t03/e2_t06 verifiers; tools/verify/cold_clone.sh verify-E2-T07 (EXIT=0, 0 SKIPPED)

### 2026-07-22 — builder — rework claim (run 2)

- Commit: `5e1d372` (run-2 rework — every run-1 coverage demand promoted as a
  permanent test). All recorded runs execute at exact commit
  `5e1d372ab5955ed4932ee6474591beb7a9cf06e0`; this entry and the finished
  cold-clone transcript land in its direct evidence child (code tree
  byte-identical).
- Scope: no implementation code changed — the run-1 verdict found no behavioral
  defect, only unexecuted diff. Every one of the seven confirmed coverage
  findings is now executed by a committed test or golden-pinned probe, verified
  line-by-line with instrumented coverage marks
  (`work/run2-covmarks.txt`: all 24 demanded line marks hit >= 1):
  1. **GrantAwareVerifier credential-confusion arms** (grants.ts:137-144, :192,
     :226, :231) — gateway test "resolves web-mint opaque tokens and refuses
     every cross-credential confusion": (a) a web-mint opaque token as Bearer
     resolves its grant's principal (200 basis=grant:read; 202 dispatch as the
     grantee sub), (b) a JWT-shaped token hash-matching a web-mint grant →
     401 `authz/grant-revoked`, (c) a validly-signed JWT for sub A hash-matching
     a device grant issued to sub B → 401 `authz/grant-revoked`, on read AND
     dispatch; plus a liveness-store failure test pinning the :192 rethrow →
     502 with digest-proven no-append.
  2. **Fail-closed view machinery** (view.ts:12-14, :47, :55-56; gateway.ts:344,
     :392-393) — a namespace-view-outage adapter forces replay failure: read,
     follow, and dispatch all answer 503 `authz_view_unavailable` with
     per-stream digest equality, zero created streams, zero operations reaching
     any target stream; a bare platform with no `ns:root` stream decides
     against the empty view (404 `authz/not-found`, nothing throws).
  3. **decideRepo catch** (gateway.ts:386-395) — `Basic …` → 401
     `malformed_authorization`, `Bearer aaaa.bbbb.cccc` → 401 `malformed_token`,
     and a TokenRevokedError-throwing verifier → the frozen 401
     `{class: token-revoked}` body on the read/follow route; no credential
     failure reaches a stream. Golden-pinned in the http matrix
     (`probe.basic-authorization`, `probe.garbage-bearer`).
  4. **Undecodable percent-escapes** (gateway.ts:373-377 sentinel) — `%zz`,
     `%c0%af`, truncated `%`, `main%c0` on the read route all 404
     `authz/malformed-target` with zero stream operations and digest equality;
     golden-pinned (`probe.undecodable-*`, `probe.truncated-escape`).
  5. **Malformed write-scope branch segment** (decide.ts:194) — pure-matrix
     test + new matrix principal `badscope` holding
     `repo:write:acme/secret:` and `repo:write:…:bad branch`: confers neither
     write nor the write-implies-read private read; byte-identical to the
     nonexistent decision (existence-neutral), pinned in the regenerated
     192→216-decision golden.
  6. **Follow/read degenerate paths** (gateway.ts:419, :435-436, :457-464) —
     invalid `after`/`waitMs` → 400 `invalid_follow_parameters` (6 variants +
     2 golden probes); long-poll timeout with nothing past `after` → 200
     `events: []`; authorized read/follow of a repo whose physical stream was
     never created → 200 `[]` unmutated; abort-on-timeout transport → 200 with
     items gathered; non-not-found stream failures rethrow on read AND follow.
  7. **Dispatch revocation-vs-body ordering** (gateway.ts:196, :205) — revoked
     credential + unparseable JSON body → 401 `{class: token-revoked}` (never
     400), and a verifier throwing a non-Unauthorized/non-TokenRevoked error →
     401 `malformed_token`; digests unchanged.
- Goldens regenerated and re-frozen at this head: decision matrix 216 decisions
  (badscope existence-neutrality asserted in-matrix), http matrix + 7 new
  probes, no-side-effect refused-cases 79→96 (per-stream SHA-256 digests
  unchanged, created-streams-delta=0). E2-T06 no-database allowlist anchors
  shifted for the matrix apparatus growth (:600/:614 → :624/:638); transcripts
  regenerated.
- Commands (all fresh this session at `5e1d372`, exit 0):
  `pnpm format:check && pnpm lint`; `pnpm typecheck`; `CI=true pnpm test`
  (26 files, 353/353 — +11 promoted tests); `CI=true pnpm build`;
  `CI=true make verify-E2-T07` — loopback sandbox engaged (attested), authz
  suites 35/35, `E2_T07_MATRIX_OK runs=2 deterministic=true`,
  `E2_T07_SENSITIVITY_OK control=green cases=3`, chained `verify-E2-T06: OK`
  (incl. `verify-E2-T01`, `verify-E2-T03`, `verify-E0-T11`), ending
  `verify-E2-T07: OK`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T07` ran TO
  COMPLETION at exact commit `5e1d372ab5955ed4932ee6474591beb7a9cf06e0`,
  EXIT=0, terminal `verify-E2-T07: OK` and `cold_clone: verify-E2-T07 PASSED
  from a pristine clone`, zero `SKIPPED` lines; full transcript committed at
  `evidence/e2-t07-cold-clone.txt`; pristine clone retained clean at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.l4CN4PWUrR/repo`,
  pinned to the claim commit (emulator submodule at `82eb8359…`).
- Replay: N/A (unchanged from run 1 — server-side authorization door only; no
  browser-reachable surface changed in this rework, which adds only tests,
  matrix probes, and regenerated golden transcripts) + mitigation: the
  committed golden decision/HTTP/no-side-effect transcripts, live two-run
  determinism proof, three-case sensitivity proof, 35 permanent authz tests,
  instrumented per-line coverage marks for all seven findings, and the
  completed pristine cold-clone transcript at this exact commit.
