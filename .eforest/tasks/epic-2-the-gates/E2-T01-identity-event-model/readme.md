---
id: E2-T01
epic: 2
title: "Identity event model frozen: user/org/membership/grant/session events on identity streams reduced to a canonical authorization view"
priority: 201
status: in-progress
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
      `pnpm-workspace.yaml`, `pnpm-lock.yaml`, this task folder, and the two
      human-approved derived E1-T11 artifacts
      `.eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/transport-provenance.json`
      and `evidence-manifest.json`, plus `.eforest/project.json` only for committed
      loop-state transitions explicitly authorized by a human after `invalid_loop`, and
      `.eforest/tasks/QUEUE.md` only as the deterministic output of
      `python3 tools/build_queue.py` after this task's lifecycle transitions. The queue
      inclusion is explicitly human-authorized by the request to rebuild the stale queue;
      rerunning the generator at the judged submission must leave it unchanged.
      The final base-to-head project diff may change only `status`, `statusReason`, and
      `updatedAt`. Those artifacts may change only because E1's
      unchanged standing sensor intentionally binds E2's required root integration
      files; no E1 implementation, verifier, or other evidence file is permitted to
      change. The binding check is the allowlist itself:
      `git diff --stat <base>..<head> -- . ':(exclude)packages/identity'
  ':(exclude)Makefile' ':(exclude)package.json' ':(exclude)pnpm-workspace.yaml'
  ':(exclude)pnpm-lock.yaml' ':(exclude).eforest/project.json'
  ':(exclude).eforest/tasks/QUEUE.md'
  ':(exclude).eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model'
  ':(exclude).eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/transport-provenance.json'
  ':(exclude).eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/evidence-manifest.json'`
      must print nothing, cited as a transcript under `evidence/`; additionally
      `git diff --stat <base>..<head>` cited in the Verification
      log shows no hunk under `packages/server/`, `packages/client/`,
      `packages/protocol/`, or `packages/streamfs/`; and
      `git diff <base>..<head> -- packages/identity package.json pnpm-lock.yaml |
  grep -niE "sqlite|postgres|better-sqlite|prisma|knex|typeorm|drizzle|leveldb"`
      returns nothing (exit 1), where `<base>` is the commit immediately before this
      task's first commit — evidence: transcript committed under `evidence/`.
- [ ] **Downstream provenance invalidation is exact, not a waiver:**
      `packages/identity/scripts/verify-provenance-refresh.mjs` compares both refreshed
      E1 artifacts with their bytes at `<base>`, proves the E1 provenance/verifier file
      set is unchanged, proves only `Makefile`, `package.json`, and `pnpm-lock.yaml`
      hashes changed, re-hashes those three current files independently, proves the
      derived manifest changed only at the transport-provenance digest, and proves the
      two approved artifacts are the only changed paths anywhere in the E1-T11 evidence
      folder. The script joins `verify-E2-T01` and must print its exact changed-input and
      changed-artifact sets before that target, `verify-all`, or the cold clone can pass.
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
   `user.created` for an existing sub with a _different_ email (there is no user
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
   orgs, cross-org memberships, a grant issued → revoked → a _new_ grant with the
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

### 2026-07-16 — judge round 5 — VERDICT: refuted

- **Installed dependency resolution identity failed.** In an exact `ae281b7` disposable
  clone, the judge copied the byte-identical `@durable-streams/client` package to a fake
  `.pnpm/critic-alternate-slot@9.9.9/node_modules/@durable-streams/client` entry and
  repointed only the workspace package link. `verify-provenance-refresh.mjs` still exited
  `0` with the ordinary 235-file / seven-verifier success object. The current policy
  checks only that the resolved path is under `.pnpm` and ends in the package name; it
  never binds the store entry to the frozen `installedPackage.version` (`0.2.6`). Demand:
  derive the permitted realpath from the frozen name/version and add byte-identical
  alternate-slot substitutions for both installed packages to the permanent sensitivity
  suite. Citation: `work/e2-t01-r5-provenance/RESULTS.md` and
  `work/e2-t01-r5-judge/RESULTS.md`.
- **Repository path identity is not ancestor-closed.** Replacing the parent
  `tools/verify/` directory with an absolute link to byte-identical external contents
  also left the provenance sensor green. `assertRegularFile` checks only each leaf after
  the operating system has followed its parent. Demand: one invariant must walk and
  `lstat` every repository-relative component from the repository root through every
  explicit file and closure root; promote the linked-ancestor case without a
  verifier-specific exception. Citation: `work/e2-t01-r5-provenance/RESULTS.md` and
  `work/e2-t01-r5-judge/RESULTS.md`.
- **Green evidence reconciled.** Identity/CLI verification survived every requested
  fixture, manifest, process-output, and `ownEntry` mutation plus nine fresh names; the
  scope/environment critic verified the symbolic final-tip allowlist, queue idempotence,
  project/E1 restrictions, and a scrubbed 249/249 cold clone. Exact-tip `verify-all` and
  all ten promoted provenance mutations are genuinely green, but neither new dependency
  edge is among those ten. Replay: N/A (pure package-resolution/repository provenance
  behavior) + mitigation: two independent disposable-clone reproductions, retained
  identity/scope proofs, exact digests, full inherited gates, and cold-clone evidence.
- **Loop state.** Round 4 and round 5 both refute the same provenance path-identity
  invariant, one dependency edge apart. Per `.eforest/loop.md`'s same-task
  `implemented -> refuted`-twice trigger, the project records `invalid_loop` and stops for
  explicit human review rather than silently routing into another builder attempt.

### 2026-07-16 — builder — round 5 path-identity and exact-fixture rework submitted

- Exact implementation commit: `55f8e5b095cf7de6c02d7d73227f87d27bc4a5ef`.
  The five inherited event-type refusals are now frozen as exact `(name, file, type)`
  mappings. Each referenced JSONL is decoded as exactly one newline-terminated canonical
  record before the CLI runs; its exact inherited type, empty payload, exit `1`, empty
  stdout, line number, `identity/unknown-type` code, and quoted type diagnostic are all
  asserted. The focused identity suite passed 9/9.
- Provenance path identity is dependency-closed. Every explicit repository closure path
  must be a regular non-symlink file; every source/dist and E1 evidence closure root must
  be a regular non-symlink directory before recursion. Installed packages intentionally
  permit a materialized directory or a pnpm symlink, but any symlink must resolve inside
  this repository's `.pnpm` store to the named package before its exact 50-file closure is
  hashed. The promoted sensitivity run passed ten attacks and restored green after each:
  byte-identical explicit-file, source-root, and evidence-root symlinks; an external
  installed-package symlink; unlisted verifier bytes; duplicate provenance paths;
  shadowed manifest members; untracked binary evidence; untracked closure files; and
  installed transport-byte drift.
- The ordered builder gates were restarted after an overlapping self-validation process
  cleaned build output underneath a duplicate test run. The serialized final run passed:
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (17 files, 249/249), and
  `pnpm build`.
- Exact-tip `make verify-all` passed at `55f8e5b`: 249/249 repository tests, 109/109
  focused inherited StreamFS tests, every E0/E1 target, E1 final digest
  `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`, all nine
  inherited E1 sabotage sensors, and `verify-E2-T01` with the ten provenance mutations.
  Identity digests remained `00d247cbbbd8cec0015400ed153eae50ed64fa58f7d1d9c8313eb50175b2cc99`
  (main), `064121fb63caa5e352ee9474ce9386d28a8a4febe002c2e4d3d0310ee4571f16`
  (prototype keys), and `5b2e66bee06ecd33945973686eac99aba21f2a5d65ad01840a480ca517ee56b9`
  (revoked-membership prefix).
- Scrubbed `tools/verify/cold_clone.sh --keep verify-E2-T01` cloned exact commit
  `55f8e5b` to `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.k5OsNgCXh2/repo`,
  reused 151 packages with zero downloads, passed 249/249 tests, and passed the exact
  identity/provenance target including all ten mutations.
- The final-tip scope command in `evidence/scope-transcript.txt` uses symbolic `HEAD`,
  explicitly excludes the human-requested generated `.eforest/tasks/QUEUE.md`, and was
  empty at the implementation tip; protected package diffs and the database scan were
  also empty. `python3 tools/build_queue.py` was idempotent there. The critic must rerun
  the same commands at the retained submission tip so the implemented-status queue
  rebuild is covered rather than inferred.
- Replay: N/A (pure TypeScript identity guards/reducer plus repository provenance and
  generated queue lifecycle work; there is no browser-reaching surface) + mitigation:
  committed exact JSONL/digest evidence, canonical CLI assertions, ten disposable-clone
  path/byte mutations, exact-tip `verify-all`, and the scrubbed pristine cold clone above.

### 2026-07-16 — judge round 4 — VERDICT: refuted

- **Provenance-closure path identity failed.** In the retained pristine submission clone,
  replacing frozen explicit verifier `tools/verify/e1_capstone_external.mjs` with an
  absolute symlink to byte-identical external contents still made
  `verify-provenance-refresh.mjs` exit 0 with its same 235-path / seven-verifier success
  object. Explicit closure paths are artifact strings checked only through
  symlink-following `readFileSync`; recursive closure roots are likewise not lstat-checked
  before enumeration. Citation:
  `packages/identity/scripts/verify-provenance-refresh.mjs:37-55,85-105` and
  `work/e2-t01-r4-judge/RESULTS.md`.
- **Exact-submission scope allowlist failed.** The binding command over scope base
  `4b70c57b` through submitted head `122eacc` prints `.eforest/tasks/QUEUE.md`. The
  committed scope transcript stops at implementation `839a4c8`, before the required
  implemented-status queue rebuild, so it cannot prove the criterion's final-tip
  assertion. The generated queue change is legitimate lifecycle output but must be
  explicitly authorized by the criterion and exact-submission transcript.
- **Inherited-type CLI fixture anchoring needs evidence.** Runtime guard/assert/reducer/
  CLI semantics for all five prototype-inherited type names now pass, and own-key-removal
  sabotage is caught. However, substituting the ordinary `identity.unknown` type into all
  five named JSONLs leaves the focused suite green (9/9), because the CLI test anchors
  case names but not exact `(name, file, type)` bytes. Citation:
  `packages/identity/test/identity.test.ts:267-283` and
  `work/e2-t01-r4-identity/RESULTS.md`.
- **Reconciliation.** Fresh `make verify-all` and scrubbed exact-submission cold clone
  genuinely passed 249/249 tests, every inherited target/sensor, and E2-T01. They prove
  reproducibility and present-byte behavior, but do not attack symlink identity, the
  literal final-tip allowlist, or fixture substitution. Replay: N/A (pure identity and
  repository-verifier work) + mitigation: exact-tip broad gates plus the direct symlink,
  allowlist, and focused sensitivity attacks above.
- **Retry policy.** This is the first refutation after the human-authorized round-four
  override. E2-T01 returns to the builder for rework; it does not yet exhaust the renewed
  retry budget.

### 2026-07-15 — builder — round 4 validator and exact-provenance rework submitted

- Implementation commit: `839a4c8ef7f8c13b16332bf748a534dfb0cef354`. The validator
  registry now resolves handlers through the same `Object.hasOwn`-based `ownEntry`
  boundary used by identity state. Exact event types `toString`, `constructor`,
  `__proto__`, `valueOf`, and `hasOwnProperty` are committed in both the 22-case guard
  corpus and five separate one-line CLI refusal logs. The permanent matrix proves strict
  boolean `false`, `IdentityEventValidationError` code `identity/unknown-type`, reducer
  refusal without state/input mutation, and CLI exit 1 at line 1 for every key.
- The provenance sensor now treats scope-base E1 evidence as a frozen dependency graph:
  it enumerates and SHA-256 checks all 235 repository closure paths, derives all seven
  verifier inputs from that artifact, checks both published transport installations (50
  files), rejects extra source/dist and evidence paths by direct filesystem enumeration,
  and constructs the exact expected provenance and manifest bytes from the base with
  only the three approved root hashes plus derived manifest digest replaced. The new
  external sensitivity runner clones a disposable fixture and proves six mutations red:
  unlisted verifier bytes, duplicate provenance path, shadowed manifest member, untracked
  binary evidence, untracked closure source, and installed transport bytes; every restore
  returns the baseline to green. Refreshed manifest provenance digest:
  `623661bc60a12b7bd9f7de597dc7c3cecbaa3dd712f7d987e3269fd7697ea69b`.
- Ordered gauntlet: `pnpm format:check && pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm build` passed after the first full test attempt hit one pre-existing StreamFS
  five-second timeout at 248/249; that file passed 5/5 alone and the mandatory restart
  passed 17/17 files and 249/249 tests. The first `make verify-E2-T01` attempt likewise
  hit two unrelated merge-test five-second timeouts at 247/249; the file passed 7/7
  alone, and a restart from formatting passed 249/249 plus every task-specific proof.
- Exact-tip inherited verification: the first `make verify-all` attempt hit one unrelated
  CLI five-second timeout at 248/249; the exact test passed alone, and a restart from
  formatting passed 249/249 repository tests, 109/109 focused inherited tests, every E0
  and E1 target, E1-T11's 17-event
  `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`
  digest, all nine E1 sabotage sensors, and `verify-E2-T01` including the six new
  mutations. Identity digests remained
  `00d247cbbbd8cec0015400ed153eae50ed64fa58f7d1d9c8313eb50175b2cc99`,
  `064121fb63caa5e352ee9474ce9386d28a8a4febe002c2e4d3d0310ee4571f16`, and
  `5b2e66bee06ecd33945973686eac99aba21f2a5d65ad01840a480ca517ee56b9`.
- Scrubbed exact-tip cold clone:
  `tools/verify/cold_clone.sh --keep verify-E2-T01` cloned `839a4c8` into
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.c9axp8OTwz/repo`, reused
  151/151 packages with zero downloads, passed 249/249 tests and the exact target with
  all six mutations, and reported no skips. Scope transcript proves only the authorized
  task/root/E1-derived paths plus the human-approved project lifecycle reason changed.
- Replay: N/A (pure TypeScript guard/reducer and repository provenance-verifier work; no
  browser-reaching surface) + mitigation: committed hostile event bytes and CLI logs,
  three frozen state digests, exact bisect offset `0000000000000000_0000000000000006`,
  byte-exact provenance derivation, six disposable-clone mutations, full inherited
  verification, and the scrubbed exact-tip cold clone.

### 2026-07-15 — judge round 3 — VERDICT: refuted

- **Exact-eight-type runtime guard failed.** At exact submission `af5d0f85`, predicted
  every unknown event type would return boolean `false` and raise
  `identity/unknown-type`. Independently observed `toString` and `constructor` accepted
  through the ordinary-object validator registry and reducing to `undefined`, while
  `valueOf`, `hasOwnProperty`, and `__proto__` threw raw `TypeError`s. Control
  `identity.unknown` behaved correctly. Citation:
  `packages/identity/src/events.ts:270-305`, `packages/identity/src/reducer.ts:22-186`,
  and `work/e2-t01-r3-judge/RESULTS.md`.
- **Downstream provenance sensor failed sensitivity.** A harmless unauthorized edit to
  `tools/verify/e1_capstone_external.mjs`, which belongs to E1's provenance closure,
  survived both the promoted sensor and permitted `make verify-E2-T01`; the exact target
  still passed 17/17 files and 249/249 tests. The hand-maintained two-verifier allowlist
  omits five E1 verifier inputs, parsed structural comparison admits duplicate/shadowed
  artifact bytes, and `git diff --name-only` misses untracked evidence. Citations:
  `packages/identity/scripts/verify-provenance-refresh.mjs:15,34-91`,
  `tools/verify/e1_capstone.mjs:231-237`, and
  `work/e2-t01-r3-provenance/RESULTS.md`.
- **Reconciliation.** The environment critic genuinely passed `verify-all` and an
  exact-tip scrubbed cold clone with no skips, proving reproducibility but not the two
  hostile boundaries above. Identity-map round-two regressions remain intact; these are
  distinct uncovered boundaries. Replay: N/A (pure TypeScript/provenance surfaces) +
  mitigation: exact-tip API probe, full-target verifier sabotage, critic/skeptic source
  audit, repo-wide gates, and cold clone.
- **Retry policy.** This verdict follows the initial implementation plus two reworks.
  The E2-T01 retry budget is exhausted; per `.eforest/loop.md`, the orchestrator must
  halt at `invalid_loop` rather than start another rework or advance to E2-T02.

### 2026-07-15 — builder — round 3 provenance rework submitted

- Implementation commit: `c89cfbca52d1d100d9c56fde8b2f818642371a18`. Human-approved
  downstream invalidation was performed only through
  `tools/verify/e1_capstone.mjs --update-evidence`; it refreshed exactly E1-T11's
  `evidence/transport-provenance.json` and derived `evidence-manifest.json`. No E1
  implementation or verifier changed.
- The promoted `packages/identity/scripts/verify-provenance-refresh.mjs` sensor compares
  against scope base `4b70c57`, independently re-hashes the current root inputs, and
  proves that only `Makefile`, `package.json`, and `pnpm-lock.yaml` changed inside the
  E1 provenance file, only its digest changed inside the manifest, and only the two
  approved files changed anywhere in E1-T11 evidence. Its manifest provenance digest is
  `8efbbafa9311ceab7747a136134c940dae6d135602a255461c58210dbd2d3c74`.
- Ordered gates were restarted from formatting after the sandbox-only listener refusal:
  `pnpm format:check && pnpm lint`, `pnpm typecheck`, permitted `pnpm test` (17 files,
  249/249), and `pnpm build` all passed. The refusal was `listen EPERM` before a server
  could start; the unchanged suite passed under required local-server permission.
- Exact committed target: `make verify-E2-T01` passed at `c89cfbc` with 249/249 tests,
  frozen identity digests `00d247...cc99`, `064121...f16`, and `5b2e66...b9`, grant
  mutation bisected at offset `0000000000000000_0000000000000006`, zero skips, and the
  exact two-artifact provenance proof.
- Repository-wide regression: `make verify-all` passed every E0, E1, and E2-T01 target.
  In particular, the previously failing E1-T11 capstone now accepted the refreshed
  provenance, its 17-event replay/materialization remained at
  `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`, and all nine
  E1 sabotage sensors still failed at their intended boundaries.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from exact tip
  `c89cfbca52d1d100d9c56fde8b2f818642371a18` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.AZAh1SQvEX/repo`; the scrubbed
  install reused 151 packages, downloaded zero, passed 249/249 tests, emitted the exact
  provenance sets above, and reported no skipped verification.
- Identity semantics remain those independently survived in round 2: generalized own-key
  lookup, three frozen digests, 17 committed guard inputs, 26 corrupt logs, retained
  revocations, Unicode queries, revoked-hash reuse, full byte sensitivity, and seeded
  ordering properties. `evidence/scope-transcript.txt` records the expanded exact
  allowlist and zero database/server/client/protocol/streamfs implementation changes.
- Replay: N/A (pure TypeScript package with no browser-reaching surface) + mitigation:
  identity stream logs/digests, exact replay/bisect, generalized mutation-sensitive
  tests, current-byte E1 provenance, `verify-all`, exact target, and a pristine clone.

### 2026-07-15 — builder — round 3 rework started

- Human approval was received for the judge's exact downstream-provenance invalidation
  rule: E2-T01 may regenerate only E1-T11's derived
  `evidence/transport-provenance.json` and `evidence/evidence-manifest.json` through the
  existing `tools/verify/e1_capstone.mjs --update-evidence` authoring path.
- E1-T11's provenance inputs, verifier, comparison sensor, and sabotage checks remain
  unchanged. The rework must prove the two refreshed artifacts are the only additional
  paths outside E2's original allowlist, then re-earn the ordered gates, `verify-all`,
  exact `verify-E2-T01`, and a scrubbed cold clone before resubmission.
- Replay: N/A (pure TypeScript package with no browser-reaching surface) + mitigation:
  exact SHA-256 provenance regeneration, inherited E1 runtime checks, identity stream
  goldens, full repository gates, and a pristine clone.

### 2026-07-15 — judge round 2 — VERDICT: refuted

- **Inherited E1-T11 provenance makes `verify-all` red — FAILED.** Predicted the exact
  submission `af22c2ddc1e72c4879af636e2f3f2334ae9e23af` would preserve every frozen
  predecessor target. A fresh `make verify-all` passed 249/249 full tests, 109/109
  focused E1 tests, every E0 target, E1-T10, and the E1-T11 runtime scenario, then exited
  2 at `_v-e1-t11-capstone`: `fresh capstone evidence drifted:
transport-provenance.json`. E1 intentionally hashes `Makefile`, `package.json`, and
  `pnpm-lock.yaml`; E2 legitimately changes all three. Current hashes are
  `38d221d7...8312c`, `25919424...3baa`, and `3beb8add...56b9`, while the frozen E1
  artifact carries `93cbe929...0ac`, `f0d0b69b...302`, and `1964d6f6...e671`.
  Citations: `tools/verify/e1_capstone.mjs:211-242,894-904` and
  `work/e2-t01-r2-coverage/RESULTS.md`.
- **The two binding acceptance rules currently have no honest in-scope resolution.**
  E2 requires the new root integration but permits no changes outside
  `packages/identity`, those root files, and this E2 task folder (`readme.md:286-301`).
  Preserving E1's verified executed-runtime sensor requires regenerating its provenance
  and derived manifest, outside that allowlist. Reverting E2 integration violates its
  deliverables; narrowing E1 provenance weakens a verified sensor; silently rewriting
  E2's own scope would self-waive the failed gate. Demand: obtain an explicit
  human-approved downstream-provenance invalidation rule, narrowly authorize regeneration
  of the affected E1 evidence through its existing `--update-evidence` path, then rerun
  the full gauntlet, exact target, `verify-all`, and scrubbed cold clone. Do not delete or
  narrow the E1 sensor.
- **Surviving evidence.** Fresh critics verified generalized own-entry semantics,
  independent parity for all three frozen digests, revoked-hash reuse, Unicode lookup,
  5,000 hostile interleavings plus 5,000 lifted preconditions, 26/26 corrupt committed
  logs, 922 grant-payload mutations with no green-equal mutant, five exact bisects, both
  permanent sabotages, and the exact target at 249/249. The refutation is the sole
  repository-level integration gate, not an identity semantic regression. Citations:
  `work/e2-t01-r2-correctness/RESULTS.md`,
  `work/e2-t01-r2-coverage/RESULTS.md`, and
  `work/e2-t01-r2-behavior/RESULTS.md`.
- Replay: N/A (pure TypeScript package with no browser-reaching surface) + mitigation:
  fresh full-repository execution, exact current/frozen SHA-256 comparisons, hostile
  stream histories, mutations, bisects, independent folds, and the three critic reports.

### 2026-07-15 — builder — round 2 rework submitted

- Rework implementation commit: `bf4c4ba6b49defc3ce8ddbc2fc43e77d0082cf9f`.
  The fix is one own-entry abstraction (`packages/identity/src/records.ts`) used by every
  reducer and direct query lookup; it does not reserve or special-case individual keys.
  The independent test oracle now defines and reads own entries safely as well.
- Promoted the refutation into permanent evidence: `evidence/prototype-keys.jsonl`
  replays valid `__proto__`, `constructor`, and `toString` identities across users, orgs,
  memberships, grants, sessions, and queries to digest
  `064121fb63caa5e352ee9474ce9386d28a8a4febe002c2e4d3d0310ee4571f16`;
  nine prototype-key corrupt histories prove duplicate and unknown-reference refusals.
  Empty-view queries explicitly reject inherited values while the resulting maps retain
  ordinary `Object.prototype` and own data properties.
- Replaced the metadata-only refusal apparatus with committed bytes: all 17 guard inputs
  now live in `evidence/fuzz/guard-refusals.json`, and 26 independently replayable dumps
  live under `evidence/fuzz/corrupt/`; the matrix invokes the CLI against those exact
  files and asserts the expected code and 1-based line.
- Retention is now observed before re-grant: the exact revoked membership record is
  asserted and frozen at prefix digest
  `5b2e66bee06ecd33945973686eac99aba21f2a5d65ad01840a480ca517ee56b9`.
  Generated valid histories also include terminal revocations. The suite additionally
  proves revoked-hash reuse selects exactly the new active grant and resolves the second
  Unicode golden user through `userForSub`.
- Re-earned the gauntlet from the top: `pnpm format:check && pnpm lint`,
  `pnpm typecheck`, `pnpm test` (17 files / 249 tests), and `pnpm build` all passed.
  `make verify-E2-T01` passed at exact committed tip with zero skips, the original frozen
  digest `00d247...cc99`, the two new frozen digests above, and the original grant mutation
  bisected at offset `0000000000000000_0000000000000006`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from exact commit
  `bf4c4ba6b49defc3ce8ddbc2fc43e77d0082cf9f` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.ELcExDL50x/repo`, with 151
  packages reused, zero downloaded, 249/249 tests, and no skipped verification.
- Replay: N/A (pure TypeScript event/reducer/query package with no browser-reachable
  surface) + mitigation: three frozen stream digests, exact CLI corrupt-log diagnostics,
  own-key positive/negative fixtures, full grant-byte sensitivity and bisect, independent
  oracle/property folds, exact Make target, and a scrubbed pristine cold clone.

### 2026-07-15 — judge — VERDICT: refuted

- **Schema-valid opaque identifiers are not safe — FAILED.** Predicted that the first
  `identity.user.created` event for `sub: "toString"` would fold because the frozen
  schema accepts that opaque NFC subject and reserves no property names. Observed the
  runtime guard accept it, but CLI replay reject line 1 as
  `identity/duplicate-user`; `userForSub(emptyView(), "toString")` also returns the
  inherited `Object.prototype.toString` function rather than `null`. The fresh judge
  reproduced the correctness critic's counterexample with
  `node ../e2-t01-correctness/hostile.mjs` at submitted tip `2e29add`: output was
  `PROTOTYPE user guard=true rc=1` and
  `PROTOTYPE empty-user-query type=function value-is-null=false`. Citations:
  `packages/identity/src/view.ts:43-45`, `packages/identity/src/reducer.ts:24-30`,
  `packages/identity/src/queries.ts:13-15`, and
  `work/e2-t01-correctness/RESULTS.md`. Demand: use own-property-safe identity maps and
  lookups (including nested memberships), prove valid `toString`, `constructor`, and
  `__proto__` identifiers across every opaque-id class, and rerun the complete builder
  gauntlet and cold clone.
- **Revoked-membership retention is not mutation-sensitive — FAILED.** Predicted that
  replacing the required retained `{ role, status: "revoked" }` transition with a
  clone-and-delete transition would turn the committed focused suite or frozen verifier
  red. The coverage critic and an independent skeptic both observed the mutation stay
  green: 2 files / 10 tests passed and the verifier returned the unchanged
  `00d247...cc99` digest. Golden line 5 is immediately overwritten by re-grant on line
  6, while `packages/identity/test/identity.test.ts:251-252` observes only the query's
  `null`, not the retained record. Citations:
  `work/e2-t01-coverage/RESULTS.md` and
  `work/e2-t01-coverage-skeptic/RESULTS.md`. Demand: assert the exact retained prefix
  state and digest, add a terminal-revocation history, and promote delete-on-revoke as a
  permanent negative control.
- **The committed refusal corpus is metadata, not replayable evidence — FAILED.**
  Predicted `evidence/fuzz/` would contain the hostile guard bytes and one self-contained
  JSONL dump per reducer precondition. Observed only `guard-refusals.json` and
  `corrupt-logs.json`, containing names/expected diagnostics but no input event bytes;
  the actual inputs are synthesized in
  `packages/identity/test/identity.test.ts:85-175` and written only to a temporary
  directory at lines 268-286. The coverage skeptic independently upheld this against the
  explicit corpus deliverable. Demand: commit the actual guard inputs and corrupt JSONL
  dumps with expected code/line metadata, and make the tests consume those committed
  bytes directly.
- **Two frozen branches remain unpromoted — NEEDS-EVIDENCE.** External hostile behavior
  proved revoked-hash reuse currently works, but no committed test covers
  issue -> revoke -> different grant with the same hash; add that positive history beside
  the active-duplicate refusal and assert singular query selection. Acceptance also
  requires both golden users through `userForSub`, but the committed golden-specific test
  covers Alice and unknown only; assert the exact Unicode `auth0|björn` result. Citations:
  `packages/identity/test/identity.test.ts:243-265`,
  `work/e2-t01-coverage/RESULTS.md`, and
  `work/e2-t01-coverage-skeptic/RESULTS.md`.
- **Reconciliation.** The behavior critic verified grant-byte sensitivity (406/406),
  hostile authorization semantics, 3,000 own-seed interleavings, 3,000 lifted
  preconditions, and four identity-specific sabotage checks. The independent golden
  digest also matched and digest deletion failed loudly. Those successes survive as
  useful evidence, but they do not answer the valid-identifier implementation failure or
  the upheld retention/corpus sufficiency failures. No no-fire-list finding was used.
- Replay: N/A (pure TypeScript library with no browser-reaching surface) + mitigation:
  independent CLI hostile replay, exact digest derivation, committed stream evidence,
  focused sabotage, and the critic/skeptic reports above. Status returns to
  `in-progress`; the builder must rework and re-record before another fresh verification
  round.

### 2026-07-15 — builder — implementation submitted

- Implementation commit: `484508b31cd5c3bf7b8a52516c1cb4fe8759f582` on
  `codex/e2-t01-identity-event-model`, stacked on the verified E1-T11 tip. The frozen
  authorization-view digest is
  `00d247cbbbd8cec0015400ed153eae50ed64fa58f7d1d9c8313eb50175b2cc99`.
- Workspace gauntlet, restarted from formatting after every failure:
  `pnpm format:check && pnpm lint` (green), `pnpm typecheck` (green), `pnpm test`
  (17 files, 247 tests), and `pnpm build` (green). The full suite includes all 52
  dependency-closure merge regressions carried forward from E1-T10.
- Exact target: `make verify-E2-T01` passed at the committed implementation tip with
  no `SKIPPED:` lines. It replayed the identity golden in separate CLI processes,
  matched the committed digest through CLI/protocol/direct folds, ran the exhaustive
  full-log and grant-payload byte sweeps, and printed
  `MUTATION fixture=golden-identity byte=1138 digest-mismatch
bisect=0000000000000000_0000000000000006 EXPECTED-FAIL OK`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from exact commit
  `484508b31cd5c3bf7b8a52516c1cb4fe8759f582` with scrubbed Node/npm/Rust environment at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.eENnJyzAR3/repo`; dependency
  installation was lockfile-clean with 151 packages reused and zero downloaded.
- Evidence: `evidence/golden-identity.jsonl` and `.digest` are the frozen stream layer;
  `evidence/verification-summary.json`, `differential-transcript.txt`,
  `purity-transcript.txt`, `ordering-property-transcript.txt`, and
  `scope-transcript.txt` pin the independent processes, 500/500/500 property counts,
  purity scan, and implementation allowlist. The scope base is the lifecycle-only
  builder-start commit `4b70c57`; implementation has no hunk under server, client,
  protocol, or streamfs and the database dependency scan has zero matches.
- Claim: the eight exact v1 identity event schemas now reduce deterministically to the
  documented authorization view; replay rejects every frozen corrupt-history invariant
  at its offending line, retains revoked/ended audit state, and answers the four pure
  authorization queries. Every grant payload byte is either rejected or state-reaching,
  and the CLI, protocol replay, direct reducer fold, and independent oracle agree on the
  frozen digest.
- Replay: N/A (pure TypeScript protocol/reducer/query package with no browser-reachable
  surface) + mitigation: committed event log/digest, CLI replay and bisect, exhaustive
  byte sensitivity, independent oracle folds, seeded ordering properties, exact target,
  and a pristine scrubbed cold clone.

### 2026-07-15 — builder start

- Selected as the highest-priority eligible task after E1-T11 was independently verified
  at `f201e192bb587a49abb82b3cbd8d5f2e59eda9e6` and published as stacked PR #26.
- Builder branch: `codex/e2-t01-identity-event-model`, stacked directly on the verified
  E1-T11 tip.
- Planned proof: freeze the eight-event identity envelope, reducer invariants, canonical
  authorization view and four query helpers in a pure package; prove CLI/in-process
  differential replay, golden immutability, exhaustive byte sensitivity with bisect
  pinning, seeded ordering properties, corrupt-log diagnostics, purity, and the no-server/
  no-database scope from exact-tip gates and a scrubbed cold clone.
- Replay: N/A (E2-T01 is a pure TypeScript library with no browser-reachable surface) +
  mitigation: committed identity logs/digest, CLI replay and bisect output, independent
  folds, property transcripts, mutation-sensitive tests, exact target gates, and a
  pristine cold clone.
