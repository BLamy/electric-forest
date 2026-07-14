---
id: E2-T01
epic: 2
title: "Identity event model frozen: user/org/membership/grant/session events on identity streams reduced to a canonical authorization view"
priority: 201
status: pending
depends_on: [E1]
estimate: M
capstone: false
---

## Goal

`packages/identity` (`@eforest/identity`) exists, builds under all workspace gates, and
freezes Epic 2's foundational contract as a **pure TypeScript package** — no server
changes, no new endpoints, and **no database or table anywhere** (bet 4). Two things are
frozen here and versioned (`IDENTITY_EVENT_VERSION = 1`): the **identity event
envelope** — eight event types (`identity.user.created` keyed by Auth0 subject,
`identity.org.created`, `identity.membership.granted` / `identity.membership.revoked`,
`identity.grant.issued` / `identity.grant.revoked`, `identity.session.started` /
`identity.session.ended`), each an `@eforest/protocol` `Event` with a schema-guarded
payload — and the **canonical authorization view**: a pure reducer `identityReducer`
(exported from `@eforest/identity` and shipped as a standalone module loadable by
`ef replay --reducer`) folds an identity stream into
`{ users, orgs, memberships, grants, sessions }` with canonical-JSON key sorting, and
the **authorization-view digest** is `stateDigest(view)` from `@eforest/protocol` —
lowercase-hex SHA-256 over the canonically-encoded view, never a second hashing
implementation. A frozen pure query API (`userForSub`, `roleOf`,
`findActiveGrantByTokenHash`, `isSessionActive`) is the exact surface every later door
(E2-T03 bearer verification, E2-T04 sessions, E2-T05 CLI grants, E2-T07 per-stream
authorization) will enforce against. A committed golden identity event log replays
through `ef replay --digest --reducer` to its committed frozen digest, twice in separate
processes with identical output, and mutating any single byte of any **grant** event's
payload makes the digest go red with `ef bisect` pinning the divergence at exactly that
event's offset — so every later Epic-2 authorization claim is a digest comparison
against this apparatus.

## Context

Epic 2 builds the-gates (ROADMAP.md, "Epic 2 — the-gates"): Auth0 is the sole identity
provider and the only external service; platform records — user profiles keyed by Auth0
subject, orgs, memberships, grants — are **events on identity streams reduced to an
authorization view the servers enforce** (ROADMAP.md, "Identity"). There is no user
table, no session table, no token table: losing any derived view loses nothing, because
`replay(identity log)` from offset `-1` is ground truth. This task is the epic's
evidence keystone, exactly as E1-T01 was Epic 1's: E2-T03's 401 refusals, E2-T04's
session provisioning, E2-T05's revocable CLI grants, E2-T07's per-stream decisions, and
the E2-T10 conformance matrix all bottom out in "fold the identity log, ask the view."
So the contract is frozen here the way E0-T03 froze the protocol and E1-T01 froze the fs
envelope: `IDENTITY_EVENT_VERSION = 1` is exported, the payload schemas and the view
shape are documented verbatim in the package readme, and any change to either requires a
version bump plus regeneration of every identity golden in the repo — a loud, deliberate
event.

`depends_on: [E1]` means the E1-T11 capstone is verified: the engine, `ef replay`
/ `ef bisect`, and the whole dispatch/replay discipline below this package are already
proven. This task deliberately makes **no server change**: the `identity` stream type is
registered with the live server's reducer registry, and dispatch-time validation is
wired to these guards, in E2-T03/E2-T04 — here the reducer, guards, and goldens are
proven standalone through the CLI evidence tools. The Auth0 emulator is E2-T02;
nothing in this package talks to a network.

Contracts frozen by this task:

- **identity event envelope** — identity events are `@eforest/protocol` `Event`s
  (`{ type, payload, ts }`) with these types and payload schemas, enforced by runtime
  guards (`isIdentityEvent`, per-type validators) and, from E2-T03 on, by `/api/dispatch`:
  - `identity.user.created` — `{ v: 1, sub, email }` — `sub` is the Auth0 subject
    (opaque non-empty string, ≤ 256 chars, no control chars, NFC-normalized) and **is
    the user key**; there is no separate user id.
  - `identity.org.created` — `{ v: 1, orgId, name, ownerSub }` — `orgId` a slug
    (`[a-z0-9][a-z0-9-]{0,63}`), `name` NFC-normalized UTF-8; the reducer materializes
    the owner as an implicit `owner`-role membership, deterministically.
  - `identity.membership.granted` — `{ v: 1, orgId, sub, role }`, `role` ∈
    `"admin" | "member"` (`owner` exists only via `org.created`, is unique per org, and
    is not grantable or revocable).
  - `identity.membership.revoked` — `{ v: 1, orgId, sub }`.
  - `identity.grant.issued` — `{ v: 1, grantId, sub, kind, scopes, tokenHash }` —
    `kind` ∈ `"cli-token" | "web-session-mint"`, `scopes` a deduplicated,
    lexicographically sorted array of scope strings (unsorted or duplicated arrays are
    refused — canonical on the wire, not normalized silently), `tokenHash` the
    lowercase-hex SHA-256 of the bearer secret. **Raw secret material never appears in
    any event**: any payload carrying a `token`/`secret`-like extra field, or a
    `tokenHash` that is not exactly 64 lowercase hex chars, is refused.
  - `identity.grant.revoked` — `{ v: 1, grantId }`.
  - `identity.session.started` — `{ v: 1, sessionId, sub }`.
  - `identity.session.ended` — `{ v: 1, sessionId }`.
  Extra fields, missing fields, wrong types, or unknown `identity.*` types are refused
  by the guards (and later by dispatch) with the log untouched.
- **precondition invariants** — these are replay invariants, not just future
  dispatch-time courtesy; a log violating one is corrupt and `ef replay` must exit
  nonzero naming the offending 1-based line: duplicate `sub` in `user.created`;
  duplicate `orgId`; `org.created` with unknown `ownerSub`; membership grant on an
  unknown org or user, or while already active; membership revoke of a non-active
  membership or of the owner; `grant.issued` with a duplicate `grantId`, an unknown
  `sub`, or a `tokenHash` equal to any **currently-active** grant's `tokenHash` (a
  revoked grant's hash may be reused — uniqueness is over active grants only, which is
  what makes `findActiveGrantByTokenHash`'s singular return well-defined);
  `grant.revoked` of an unknown or already-revoked grant; `session.started`
  with a duplicate `sessionId` or unknown `sub`; `session.ended` of an unknown or
  already-ended session.
- **canonical authorization view** — the reduced state is
  `{ users: { [sub]: { email } }, orgs: { [orgId]: { name, ownerSub } },
  memberships: { [orgId]: { [sub]: { role, status } } },
  grants: { [grantId]: { sub, kind, scopes, tokenHash, status } },
  sessions: { [sessionId]: { sub, status } } }` with `status` ∈
  `"active" | "revoked"` (memberships, grants) or `"active" | "ended"` (sessions).
  Revoked and ended records are **retained with flipped status, never deleted** — both
  because revocation is auditable state and because it makes every payload byte
  state-reaching for the digest (the sensitivity contract below). Re-grant of a revoked
  membership flips it back to active with the new role. Canonical-JSON key sorting
  supplies all ordering.
- **view digest** — `viewDigest(view) === stateDigest(view)` from `@eforest/protocol`.
- **enforcement query API** — pure functions of `(view, args)` only, no I/O, no clock:
  `userForSub(view, sub)`, `roleOf(view, orgId, sub)` → `"owner" | "admin" | "member"
  | null` (owner answered from `orgs[orgId].ownerSub`),
  `findActiveGrantByTokenHash(view, tokenHash)` → grant + grantId or `null` (**never
  matches a revoked grant**; unambiguous because the duplicate-active-`tokenHash`
  invariant above guarantees at most one active grant per hash),
  `isSessionActive(view, sessionId)`. These signatures are
  part of the freeze: E2-T03/T05/T07 call these, not reimplementations.

Non-goals: the OIDC emulator (E2-T02), any HTTP verification or 401 (E2-T03), login/
session flows (E2-T04), token minting (E2-T05), stream namespaces and per-stream
authorization decisions (E2-T06/T07), rate limits (E2-T11). Time-based expiry is out of
scope for v1: grants and sessions end only by explicit revoke/end events, because the
reducer is pure and must never consult a clock — expiry, when it comes, arrives as
events too.

## Deliverables

- `packages/identity/` — workspace package `@eforest/identity`, wired into the root
  `pnpm format:check` / `lint` / `typecheck` / `test` / `build` gates.
- `packages/identity/src/version.ts` — `export const IDENTITY_EVENT_VERSION = 1`;
  package readme documents the frozen envelope, precondition invariants, view shape,
  digest recipe, the enumerated sensitivity carve-outs, and the invalidation rule
  (version bump + regenerate every identity golden in the repo).
- `packages/identity/src/events.ts` — the eight payload types plus runtime guards
  (`isIdentityEvent`, per-type validators) rejecting missing/extra/wrong-typed fields,
  malformed `sub`/`orgId`/`tokenHash`, unsorted or duplicated `scopes`, non-NFC
  strings, and any secret-material smuggling per the frozen envelope.
- `packages/identity/src/reducer.ts` — `identityReducer(state, event)`: pure (no I/O,
  no `Date` / `Math.random` / env / network), conforming to the `@eforest/protocol`
  reducer signature, enforcing every precondition invariant as a reducer-level error so
  `ef replay` exits nonzero on a corrupt log rather than skipping.
- `packages/identity/src/view.ts` — the `AuthorizationView` type, `emptyView()`, and
  `viewDigest(view)` delegating to `@eforest/protocol`'s `stateDigest`.
- `packages/identity/src/queries.ts` — the four frozen enforcement helpers, pure over
  the view.
- `packages/identity/reducer.mjs` (or equivalent built entry, path documented in the
  package readme) — the standalone reducer module loadable by
  `ef replay <dump> --digest --reducer <path>`; this file is the registration of
  identity with the evidence tooling and is what every Epic-2 Verification log cites.
- Committed golden fixture: `evidence/golden-identity.jsonl` — an identity-stream dump
  exercising: two users (one with a unicode email/name path), an org with implicit
  owner membership, membership grant → revoke → re-grant with a different role, **at
  least two grants of different kinds, one of which is later revoked** (`grantId`s
  pairwise different in at least two bytes, so every single-byte `grantId` mutation
  references an unknown grant), and a session
  started and ended — plus `evidence/golden-identity.digest` (the frozen
  authorization-view digest, produced once, committed, never regenerated by any check
  that consumes it).
- Committed refusal corpus: `evidence/fuzz/` — two classes, each case with its expected
  error class asserted by committed tests: (a) **guard refusals** — unknown
  `identity.*` type, missing/extra/wrong-typed fields, `v: 2`, malformed `sub`
  (empty, control chars, > 256, NFD form of an existing NFC sub), malformed `orgId`,
  uppercase / 63-char / non-hex `tokenHash`, a raw `token` field riding along,
  unsorted and duplicated `scopes`; (b) **corrupt logs** — one dump per precondition
  invariant above (duplicate sub, revoke-before-issue, double revoke, owner revoke,
  grant for unknown user, `grant.issued` reusing a currently-active grant's
  `tokenHash`, session ended twice, …), each making `ef replay` exit
  nonzero with a diagnostic naming the offending 1-based line.
- Tests (`packages/identity/test/`): guard matrix over corpus (a); CLI-driven
  nonzero-exit checks over corpus (b); reducer semantics (implicit owner membership,
  re-grant role change, revoked-status retention); query-API behavior including
  `findActiveGrantByTokenHash` returning `null` for a revoked grant's hash; the
  differential check — in-process `replay()` fold, `ef replay --reducer` over the
  dumped golden, and a direct `identityReducer` fold in a scratch harness all
  producing the identical view digest; and the payload-byte sensitivity sweep below.
- Property tests over event orderings (`packages/identity/test/ordering.property.test.ts`,
  seeded PRNG with the failing seed printed on red): generate random valid identity
  histories (users, orgs, memberships granted/revoked/re-granted, grants
  issued/revoked, sessions started/ended) and assert (i) any generated valid log folds
  without error and every query helper agrees with an independent oracle fold of the
  same log; (ii) interleaving events of **independent entities** (different subs, orgs,
  grantIds, sessionIds) in any relative order yields the identical view digest — the
  only order-independence the docs claim; (iii) any reordering that lifts an event
  above one of its preconditions (revoke before issue, membership before user, session
  end before start) makes the fold exit nonzero — order-dependence where the docs
  claim it is enforced, not accidental.
- `Makefile`: `verify-E2-T01` inside the marker section composing the frozen helper
  recipes (`_v-fmt _v-lint _v-typecheck _v-test _v-build _v-replay-determinism`) plus
  the identity golden step: replay `evidence/golden-identity.jsonl` through
  `ef replay --digest --reducer` **twice as separate `ef` process invocations**,
  compare both digests to each other and to `evidence/golden-identity.digest`; then
  the sensitivity proof — flip one byte of one **grant** event's payload in a temp
  copy, assert the replay comparison exits nonzero, and run `ef bisect` between the
  original and mutated logs asserting the first divergent offset is exactly the
  mutated event's offset, printing `MUTATION fixture=golden-identity byte=<offset>
  digest-mismatch bisect=<event-offset> EXPECTED-FAIL OK` only after observing both.
  Joins `verify-all`; `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E2-T01` exits 0 with zero `SKIPPED:` lines — evidence:
      `make verify-E2-T01 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] `ef replay evidence/golden-identity.jsonl --digest --reducer <documented reducer
      path>` prints exactly one lowercase-hex SHA-256 line on stdout matching
      `evidence/golden-identity.digest` and exits 0; two runs in fresh shells produce
      byte-identical output (`diff <(run1) <(run2)` empty). The Makefile step performs
      this as two separate `ef` process invocations, per the recipe text.
- [ ] **Grant sensitivity with offset pinning (the task's headline claim):** for
      **every byte of every `identity.grant.issued` / `identity.grant.revoked`
      payload** in a copy of `evidence/golden-identity.jsonl`, a single-byte mutation
      either makes the replay exit nonzero (parse/guard/invariant failure) or produces
      a digest different from `evidence/golden-identity.digest` — **no carve-outs in
      the grant class**, because revoked grants are retained in the view; and for every
      `identity.grant.issued` event, at least one digest-changing single-byte mutation
      (e.g. a `tokenHash` hex-digit flip) is bisected: `ef bisect` between original and
      mutated replays pins the first divergent offset at exactly that event's offset.
      (Fixture constraint on the golden: `grantId`s in the golden are pairwise
      different in at least two bytes, so every single-byte `grantId` mutation
      references an unknown grant. Under that constraint, `identity.grant.revoked`
      payloads — `{v, grantId}` against this golden — admit no digest-changing
      single-byte mutation: every mutation there must exit nonzero via the guard or
      the revoke-of-unknown-grant invariant, which the sweep asserts; bisect pinning
      is therefore required only for `grant.issued` events.) Evidence: a
      committed sweep test pinned to every grant payload
      byte, plus `make verify-E2-T01 2>&1 | grep -c '^MUTATION .* digest-mismatch
      .* EXPECTED-FAIL OK$'` ≥ 1.
- [ ] Full-log sensitivity, scoped to state-reaching mutations: the sweep domain is
      **every byte of every JSONL line of the golden** — envelope bytes (`type`, `ts`,
      structural JSON) included, not payload bytes only — and at every position the
      pass condition is the three-way disjunction — nonzero exit, OR a digest
      different from the golden's, OR the **independently-folded final view of the
      mutated log equals the original's fold** (never merely golden-vs-digest).
      Carve-out classes must be enumerated explicitly in the package readme; given
      status-retention the expected list is only envelope `ts` bytes and mutations
      producing canonically identical JSON — a mutation whose
      independently-folded view provably differs yet replays green to the golden digest
      is a failure of the apparatus, not of the fixture. Evidence: the committed sweep
      test asserting the disjunction at every position, carve-out positions asserted as
      expected-green rather than skipped.
- [ ] Corrupt-log invariants: every case in `evidence/fuzz/` class (b) fed through
      `ef replay --reducer` exits nonzero with a diagnostic naming the offending
      1-based line — evidence: committed CLI-driven tests, green under `pnpm test`.
- [ ] Guard matrix: every case in `evidence/fuzz/` class (a) is rejected by the runtime
      guards with its expected error class, and no guard mutates its input — evidence:
      committed test iterating the corpus, green under `pnpm test`.
- [ ] No secret material in the log: the golden contains bearer-token **hashes only**;
      a committed test asserts every `grant.issued` in the golden carries a 64-char
      lowercase-hex `tokenHash` and no payload anywhere in the golden contains a field
      outside its frozen schema; the raw-`token` smuggling case in the refusal corpus
      is refused — evidence: committed tests, green.
- [ ] Ordering property tests: the committed seeded property suite over random event
      orderings is green under `pnpm test` — independent-entity interleavings digest
      identically, precondition-violating reorderings exit nonzero, and every generated
      valid log's query answers match the oracle fold; a red run prints its seed so the
      critic can replay it. Strength floor: each of properties (i)–(iii) runs at least
      **500 generated histories** (a "generated history" is one randomly generated event
      log fed to the property), the test itself asserts that count, and the transcript
      under `evidence/` prints the per-property count — evidence: committed test file
      plus that transcript. Adversarial angle 6 escalates beyond this floor with the
      critic's own seeds; it does not substitute for it.
- [ ] Query-API truth: committed tests assert, against the golden's folded view —
      `userForSub` resolves both users and returns `null` for an unknown sub; `roleOf`
      answers `owner` for the org creator without any membership event, answers the
      re-granted role (not the original) for the re-granted member, and `null` after
      revocation; `findActiveGrantByTokenHash` finds the live grant by its hash and
      returns `null` for the revoked grant's hash; `isSessionActive` is `false` for the
      ended session — evidence: committed tests, green.
- [ ] Purity: `grep -rnE --exclude='*.test.ts'
      "Math\.random|\bnew Date\b|Date\.now|performance\.now|hrtime|setTimeout|setInterval|crypto\.(getRandomValues|randomUUID|randomBytes)|process\.env|(from ['\"]|require\(['\"]|import\(['\"])(node:)?(fs|net|http|https|child_process)['\"/]?"
      packages/identity/src` returns nothing (the command as committed in the evidence
      transcript is binding, and must cover every clock/randomness/env/I-O construct
      named in the `reducer.ts` deliverable) — the scan covers **all of `packages/identity/src`** (this
      package has no I/O-performing client module), so impurity cannot hide in a
      sibling helper. Additionally the golden digest is identical under
      `TZ=Pacific/Kiritimati LANG=C` vs default env — evidence: both transcripts
      committed under `evidence/`.
- [ ] Differential digest agreement: (a) `ef replay --reducer` over the golden,
      (b) an in-process `@eforest/protocol` `replay()` fold with `identityReducer`, and
      (c) `viewDigest` over a hand-driven fold in a scratch harness are all
      byte-identical — evidence: committed test printing all three digests.
- [ ] **No server change, no database (bet 4):** the task's commits touch only
      `packages/identity/`, the `Makefile`, the root `package.json`,
      `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and this task folder — the binding
      check is the allowlist itself:
      `git diff --stat <base>..<head> -- . ':(exclude)packages/identity'
      ':(exclude)Makefile' ':(exclude)package.json' ':(exclude)pnpm-workspace.yaml'
      ':(exclude)pnpm-lock.yaml'
      ':(exclude).eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model'` must
      print nothing, cited as a transcript under `evidence/`; additionally
      `git diff --stat <base>..<head>` cited in the Verification
      log shows no hunk under `packages/server/`, `packages/client/`,
      `packages/protocol/`, or `packages/streamfs/`; and
      `git diff <base>..<head> -- packages/identity package.json pnpm-lock.yaml |
      grep -niE "sqlite|postgres|better-sqlite|prisma|knex|typeorm|drizzle|leveldb"`
      returns nothing (exit 1), where `<base>` is the commit immediately before this
      task's first commit — evidence: transcript committed under `evidence/`.
- [ ] `IDENTITY_EVENT_VERSION = 1` is exported, and the package readme states the
      frozen envelope, precondition invariants, view shape, query-API signatures,
      carve-outs, and the golden-invalidation rule — evidence: the committed files.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `tools/verify/self_check.sh`
      passes; `make verify-list` shows `verify-E2-T01` mapped to this task;
      `verify-all` (including every E0 and E1 target and their golden transcripts)
      still green — this task is additive to the frozen protocol and stream-fs.
- [ ] Replay browser layer: N/A (pure library; no browser-reaching surface — the first
      Epic-2 browser evidence is E2-T04) — the Verification log entry must declare
      this explicitly per AGENTS.md; stream-layer evidence above is the currency.

## Adversarial verification

Your mission: refute the claim that this apparatus turns authorization claims into
digest comparisons. Every attack pairs a manipulation with a refutation condition. Use
your own inputs, never the builder's. Any single success refutes.

1. **Grant sensitivity, your own bytes (mandatory).** Ignore the builder's chosen
   mutation. Sweep every byte of every grant payload in a copy of
   `evidence/golden-identity.jsonl` yourself: flip hex digits of `tokenHash`, mutate
   one char of a `grantId` (both in `issued` and in the matching `revoked` — a
   dangling revoke must exit nonzero, not fold), mutate `kind`, reorder or mutate
   `scopes`, point `sub` at the other user. Contract: **every** grant-payload mutation
   exits nonzero or changes the digest — the grant class has no carve-outs. For each
   digest-changing mutation, run `ef bisect` yourself: the first divergent offset must
   be the mutated event's offset, not an earlier or later one. Then sweep every
   remaining byte of every JSONL line (non-grant payloads **and** envelope bytes,
   per the full-log criterion) under the three-way disjunction, independently folding each
   mutated log and comparing views yourself. **A mutation whose independently-folded
   view provably differs from the original's yet replays green to the golden digest
   refutes the entire measuring apparatus** — file that as a task refutation, not a
   bug.
2. **Self-licking goldens.** Delete `evidence/golden-identity.digest` and run the
   golden step — it must fail red, not regenerate-and-pass. Inspect git history and
   recipe/test code for any path that writes or recomputes the digest at check time.
   Then derive the digest **independently**: parse the jsonl yourself, fold the
   documented reducer semantics by hand (python + `json.dumps(obj,
   separators=(',',':'), sort_keys=True, ensure_ascii=False)` + `shasum -a 256`,
   hand-deriving where canonical JSON and python disagree — the implicit owner
   membership and status-retention rules are documented; apply them from the docs, not
   from the code). An independent derivation that disagrees is a refutation; a digest
   only the package's own code can reproduce is **needs-evidence**.
3. **Corrupt logs of your own.** Craft dumps the builder's corpus doesn't contain:
   revoke a grant, then revoke it again; `session.ended` before any
   `session.started`; `membership.granted` with `role: "owner"`; a second
   `user.created` for an existing sub with a *different* email (there is no user
   deletion, so this must trip the duplicate-sub invariant); an org whose `ownerSub` appears in a later
   `user.created` (order matters — owner must exist first); a grant revoked in the
   same log line count but reordered above its issue. Each must make `ef replay` exit
   nonzero naming the line. Any corrupt log that folds to a view and hands back a
   digest refutes the invariants-are-replay-invariants claim.
4. **Secret hunt.** Craft `grant.issued` payloads smuggling secrets: a `token` field,
   a `tokenHash` of 64 chars where 63 are hex and one is uppercase, a base64-looking
   `tokenHash`, scopes containing a JWT-shaped string. The guards must refuse each
   with the documented error class. Then scan the committed golden yourself for
   anything resembling raw secret material (long high-entropy non-hash strings). A
   guard that normalizes instead of refusing (silently lowercasing, silently sorting
   `scopes`) refutes the canonical-on-the-wire contract.
5. **Authorization drift.** Write your own identity log (your seeds: three users, two
   orgs, cross-org memberships, a grant issued → revoked → a *new* grant with the
   same tokenHash — the reissue after revoke must fold green, because the frozen
   invariant forbids duplicate hashes among **active** grants only; then a variant
   where the second grant is issued while the first is still active, which must make
   `ef replay` exit nonzero per the duplicate-active-`tokenHash` invariant). Fold it by
   hand and interrogate the query API against your derived answers: revoked grants
   never found by hash, `roleOf` after revoke is `null`, re-grant answers the new
   role, owner role answered with zero membership events. Any helper that disagrees
   with the documented fold, consults a clock, caches across calls, or mutates the
   view refutes. Check `findActiveGrantByTokenHash` does exact-match on the full
   64-char hash — prefix or case-insensitive matching refutes.
6. **Determinism, environmentally and structurally.** Replay the golden under
   `TZ=Pacific/Kiritimati LANG=C` vs defaults, from two different cwds, in fresh
   processes — digests byte-identical. Feed an NFD-encoded form of an existing NFC
   `sub` or org `name`: the guard must refuse it (canonical-on-the-wire — silent
   normalization refutes, per angle 4); acceptance of a second view key for one
   user-visible identity refutes determinism of every future authorization decision. Check key ordering: build a log inserting orgs/users in
   reverse-lexicographic order and confirm the digest matches the same events'
   sorted-insertion digest only where the docs claim order-independence — and that
   the docs make no order-independence claim the reducer can't back (memberships
   grant/revoke/re-grant are order-dependent by design). Rerun the ordering property
   suite with **your own seeds** (thousands of cases, not the committed default) and
   with the generators biased toward the nasty corners (single-entity logs, maximal
   interleaving, revoke-heavy histories); a seed that folds a precondition-violating
   log green, or digests two independent-entity interleavings differently, refutes.
7. **Sabotage the suite.** In a scratch worktree, break the implementation four ways:
   (a) make `identityReducer` ignore `identity.grant.revoked`, (b) make the view
   delete revoked grants instead of retaining them with status, (c) make the guards
   accept `v: 2`, (d) make `findActiveGrantByTokenHash` match revoked grants. For
   each: `pnpm test` **and** `make verify-E2-T01` must go red. Any sabotage that
   stays green refutes whichever gate it slipped past. Check the diff for
   `.skip`/`.todo`/inline lint disables while there.
8. **Freeze and scope audit (bet 4).** Confirm `IDENTITY_EVENT_VERSION` is exported
   and the invalidation rule documented; in a scratch worktree add a payload field to
   `grant.issued` and confirm the committed golden goes red — a schema change the
   goldens survive refutes the freeze. Then hold the diff against the no-server-change
   claim: any hunk under `packages/server`/`client`/`protocol`/`streamfs`, any new
   dependency that is a database or embedded store, any file that persists identity
   state outside events (a JSON "index" written at build/test time counts) refutes.
   Confirm `verify-all` still runs every E0 and E1 target green — a regression
   smuggled in by this package refutes its "additive" claim.
9. **Coverage.** Hold the claimed final run against the diff: every guard-refusal
   class, every corrupt-log invariant, the implicit-owner path, re-grant role change,
   revoked-status retention, all four query helpers including their `null` branches,
   and both sensitivity sweeps must each have been executed by a committed test or a
   cited transcript. Unexecuted diff is unproven or dead — builder picks which, you
   enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No refutation
→ promote at minimum: your independent digest derivation as a committed cross-check, and
any corrupt log or hostile payload that found interesting surface into the refusal
corpus.

## Verification log
