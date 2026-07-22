---
id: E2-T07
epic: 2
title: "Platform authorization: per-repository read, follow, and dispatch decisions before official-stream access"
priority: 207
status: implemented
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
