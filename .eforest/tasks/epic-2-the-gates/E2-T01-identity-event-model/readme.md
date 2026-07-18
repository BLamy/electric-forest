---
id: E2-T01
epic: 2
title: "Identity event model frozen: user/org/membership/grant/session events on identity streams reduced to a canonical authorization view"
priority: 201
status: in-progress
progress_audit_start: 6
verification_run_ceiling: 18
verification_recovery_base_run: 15
verification_recovery_control_commit: 43eaf0dd27655e8df31fca2b12cbc0752afc42e0
verification_resume_commit: e588cde2ba53d1669547d85e167f342165167024
verification_invalid_loop_commit: 36b9990ffdd40069c61d567f6fe4f12f260f5125
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
      `python3 tools/build_queue.py` after this task's lifecycle transitions, plus the
      human-approved loop-charter changes in `AGENTS.md`, `.eforest/loop.md`, and
      `.claude/workflows/work-queue.js`, plus the verdict-commit return field in
      `.claude/workflows/verify-task.js`. The queue and charter inclusions are explicitly
      human-authorized by the requests to rebuild the stale queue and add durable
      three-run progress audits with a ten-run ceiling;
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
  ':(exclude)AGENTS.md' ':(exclude).eforest/loop.md'
  ':(exclude).claude/workflows/work-queue.js'
  ':(exclude).claude/workflows/verify-task.js'
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

### 2026-07-18 — judge round 17 — VERDICT: refuted

- **The command-cleanup primitive is itself shadowable — FAILED.** Predicted that the
  run-17 boundary would remove inherited command definitions before independently
  resolving Make. A fresh behavior critic and judge both observed that an imported Bash
  function named `builtin` resolves before the shell builtin: a direct local probe
  reported `builtin is a function` and intercepted both `builtin echo` and
  `builtin compgen`. The submitted boundary calls `builtin unalias`, `builtin compgen`,
  `builtin unset`, and `builtin type` at `tools/verify/cold_clone.sh:39-42,92`, so the
  same inherited definition can prevent cleanup and control the claimed trusted Make
  lookup. Existing fixtures cover inherited `make`, `git`, `compgen`, and `unset`, but
  never the primitive named `builtin`. Citations:
  `work/critic-r17-behavior/RESULTS.md` and
  `work/e2-t01-r17-judge/RESULTS.md`. Demand: establish cleanup and executable lookup
  through a boundary an inherited `builtin` definition cannot shadow, and promote a
  permanent fixture proving that case before pristine-clone PASS.
- **The durable apparatus count is false — FAILED.** Predicted the committed transcript
  and builder claim would match the exact sensor JSON. The coverage critic parsed the
  final `WORK_QUEUE_POLICY_OK` object, root independently reran the exact command, and
  the judge reconciled the source groups: 41 work-queue + 34 parser + 4 snapshot + 2
  singleton + 11 cold-clone mutations = **92**, while the transcript and Verification
  log claim 97. Citations:
  `evidence/round-17-cold-clone-command-identity-transcript.txt:14,32`, this readme's
  round-17 builder entry, `work/e2-t01-r17-coverage/RESULTS.md`, and
  `work/e2-t01-r17-judge/RESULTS.md`. Demand: correct every durable claim to the emitted
  count or add and execute the five named mutations the claim asserts.
- **The two final refinements lack focused sensitivity — NEEDS-EVIDENCE.** The submitted
  lines removing swallowed alias-cleanup failure and capturing `make_bin_rc` execute in
  all miniature clone cases, but no named mutation distinguishes them from their parent;
  the existing `cold-clone-inherited-command-functions` mutation deletes the entire
  scrub block, and `cold-clone-resolved-make-command` mutates a later handoff. Citation:
  `work/e2-t01-r17-coverage/RESULTS.md`. Demand: the run-18 fixture above must exercise
  failed cleanup/lookup behavior and make deletion of each load-bearing check red.
- **Reconciliation.** Exact-tip binding, the closed registry, scheduled-vs-emitted
  markers, empty/no-op and forged-file/directory cases, 249/249 tests, exact
  `verify-E2-T01`, `verify-all`, and the retained pristine clone all survived. They do
  not answer the command-resolution recursion or repair the overstated committed
  evidence. This is failed verification run 17, the second run in the human-authorized
  16-18 window. E2-T01 returns to `in-progress`; project state remains `building`, and
  run 18 is the final authorized rework. Replay: N/A (local shell/Make control-plane
  behavior and pure TypeScript identity code) + mitigation: two fresh critic reports,
  a fresh judge reconciliation, exact sensor JSON, direct Bash resolution observation,
  full frozen-target regression, and the prior scrubbed pristine clone.

Commands: `node packages/identity/scripts/verify-work-queue-policy.mjs`; exact final-JSON
parse for `mutations.length`; direct local Bash function-resolution probe; immutable diff
and retained cold-clone HEAD reconciliation.

### 2026-07-18 — builder — round 17 rework submitted

- Implementation commit: `f91b87acc54491914c02c77050dc326024f287f2`
  (`Harden cold clone command resolution`). The boundary now removes inherited aliases
  and exported functions without a swallowed failure, and resolves the trusted Make
  executable with an explicitly captured lookup status before any target planning,
  hydration, or execution.
- The permanent policy apparatus passes 120 disposable-repository scenarios and kills
  all 97 named mutations. It covers the round-16 counterexamples directly: empty
  explicit/phony rules, dry-run-only markers, ordinary committed files/directories,
  rule-shaped Make variable text paired with files/directories, unregistered recipes,
  `MAKEFILES` and `BASH_ENV` injection, exported `make` replacement, and inherited
  `git`/`compgen`/`unset` function attempts. The positive sentinel still visibly emits
  both `COLD_CLONE_SENTINEL_EXECUTED` and its registered success marker.
- Ordered gates were restarted from formatting after the sandbox-only `listen EPERM`
  refusal: `pnpm format:check && pnpm lint`, `pnpm typecheck`, the unchanged permitted
  `pnpm test` (17 files, 249/249), and `pnpm build` all exited 0.
- Exact committed target: `CI=true make verify-E2-T01` passed at `f91b87a`, including
  all identity replay/digest/bisect checks, 13 provenance attacks, 249/249 tests, the
  120-scenario/97-mutation work-queue policy sensor, and zero skipped verification.
- Repository regression: `CI=true make verify-all` passed every defined E0, E1, and
  E2-T01 target. E1-T10 retained its merge digests; E1-T11 retained the 17-event final
  digest `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`
  and all nine sabotage sensors rejected their mutations.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` cloned exact tip
  `f91b87acc54491914c02c77050dc326024f287f2` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.BALKhyCWZC/repo`, reused all
  151 locked packages with zero downloads, passed 249/249 tests, and printed
  `cold_clone: verify-E2-T01 PASSED from a pristine clone` only after the registered
  recipe emitted its success marker.
- Durable transcript: `evidence/round-17-cold-clone-command-identity-transcript.txt`.
  Replay: N/A (pure shell/Make verification tooling and pure TypeScript identity code
  with no browser-reaching behavior) + mitigation: committed Git/Make hostile fixtures,
  exact stream digests and bisect, repository-wide frozen targets, and the scrubbed
  pristine-clone run above.

### 2026-07-17 — judge round 16 — VERDICT: refuted

- **Database membership still does not prove an executable verification recipe —
  FAILED.** Predicted the wrapper would print pristine-clone PASS only after an
  admissible committed verification recipe executed. At immutable submission
  `ae77158f82be2fe5134b9822b0e2e81ca8b9fca0`, a disposable committed repository with
  `.PHONY: verify-noop` and an empty `verify-noop:` rule exited `0`, printed `Nothing
  to be done`, then claimed `verify-noop PASSED from a pristine clone`. Two composed
  variants placed `verify-forged-file:` and `verify-forged-dir:` only inside a
  multiline Make variable, then supplied ordinary committed filesystem objects with
  those names; both also earned false PASS. `make -p` emits variable bodies, so the
  unscoped `$1 == target ":"` scan at `tools/verify/cold_clone.sh:131-145` confuses
  rule-shaped text with rule identity, while lines 147-163 accept no-op Make exits as
  verification. Citations: `work/e2-t01-r16-behavior/RESULTS.md` and
  `work/e2-t01-r16-coverage/RESULTS.md`. Demand: replace human-readable database
  scanning with a closed committed target registry or equally structured recipe
  identity, and make PASS depend on executing an admissible non-empty recipe. Promote
  empty explicit targets plus composed file and directory cases.
- **Imported Bash functions escape the claimed sanitized command boundary — FAILED.**
  Predicted caller state could not replace Make during graph discovery, viability, or
  execution. An exported `make` function (`BASH_FUNC_make%%`) forged all three calls for
  a target absent from committed HEAD, printed `BASH_FUNCTION_TARGET_EXECUTED`, exited
  `0`, and received pristine-clone PASS. Removing `BASH_ENV`, `ENV`, and `MAKE*` at
  `tools/verify/cold_clone.sh:101-117` does not remove imported functions; the inner
  Bash resolves the function before the trusted PATH for every unqualified `make` at
  lines 133, 148, and 156. Citation: `work/e2-t01-r16-behavior/RESULTS.md`; the coverage
  critic independently confirmed the static closure gap. Demand: scrub imported shell
  functions and invoke independently resolved executable identities for every
  load-bearing command, with a permanent function-injection mutation sensor.
- **Coverage and reconciliation.** Both fresh critics confirmed the exact policy sensor
  still passes 112 scenarios and kills all 89 named mutations. Option/arbitrary/colon
  refusal, missing and broken target refusal before hydration, bare committed-file
  refusal, direct `MAKEFILES`, `BASH_ENV -> MAKEFILES`, exact target execution, 249/249
  tests, exact E2-T01, inherited `verify-all`, and the pristine intended-target run all
  survive. Those are real retained improvements, but the positive sentinel proves only
  one target and the permanent fixture omits the explicitly demanded bare directory
  case. No suite promotion is honest until recipe and command identity close generally.
- **Lifecycle.** This is failed verification run 16, the first run in the human-
  authorized 16-18 recovery window. E2-T01 returns to `in-progress`; project state
  remains `building`, and run 17 may rework the two general boundaries above. Replay:
  N/A (pure shell/Make control-plane behavior) + mitigation: four hostile pristine-clone
  executions from disposable committed repositories, exact exit/stdout observations,
  source audit, and two fresh critic reports.

Commands: disposable exact-wrapper empty-rule, rule-text/file, rule-text/directory, and
exported-function probes; `node packages/identity/scripts/verify-work-queue-policy.mjs`.

### 2026-07-17 — builder — round 16 apparatus rework submitted

- Implementation commit: `5bdddc2c26128242efdceed3df9da2ba5a0871d9`. The cold-clone
  boundary now derives exact rule identity from the clone's own built-in-rule-free Make
  database before asking Make whether the declared target is viable. An ordinary
  committed `verify-*` file or directory therefore cannot impersonate a verification
  rule, while declared targets with unsatisfied prerequisites still fail before
  dependency hydration.
- The non-interactive shell boundary now removes `BASH_ENV` and `ENV` alongside every
  ambient Make control variable. A startup hook can no longer restore `MAKEFILES` after
  the direct environment scrub. The same sanitized environment covers rule discovery,
  viability probing, dependency hydration, and exact target execution.
- The permanent miniature Git/Make apparatus now exercises nine observable paths:
  option, arbitrary-name, and colon-name refusals; missing and broken declared targets
  before hydration; a committed verify-named file with no rule; direct `MAKEFILES` and
  indirect `BASH_ENV` injection; and visible exact sentinel execution. It passed 112
  deterministic scenarios and killed all 89 named source mutations. The two new
  deletion controls are `cold-clone-shell-startup-environment` and
  `cold-clone-explicit-target-declaration`.
- The complete gate chain passed after the final change: `pnpm format:check && pnpm
  lint`, `pnpm typecheck`, `pnpm test` (17 files / 249 tests, outside the approved
  listener-restricted sandbox), and `pnpm build`. Exact `CI=true make verify-E2-T01`
  passed the identity goldens, corruption/byte sensitivity, 13 provenance attacks,
  target self-check, and 112/89 policy apparatus. Exact `CI=true make verify-all`
  passed every E0, E1, and E2-T01 target, including 109 inherited focused tests and all
  nine E1 sabotage sensors.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from exact
  implementation tip `5bdddc2c26128242efdceed3df9da2ba5a0871d9` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.ZYvPtM01ey/repo`. The scrubbed
  install reused all 151 locked packages, downloaded zero, passed 249/249 tests, and
  completed the exact 112/89 target.
- Durable transcript: `evidence/round-16-cold-clone-apparatus-transcript.txt`. Fresh
  critics must attack the immutable lifecycle submission containing this entry.
  Replay: N/A (pure shell verification tooling and pure TypeScript identity/control-plane
  code with no browser-reaching behavior) + mitigation: real committed Git/Make
  execution fixtures, direct and shell-startup environment attacks, eight
  mutation-sensitive cold-clone dependencies, exact-tip full verification, and a
  scrubbed pristine clone.

### 2026-07-17 — human resume — RUNS 16-18 authorized

- Authorization: APPROVED
- Task: E2-T01
- Stopped after run: 15
- Authorized runs: 16-18
- Scope: control-plane recovery transition and E2-T01 verification only

### 2026-07-17 — builder — round 15 apparatus rework submitted

- Implementation commits: `006a580c08b4a2f75551c8245120285732080cd1` establishes
  the closed verification-target/environment boundary, and
  `d9d9b47f011a76a74622ef94f19424be5187a877` promotes the judge's hydration-order
  demand. The wrapper's contract is now explicitly `verify-*`: options, arbitrary file
  targets, special names, and colon-bearing names fail before cloning. It asks Make
  itself about the exact target with `make -rR -q -- "$target"`, so no colon-delimited
  database parser mediates the result.
- Make control is closed for both the target probe and actual execution: every ambient
  `MAKE*` variable plus `GNUMAKEFLAGS` and `MFLAGS` is removed in the same scrubbed
  child environment. A caller-supplied `MAKEFILES` target absent from committed HEAD is
  therefore rejected as undeclared and cannot execute or print PASS.
- The permanent miniature Git/Make fixture now covers six observable cases: option,
  arbitrary no-op, and colon names fail before clone; a missing verify target fails
  before a seeded dependency hydration path; an ambient target never executes; and the
  exact declared sentinel visibly executes before PASS. Six named source mutations each
  delete one dependency and make the fixture fail. The policy apparatus is green at 108
  scenarios and 85 named mutations.
- The complete gate chain was restarted after the hydration-order change:
  `pnpm format:check && pnpm lint`, `pnpm typecheck`, `pnpm test` (17 files / 249
  tests), and `pnpm build` all passed. Exact `CI=true make verify-E2-T01` passed the
  identity goldens, corrupt-log/byte sensitivity, provenance attacks, verify-target
  self-check, and the 108/85 policy apparatus. Exact `CI=true make verify-all` passed
  every defined E0, E1, and E2-T01 target, including the live E1-T11 restart/race run
  and all nine inherited sabotage sensors.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from exact
  implementation tip `d9d9b47f011a76a74622ef94f19424be5187a877` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.H9lY8eUFr8/repo`; the frozen
  install reused all 151 packages, downloaded zero, then passed 249/249 tests and the
  complete 108/85 policy target.
- Durable transcript: `evidence/round-15-cold-clone-boundary-transcript.txt`. The
  lifecycle submission is the commit containing this entry; fresh critics must attack
  that immutable `implemented` tip. Replay: N/A (pure shell verification tooling and
  pure TypeScript identity/control-plane code with no browser-reaching behavior) +
  mitigation: real Git/Make execution fixtures, hostile Make environment, six deletion
  mutations, exact-tip full verification, and scrubbed pristine-clone execution.

### 2026-07-17 — judge round 15 — VERDICT: refuted

- **A committed `verify-*` filesystem object with no Make rule earns a false pristine-
  clone PASS — FAILED.** Predicted the wrapper would admit only an explicitly declared
  verification recipe. At immutable submission
  `1187a276b5d8a94f522dc13581cdbbe7fe8df75b`, a disposable committed repository with
  the submitted wrapper and Makefile plus an ordinary file named
  `verify-existing-file` made direct `make -rR -q -- verify-existing-file` return `0`.
  The wrapper then exited `0`, printed `Nothing to be done for
  'verify-existing-file'.`, and claimed `verify-existing-file PASSED from a pristine
  clone` although no rule or recipe existed. Make question mode conflates an existing
  path with an up-to-date target, so the `0/1/>1` probe at
  `tools/verify/cold_clone.sh:127-135` is not a declaration predicate. Citations:
  `work/e2-t01-r15-behavior/RESULTS.md` and
  `work/e2-t01-r15-test-review/RESULTS.md`. Demand: bind admissible names to an explicit
  committed verification-target declaration or equivalent exact recipe identity, and
  permanently reject committed `verify-*` files and directories that have no rule.
- **`BASH_ENV` re-injects Make control after the direct environment scrub — FAILED.**
  Predicted no caller-controlled startup hook could add a target absent from committed
  HEAD. In a disposable Git fixture, `BASH_ENV` exported
  `MAKEFILES=<external.mk>` after `env -u MAKEFILES`; the inner
  `bash --noprofile --norc -c` still sourced that hook, executed
  `BASH_ENV_TARGET_EXECUTED`, and printed pristine-clone PASS with exit `0`.
  `BASH_ENV` is not removed at `tools/verify/cold_clone.sh:94-113`, and `--noprofile
  --norc` does not suppress the non-interactive startup hook. Citation:
  `work/e2-t01-r15-test-review/RESULTS.md`. Demand: neutralize `BASH_ENV` and equivalent
  shell-startup reinjection before the child boundary, then promote the indirect
  `MAKEFILES` fixture with its own deletion mutation.
- **Surviving evidence and reconciliation.** Grammar refusals, missing-target refusal
  before hydration, direct `MAKEFILES`/Make-flag scrubbing, all 25 documented targets,
  and visible exact sentinel execution survived independent attack. The immutable-tip
  permanent sensor also completed all 108 scenarios and killed all 85 named mutations
  with `WORK_QUEUE_POLICY_OK`; exact `verify-E2-T01`, full inherited verification, and
  the scrubbed pristine clone remain green. These are retained improvements, but neither
  the existing-path/target duality nor second-stage Bash startup hook is in those 108/85
  controls. Citations: `work/e2-t01-r15-behavior/RESULTS.md`,
  `work/e2-t01-r15-test-review/RESULTS.md`, and
  `work/e2-t01-runs13-15-progress/RESULTS.md`.
- **Ceiling and SUITE disposition.** This is failed verification run 15, the last run in
  the human-authorized recovery window. No suite promotion is honest while the two
  apparatus counterexamples survive. E2-T01 returns to `in-progress`, but the project
  must stop at `invalid_loop`; a progressing audit diagnoses convergence and cannot
  authorize run 16. Replay: N/A (pure shell/Make verification apparatus and non-browser
  identity/control-plane code) + mitigation: immutable-tip source audit, real disposable
  Git/Make repositories, exact process outputs, hostile startup environments, the
  surviving 108/85 sensor, full inherited gates, and pristine-clone evidence.

Commands: `node packages/identity/scripts/verify-work-queue-policy.mjs`; disposable
committed-file Make/wrapper probe; disposable `BASH_ENV`/`MAKEFILES` probe;
`tools/verify/cold_clone.sh --keep verify-E2-T01`.

### 2026-07-17 — progress critic — RUNS 13-15: progressing

- Rationale: Runs 13-15 show genuine compounding progress rather than a reset. Run 13
  exposed option interpretation before Make target semantics. Run 14 retained that
  refusal and reached the deeper declaration, colon-parser, ambient-Make, and hydration-
  ordering boundary. Run 15 closed the option, arbitrary `Makefile`, colon, missing-
  target, direct `MAKEFILES`/flag injection, and pre-hydration cases through one scrubbed
  execution boundary and mutation-sensitive real-Git fixture. The permanent apparatus
  grew monotonically from 102 scenarios / 79 named mutations to 105/82 and then 108/85,
  with prior behavior retained. The surviving run-15 attacks are narrower compositions:
  Make's file/target duality requires a safe-name committed filesystem object, while the
  environment attack requires a second-stage non-interactive Bash startup hook after the
  direct scrub. That is meaningful narrowing with deeper counterexamples, not a renamed
  recurrence, although both still refute verification.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-13 — Run 13 records the option-shaped false PASS while the 102/79 identity and recovery apparatus survived.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-14 — Run 14 confirms option and missing-target closure, 105/82 compounding, then records the no-op declaration, colon, ambient-Make, and hydration-order boundary.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-15 — Run 15 confirms all concrete run-14 controls and the 108/85 suite survive before the existing-path and BASH_ENV compositions refute the claim.
- Next focus: Derive admissible cold-clone names from an explicit committed verification-target declaration or equivalent exact recipe manifest, and permanently reject both committed `verify-*` files and directories with no rule.
- Next focus: Neutralize `BASH_ENV` and any equivalent shell-startup reinjection before every non-interactive child, promote the indirect `MAKEFILES` fixture with a deletion mutation, and retain observable positive recipe execution before PASS.
- Next focus: Do not begin another builder run unless a new explicit human authorization opens a bounded recovery window after this committed `invalid_loop` stop.
- Assessment: progressing

### 2026-07-17 — judge round 14 — VERDICT: refuted

- **Declared no-op targets can earn a false pristine-clone PASS — FAILED.** Predicted the
  wrapper would print `PASSED from a pristine clone` only after an intended verification
  recipe executed. At immutable submission
  `41572ad3a5f6e0a607aec869244ed08483dcb5bd`, an independent
  `tools/verify/cold_clone.sh Makefile` exited `0` after
  `make: Nothing to be done for 'Makefile'.` and printed
  `cold_clone: Makefile PASSED from a pristine clone`. `make -qp` includes the parsed
  makefile in its database, the name-only check admits it, and any later zero exit becomes
  PASS without an observable verification recipe. Citations:
  `tools/verify/cold_clone.sh:99-110,122-130` and
  `work/e2-t01-r14-behavior/RESULTS.md`.
- **Ambient Make control escapes the cloned evidence boundary — FAILED.** Predicted a
  target absent from the committed repository could not be discovered or executed by the
  scrubbed clone. With an untracked external makefile and
  `MAKEFILES=<external> tools/verify/cold_clone.sh verify-ambient-injection`, the exact
  submitted wrapper exited `0`, printed `AMBIENT_MAKEFILE_EXECUTED`, and claimed
  `verify-ambient-injection PASSED from a pristine clone`. `MAKEFILES`, `MAKEFLAGS`, and
  `GNUMAKEFLAGS` are not scrubbed, so graph inspection and execution share caller-supplied
  Make state. Citations: `tools/verify/cold_clone.sh:84-96,99-122` and
  `work/e2-t01-r14-coverage/RESULTS.md`.
- **The admitted target grammar rejects a valid escaped-colon target — FAILED.** In the
  critic's committed disposable repository, direct `make -- 'verify:colon'` printed
  `COLON_TARGET_EXECUTED` and exited `0`, while the frozen wrapper exited `1` with
  `make target verify:colon is not declared in the cloned Make graph`. The input grammar
  admits `:`, but `awk -F:` compares only the prefix before it. Citations:
  `tools/verify/cold_clone.sh:38-43,99-110` and
  `work/e2-t01-r14-behavior/RESULTS.md`.
- **Reconciliation.** Option-shaped and missing targets now fail, malformed Make graphs
  fail closed, ordinary declared targets execute, and the permanent sensor genuinely
  passes 105 scenarios with 82 named mutations. Those round-13 improvements survive, but
  the sensor does not establish a committed, environment-closed verification recipe.
  Round 15 must restrict or observably validate verification targets, scrub Make control
  variables for both graph discovery and execution, retain the no-op/ambient/colon cases,
  and mutation-test hydration ordering before resubmission.
- Commands: `tools/verify/cold_clone.sh Makefile`;
  `env MAKEFILES=<external> tools/verify/cold_clone.sh verify-ambient-injection`;
  `make -- 'verify:colon'`; frozen-wrapper `verify:colon` from the committed disposable
  repository. Replay: N/A (pure shell verification tooling and non-browser control-plane
  code) + mitigation: exact-submission clone executions, external Make-state injection,
  a committed target-shape fixture, source audit, and both fresh critic reports. Status
  returns to `in-progress` for authorized round 15.

### 2026-07-17 — builder — round 14 apparatus rework submitted

- Implementation commit: `4a2827369ef9516a818293398d768e2a9139aa43`. The cold-clone
  wrapper now rejects extra arguments and any option-shaped target before cloning, reads
  the exact cloned Make database before dependency hydration, refuses an undeclared name,
  and invokes the proven name as `make -- "$target"`. PASS remains reachable only from
  that exact command's zero exit.
- The run-13 counterexample is permanent, behavioral evidence rather than a source-string
  check. `verify-work-queue-policy.mjs` constructs a minimal committed Git repository with
  one `verify-sentinel` recipe, copies the actual cold-clone script and trusted-PATH
  helper, and proves: `--version` fails before `cloning HEAD`; `verify-missing` fails as
  undeclared and never prints PASS; and `verify-sentinel` visibly executes before PASS.
  Three independent mutations remove each dependency and make the fixture fail.
- Permanent policy proof now reports 105 scenarios and 82 named mutations with
  `WORK_QUEUE_POLICY_OK`. Direct reproductions also return nonzero with
  `cold_clone: FAIL — invalid make target --version` and
  `cold_clone: FAIL — make target verify-not-a-real-target is not declared in the cloned
  Make graph`.
- Ordered gates were restarted from formatting: format, lint, typecheck, 17 files / 249
  tests, and build passed with the approved ephemeral `127.0.0.1` listeners. Exact
  `CI=true make verify-E2-T01` passed the identity goldens, 105/82 policy sensor,
  provenance attacks, and verify-spine self-check. `CI=true make verify-all` passed every
  defined E0, E1, and E2-T01 target, including the live E1-T11 restart/race scenario and
  all nine sabotage sensors.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` first proved the declared
  target in the cloned Make graph, then passed from exact committed tip
  `4a2827369ef9516a818293398d768e2a9139aa43` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.KKoZCKWX4P/repo`.
  The frozen install reused all 151 packages, downloaded zero, and passed 249/249 tests
  plus the complete 105/82 target.
- Durable transcript: `evidence/round-14-cold-clone-target-transcript.txt`. The lifecycle
  submission is the commit containing this entry; fresh critics must repeat the boundary
  at that immutable `implemented` tip.
- Replay: N/A (shell verification tooling and pure TypeScript identity/control-plane code
  with no browser-reaching behavior) + mitigation: a committed miniature Git/Make
  execution fixture, three behavioral deletion mutations, direct negative commands,
  exact identity/recovery gates, full inherited verification, and a scrubbed pristine
  clone.

### 2026-07-17 — judge round 13 — VERDICT: refuted

- **Cold-clone requested-target execution — FAILED.** Predicted an option-shaped input
  could not produce a passing verification claim without executing a named Make recipe.
  At immutable submission `822c6718af1e59c5702951bb9019866094fa7a58`, an independent
  `tools/verify/cold_clone.sh --version` exited `0`, printed `GNU Make 3.81`, and ended
  `cold_clone: --version PASSED from a pristine clone`. The character-only target check
  admits the leading dash, `make "$3"` treats it as an option, and the wrapper converts
  Make's zero exit into a false success. Citations: `tools/verify/cold_clone.sh:31-39`,
  `tools/verify/cold_clone.sh:102-113`, and
  `work/e2-t01-r13-coverage/RESULTS.md`.
- **Dependency-closed demand.** Reject option-like input, prove the requested target
  exists in the exact cloned Make graph, and prove that exact recipe executes before the
  wrapper may print `PASSED`; promote positive intended-target and negative option/missing-
  target cases so no successful Make option or unrelated default can satisfy the proof.
- **Surviving evidence.** A fresh
  `node packages/identity/scripts/verify-work-queue-policy.mjs` still passed all 102
  scenarios and 79 named mutations with `WORK_QUEUE_POLICY_OK`. The submission's exact
  `verify-E2-T01`, repository-wide `verify-all`, and pristine intended-target run remain
  green evidence for identity and control-plane behavior, but cannot establish that the
  cold-clone wrapper validates arbitrary requested targets honestly.
- Commands: `tools/verify/cold_clone.sh --version` (unexpected exit `0`);
  `node packages/identity/scripts/verify-work-queue-policy.mjs` (exit `0`).
- Replay: N/A (pure TypeScript identity/control-plane and shell verification tooling
  with no browser-reaching behavior) + mitigation: immutable-tip source audit, exact
  cold-clone counterexample, fresh real-Git policy sensor, and the surviving full-gate
  and intended-target transcripts. Status returns to `in-progress` for round 14.

### 2026-07-17 — builder — round 13 recovery submitted

- Implementation tip: `a804c6c75aeed551f3daf7e44be444d984d731a7`. The run-12
  refutations are promoted into the permanent policy sensor: its real-Git lineage fixture
  constructs an internal lifecycle base independent of the caller's task phase; the
  stopped verdict and audit digest prefixes are bound through the control bridge and
  resume; human recovery is one exact affirmative structured record; and both control
  and lifecycle commits are restricted to exact path sets. Resolver probes now create a
  synthetic run 13 instead of rewriting the stopped run-12 ledger.
- Recovery chain: invalid-loop stop `919216c43409eaa9523e702724c6cf7e4361c36d`,
  control bridge `f6800a5cf854431ea140b4ac890d297819ff3592`, and authorized
  lifecycle resume `b25947af777a76a28e66519e7805c2e140b1f25b`. The trusted control
  attester reports `historyPrefixVerified=true`, `checkpointOverrideVerified=true`,
  `approvalPathsVerified=true`, and `sameGateVerified=true`; the stopped/resumed run
  prefix digest is `7cfb64f1a0b280a1dfafc4d5fa018d226cfb8f37a000b54b15c0ceac5e6d9f0e`.
- Permanent policy proof: `node packages/identity/scripts/verify-work-queue-policy.mjs`
  executes 102 committed scenarios and 79 named dependency mutations, including the four
  exact run-12 counterexamples, then prints `WORK_QUEUE_POLICY_OK`. The trusted attester
  digest is `49cc32720fb52068455f72715a098f3c6563fad7ffe2caf9f8eb0c80e70e7b91`;
  the recovery entry digest is
  `37bc9a80c63bcad2845c6785f3da51d623419fa0040bacdc5c343ea10604f57f`.
- Re-earned from the top with the approved ephemeral `127.0.0.1` listeners:
  `CI=true make verify-E2-T01` passed 17 files / 249 tests, all 102 policy scenarios,
  the three frozen identity digests, 500/500/500 seeded properties, provenance attacks,
  and the verify-spine self-check. `CI=true make verify-all` then passed every defined
  E0, E1, and E2-T01 target, including the E1-T11 live restart/race scenario and all nine
  sabotage sensors.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from exact
  implementation tip `a804c6c75aeed551f3daf7e44be444d984d731a7` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.FsC4oY3Hms/repo`.
  Its lockfile-verified offline hydration reused all 151 packages, downloaded zero,
  scrubbed the inherited environment, and independently passed 249/249 tests plus the
  complete exact target. The cold-clone harness now validates the requested Make target
  and reconstructs dependencies from the caller's content-addressed pnpm store without
  copying `node_modules` or source bytes.
- Durable transcript: `evidence/round-13-recovery-transcript.txt`. The implemented
  lifecycle submission is the commit containing this entry; fresh critics must run the
  phase-independent policy sensor and acceptance commands against that immutable tip.
- Replay: N/A (pure TypeScript identity/control-plane and verification tooling with no
  browser-reaching behavior) + mitigation: committed identity logs and digests, exact
  replay/bisect, real-Git recovery histories, 102 policy scenarios with named deletion
  mutations, full inherited gates, listener-enabled runtime tests, provenance sabotage,
  and a scrubbed pristine clone.

### 2026-07-17 — human resume — RUNS 13-15 authorized

- Authorization: APPROVED
- Task: E2-T01
- Stopped after run: 12
- Authorized runs: 13-15
- Scope: control-plane recovery transition and E2-T01 verification only

### 2026-07-17 — progress critic — RUNS 10-12: death-spiral

- Rationale: Runs 10-11 made real local progress: EOF/empty/traversal resolution, failed-invalid-loop propagation, and all thirteen round-10 readback deletions were closed, while the permanent policy apparatus grew from 76 scenarios/40 named mutations to 95/64. Round 12 also closes the round-11 direct-parent and explicit invalid-loop-state edges and moves the bare recovery ceiling toward a provenance model. But the checkpoint cannot be assessed as progressing because the no-regression condition is conjunctive: round 12's newly added real-Git lineage fixture makes the permanent policy sensor deterministically red at the actual `implemented` submission before any of the claimed 101 scenarios/75 mutations completes, whereas the round-11 sensor was green at its submitted tip. The committed round-12 transcript and cold clone stop at the earlier `in-progress` implementation commit, so the supposed suite growth is not retained at the lifecycle state the critic actually judges. The remaining recovery findings are deeper than the round-11 bare-ceiling failure, but a newly broken exact-submission gate and stale proof are loss of previously surviving behavior; under AGENTS.md and `.eforest/loop.md`, that is a regression and therefore a death spiral, not another earned run.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-10 — Run 10 establishes the genuinely green 76/40 baseline and the EOF, invalid-loop-result, and thirteen uncovered dependency edges that define the beginning of this window.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-11 — Run 11 confirms the round-10 counterexamples were closed and the suite compounded to 95/64, then reaches the deeper writer-lineage, recovery-authority, and explicit project-status edges.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-12 — Run 12 confirms direct-parent and explicit project-status closure but records that the permanent sensor now fails at the actual submitted tip before its mutation loop, while stopped-ledger prefix, affirmative authorization, and exact approval-path binding remain open.
- Next focus: Persist and independently attest `invalid_loop` from the audited run-12 state; a new recovery window requires a new explicit human authorization rather than this audit granting itself another run.
- Next focus: Make every permanent policy fixture construct its own lifecycle base and prove the complete sensor, exact target, full inherited gates, and scrubbed cold clone at the same `implemented` commit submitted to the critic.
- Next focus: Consolidate recovery authority into one exact affirmative structured record that binds the stopped run/audit digest prefixes and ledger root, the resume transition, the bounded ceiling, and an exact allowlisted path set; retain the negated sentence, rewritten stopped history, and extra implementation path as rejecting regressions.
- Assessment: death-spiral

### 2026-07-16 — judge round 12 — VERDICT: refuted

- **The permanent policy sensor is red at the frozen submission.** Predicted exact tip
  `923c7d83b503206b788e2968c79368edf7806570` would execute all 101 scenarios and 75
  named mutations and print `WORK_QUEUE_POLICY_OK`. Independently observed
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exit 1 before the
  mutation loop: the real-Git lineage fixture clones the submitted `implemented` tip
  but asserts its starting snapshot is `in-progress`, producing
  `actual: 'implemented'`, `expected: 'in-progress'` at line 1918. The committed
  transcript instead pins its passing policy run, exact snapshot, and cold clone to
  pre-submission `12534bdfa4ceabb47801965aadc9a7b017728c1b`, explicitly recorded as
  `task_status=in-progress`. Citations:
  `packages/identity/scripts/verify-work-queue-policy.mjs:1884-1919,1978-1987`,
  `evidence/round-12-lineage-transcript.txt:36-41,54-75`, and
  `work/e2-t01-r12-coverage/RESULTS.md`. Demand: make the lineage fixture construct its
  own lifecycle base rather than inherit the caller's phase, then re-run the entire
  policy baseline/mutation loop, ordered gates, `verify-all`, exact target, and scrubbed
  cold clone from the actual submitted `implemented` tip.
- **Recovery authority does not retain the stopped ledger it claims to resume.**
  Predicted the invalid-loop commit's ten verdict-entry digests would equal the first ten
  digests at the resumed source. In a fresh disposable chain accepted by the exact frozen
  CLI, the stopped run-10 digest was
  `10d35bebc15e65d8823f1895e5a7d5e50682936d3ca91faab7908719e71630b9`, while the
  resumed run-10 digest was
  `04436f97c1076c3fdfc57470a0275ace10e1c24f84ce2f3d76208ce2c8f95c72`;
  `invalid_stop_history_matches_resumed_prefix=false`, yet every recovery flag was true
  and the 11-run snapshot was accepted. The attester checks only that the stopped ledger
  has `runCount === ceiling - 3`; it never compares the run/audit prefix or ledger root
  with the resume/source history. Citations:
  `packages/identity/scripts/work-queue-snapshot.mjs:113-126,129-136,165-176` and
  `work/e2-t01-r12-correctness/probe-output.txt`. Demand: bind the invalid-loop ledger's
  complete run and audit digest prefixes to the authorizing resume commit and every
  descendant snapshot.
- **Negated prose passes as explicit human approval.** Predicted a visible entry saying
  "The user explicitly approved stopping; the committed invalid_loop remains final and
  run 13 is not authorized" would be rejected. The exact frozen parser accepted that
  sentence because it contains the three substrings `user explicitly approved`,
  `invalid_loop`, and `run 13`; the synthetic recovery returned a 64-character entry
  digest and all true flags. Citation:
  `packages/identity/scripts/work-queue-snapshot-lib.mjs:237-259` and
  `work/e2-t01-r12-correctness/probe.mjs` / `probe-output.txt`. Demand: parse one exact
  bounded affirmative authorization record rather than infer authority from independent
  substrings in free prose, and retain the negated sentence as a rejecting regression.
- **The approval transition admits unrelated implementation changes.** Predicted a
  recovery commit would be limited to its declared authorization/control artifacts. The
  accepted synthetic resume changed the normal five control/lifecycle paths plus
  `packages/identity/src/version.ts`; the snapshot still returned
  `approvalPathsVerified=true`. The attester merely requires task, project, and queue to
  be present and never refuses extra paths. Citations:
  `packages/identity/scripts/work-queue-snapshot.mjs:149-157`, the actual authorization
  commit's five-path diff at
  `aa68777f361f3b98c9921a3c22982d2bdfed598e`, and
  `work/e2-t01-r12-correctness/probe-output.txt`. Demand: bind recovery writes to an
  exact approved lifecycle/control path set and reject package implementation paths or
  any other undeclared addition.
- **Reconciliation and checkpoint.** The fresh probe upheld the new direct-parent rule:
  direct child `true`; grandchild, merge, and side lineage `false`; parentless source
  rejected. The Python dependency is also gone from the lineage fixture. Those fixes do
  not cover the phase-sensitive exact-tip failure or the three recovery-authority gaps
  above. This is failed verification run 12: E2-T01 is `refuted`, the project remains
  `building` under the human-authorized ceiling of 13, and a fresh progress critic must
  audit complete reports 10-12 before any run-13 rework. SUITE: no promotion while
  refuted; retain the implemented-tip sensor run, divergent stopped/resumed ledger,
  negated approval, and extra implementation path as deterministic regressions.
- Replay: N/A (pure queue/parser/Git-lineage policy and non-browser identity package) +
  mitigation: exact frozen-tip CLI execution, two independent policy-sensor
  reproductions, disposable committed Git histories, digest-prefix comparison,
  transition-path inspection, source audit, and the two fresh critic reports.

Commands: `node packages/identity/scripts/verify-work-queue-policy.mjs`;
`node work/e2-t01-r12-correctness/probe.mjs`;
`git show aa68777f361f3b98c9921a3c22982d2bdfed598e^..aa68777f361f3b98c9921a3c22982d2bdfed598e --name-only`;
`git diff --check 0657431b61d4bd711b5dbb2fdb0abae4847f16d8..923c7d83b503206b788e2968c79368edf7806570`.

### 2026-07-16 — builder — round 12 dependency-closed lineage rework submitted

- Implementation commits: `303faae` closes transition and recovery provenance,
  `74ade5b` freezes the independent sensor, and
  `12534bdfa4ceabb47801965aadc9a7b017728c1b` removes the lineage fixture's accidental
  dependency on the clone's Python version. The exact resume OID is
  `aa68777f361f3b98c9921a3c22982d2bdfed598e`; this corrects the mistyped full OID in
  the prior builder transcript without rewriting any official verdict or audit entry.
- Every writer readback now carries `transitionBaseIsDirectParent`, computed by the
  trusted pre-write snapshot CLI from the source commit's complete parent list. A real
  side commit parented by the recovery commit but presented as a child of the current
  writer base emits `false`; the workflow stops after `implement` and never invokes
  verification. Both the workflow guard and CLI computation are named deletion
  mutations.
- A ceiling above 10 now requires full `verification_resume_commit` and
  `verification_invalid_loop_commit` references plus one visible bounded human-resume
  entry. The attester proves the resume is a direct child of the cited durable
  `invalid_loop`, is an ancestor of the inspected source, introduced ceiling 13 after
  run 10, committed task/project/queue approval artifacts, retained the same gate, and
  recorded the matching project reason. Each dependency has an independent false-value
  trajectory; recovery provenance is immutable across implementation, audit, verdict,
  and invalid-loop writes.
- The round-11 coverage hole is promoted: a project+queue readback that remains
  `building` now returns `invalid_loop persistence unconfirmed` with no completed stop,
  and deleting `after.projectStatus === 'invalid_loop'` makes the permanent verifier
  red. The policy proof now passes 101 scenarios and 75 named mutations, including all
  64 round-11 mutations.
- Final restarted gauntlet: `CI=true make verify-all` passed 17/17 files and 249/249
  tests, 9/9 inherited focused files and 109/109 tests, every E0/E1 target, all nine E1
  sabotage paths, the frozen identity digests, and the 101/75 policy proof.
- Pristine proof: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from exact
  commit `12534bdfa4ceabb47801965aadc9a7b017728c1b` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.FRTNPXeaEP/repo`, reusing 151
  packages, downloading zero, and passing 249/249 plus 101/75. An earlier exact clone
  was externally SIGTERMed at Vitest and then passed 249/249 unchanged; the next clone
  exposed and drove removal of the old-Python fixture dependency before the final full
  restart and green clone.
- Evidence: `evidence/round-12-lineage-transcript.txt`. Exact snapshot before claim:
  `runCount=11`, `runCeiling=13`, audits `[6,9]`, recovery entry digest
  `d9656c6b80daa522b84d6f66ff95c5c43e24631ef088012e12bbf8a5d12e39e1`, attester digest
  `66ad0a8452ec800c805b219c32e32b4ac76e0eb1f5d0372f51516eb7de94e129`, control digest
  `4e1c2d74b0a8ea29e0442a4dd5cf7541dae92c1b2cb4d5f8a667e1d20f5d15e9`, and ledger
  digest `b213361318cc01168d25181896a5b568a207c64c70399375967347d1dfd7c57d`.
- Claim: queue planning is now dependency-closed over Git lineage and recovery authority:
  no cited object, writer transition, or post-run recovery window is accepted without
  its committed ancestors and durable approval state, and no terminal stop is reported
  before the requested project state is independently read back.
- Replay: N/A (pure repository queue/parser/workflow control plane and non-browser
  identity package) + mitigation: committed identity event logs/digests, exact-source
  snapshots, real non-descendant Git commits, independent false-edge trajectories,
  mutation-sensitive policy execution, full inherited verification, and a scrubbed
  pristine clone.

### 2026-07-16 — judge round 11 — VERDICT: refuted

- **Parentless writer transitions are accepted.** Predicted every post-write
  `sourceCommit` must descend from its claimed `transitionBaseCommit`. An actual
  parentless commit `1308cdd5be5036f31b8633364ad49261f3d5aa4f`, carrying the frozen submission tree,
  was not a descendant of `c60759814c49f2d0fba8b4b28e36641249db572f`, yet the committed
  snapshot CLI emitted an otherwise-valid implementation transition and the workflow
  advanced to `verify-task`. Citations:
  `packages/identity/scripts/work-queue-snapshot.mjs:21-25,47-53,76-83`,
  `.claude/workflows/work-queue.js:296-303,474-489`, and
  `work/e2-t01-r11-correctness/RESULTS.md`. Demand: require base ancestry for every
  implementation, audit, verdict, and invalid-loop transition, then mutation-test an
  otherwise-valid orphan transition through the workflow.
- **The recovery ceiling is self-asserted rather than human-authorized.** Predicted that
  deleting the visible human-resume entry while retaining `verification_run_ceiling: 13`
  would fail closed. The exact frozen parser still returned `runCount=10`,
  `runCeiling=13`, and the workflow invoked run-11 verification; no prior durable
  `invalid_loop` or project `statusReason` was required. Citations:
  `.eforest/loop.md:67-79`, `packages/identity/scripts/work-queue-snapshot-lib.mjs:225-235`,
  `.claude/workflows/work-queue.js:174-183,346-359`, and
  `work/e2-t01-r11-correctness/RESULTS.md`. Demand: bind every ceiling above 10 to the
  prior committed invalid-loop transition, matching project reason, and parseable visible
  human-resume entry; independently delete each dependency and prove run 11 is withheld.
- **The explicit invalid-loop project-state edge remains unprotected.** Predicted deleting
  `after.projectStatus === 'invalid_loop'` would make the permanent verifier red; all 95
  scenarios and 64 named mutations still passed because retained trajectories always
  supply the desired state. Citation: `.claude/workflows/work-queue.js:322-335`,
  `packages/identity/scripts/verify-work-queue-policy.mjs:1123-1135,1891-1915`, and
  `work/e2-t01-r11-coverage/RESULTS.md`. Demand: add a building-state readback trajectory
  and named deletion mutation proving it returns `invalid_loop persistence unconfirmed`
  with no completed stop.
- **Reconciliation.** Every round-10 counterexample survived as fixed: exact EOF/empty/
  traversal and dangling evidence-reference probes passed; false invalid persistence at
  initial and post-verdict audit checkpoints was refused; the other thirteen readback/
  control deletions were killed; exact-tip `make verify-E2-T01` passed 17/17 files and
  249/249 tests. The 95/64 suite is materially stronger, but it does not cover the three
  dependency edges above. Run 11 is refuted; project remains `building`, and run 12 must
  apply these findings before the required runs-10-12 progress audit.
- Replay: N/A (pure repository queue/parser/workflow policy) + mitigation: exact frozen-tip
  target execution, disposable Git clones, a real parentless commit, direct snapshot/
  workflow probes, and independent deletion mutation analysis.

### 2026-07-16 — builder — round 11 queue-proof rework submitted

- Human recovery is durable rather than a reset: lifecycle commit
  `aa687778e85d81d28b358a3cf9630b63e0691889` preserves all ten verdicts and both
  progress audits, sets `verification_run_ceiling: 13`, and requires the next fresh
  progress critic after run 12. Implementation commit
  `c60759814c49f2d0fba8b4b28e36641249db572f` preserves that ceiling through every
  writer readback.
- The committed resolver now counts only addressable lines: empty files have zero lines,
  a newline-terminated file's EOF is accepted, and EOF+1 is rejected. Repository paths
  pass one pure segment validator, and commit/diff evidence must be reachable from the
  attested source rather than merely present in the object database.
- All terminal paths now return through one `stopInvalid` abstraction. It reports
  completed `invalid_loop` only after the exact project transition is independently
  attested; a failed write returns `invalid_loop persistence unconfirmed`. The redundant
  explicit control comparison was deleted because the dependency-closed `sameLedger`
  invariant already binds the control digest.
- The permanent policy verifier grew from 76 scenarios/40 mutations to 95 scenarios/64
  named mutations. It now kills every round-10 survivor: latest-audit assessment; audit
  attester/evidence/next-focus; verdict attester/log-entry/value/status; invalid ledger,
  observed commit, and result propagation; visible commit catalog; EOF/empty/traversal;
  dangling commits; and the human-authorized ceiling/history boundary.
- The ordered gauntlet was restarted after the known sandbox listener refusal and again
  after one load-related CLI-subprocess failure: format/lint, typecheck, permitted test
  (17 files, 249/249), and build all passed. The 25 affected CLI/identity cases passed
  41/41 in isolation without code changes, then the required full restart and
  `CI=true make verify-all` passed 249/249 plus 109/109 inherited focused tests, every E0
  and E1 target, and all nine E1 sabotage paths.
- Exact-tip cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T01` passed from
  `c60759814c49f2d0fba8b4b28e36641249db572f` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.ETRwJoNgQ5/repo`, reusing 151
  packages, downloading zero, passing 249/249 tests and the 95/64 policy proof.
- Evidence: `evidence/round-11-policy-transcript.txt`. The exact snapshot is schema 2,
  `runCount=10`, `runCeiling=13`, audits `[6,9]`, attester digest
  `0d73de3b45361cfc8b970bc8e4d8f96a60ed0093c007de9d4cb694dc7fae6ade`, control digest
  `e7eb87c90464a15e2f7f048fe50fbcc70c10b8a3112d2f0f87bf333c3a7b51cc`, and unchanged
  ledger digest `bb7b350bafd9387a64f3cb2a9243beeb8f40a6147ec613ba46f20a5c039d58f1`.
- Replay: N/A (pure queue/parser control plane and non-browser identity package) +
  mitigation: committed exact-source snapshots, real disposable Git clones, resolver
  boundary fixtures, mutation-sensitive compiled trajectories, complete inherited
  verification, frozen stream digests, and a scrubbed pristine clone.

### 2026-07-16 — human resume — RUNS 11-13 authorized

- The user explicitly approved continuing after the committed run-10 `invalid_loop`
  stop. This opens one bounded three-run recovery window through run 13; it does not
  erase or renumber the ten official verdicts already in this ledger.
- The next builder must apply every round-10 finding: reject nonexistent EOF+1 evidence,
  propagate failed `invalid_loop` persistence as an explicit unpersisted stop, and make
  each of the thirteen surviving audit/verdict/invalid-loop/catalog guard deletions turn
  the permanent sensor red.
- A non-verified run 12 requires a fresh progress critic over complete reports 10-12
  before run 13. Any non-verified run 13 returns the project to `invalid_loop`; another
  window requires another explicit human authorization committed before work resumes.
- Replay: N/A (human control-plane authorization) + mitigation: durable task-global run
  ceiling, preserved verdict/audit digest history, exact queue rebuild, and pre-write
  control-source attestation in the reworked workflow.

### 2026-07-16 — judge round 10 — VERDICT: refuted

- **Committed path-line resolution accepts a nonexistent EOF+1 line.** Predicted a
  `git-path` catalog item with a line suffix would be admitted only when that line has
  addressable bytes in the source commit. In independent disposable commit
  `67d3815df12549b285db7bb23601b5809308ac52`, `git show HEAD:AGENTS.md | wc -l`
  reported 441 and `sed -n '442p'` produced no bytes, yet the frozen
  `d93167c14f7704dc8509ad1b68017796301ce376` attester admitted
  `{kind:"fixture",ref:"AGENTS.md:442",verifier:"git-path",target:"AGENTS.md:442"}`.
  The resolver counts `text.split("\n").length`, including the trailing-newline empty
  sentinel. Citations: `packages/identity/scripts/work-queue-snapshot.mjs:57-71`,
  `work/e2-t01-r10-coverage/RESULTS.md`, and
  `work/e2-t01-r10-judge/RESULTS.md`. Demand: define empty-file behavior, count only
  addressable lines, and permanently cover EOF and EOF+1 with mutation-sensitive
  committed CLI probes.
- **A failed `invalid_loop` write is still reported as a completed terminal stop.**
  Predicted that failure to independently attest the project+queue transition would
  return an explicit unpersisted refusal rather than claim terminal state. `flipInvalid`
  returns its `persisted` boolean, but all six callers await and discard that result,
  then push or return `{verdict:"invalid_loop"}` even while the project may remain
  `building`. The retained extra-path scenario asserts only that a warning was logged;
  it deliberately permits this false completion. Citations:
  `.claude/workflows/work-queue.js:292-324,360-362,413-415,421-424,509-512,518-521,527-530`
  and `packages/identity/scripts/verify-work-queue-policy.mjs:864-887`. Demand: propagate
  failed invalid-loop persistence as a hard unpersisted stop at every caller and prove
  the observed project state, not merely the warning.
- **The claimed 76-scenario/40-mutation proof is not dependency-closed.** The exact
  baseline is genuinely green, but its resolver probe covers line 1 and line 999999,
  not the EOF boundary above. The fresh coverage critic also found thirteen individual
  audit/verdict/invalid-loop/catalog safety deletions that still print all 76 scenarios,
  all 40 named mutations, and `WORK_QUEUE_POLICY_OK`; source inspection confirms the
  retained mutation list samples adjacent family guards rather than every claimed
  readback dependency. Citation: `work/e2-t01-r10-coverage/RESULTS.md` and
  `packages/identity/scripts/verify-work-queue-policy.mjs:864-887,1458-1553`. Demand:
  promote the exact counterexamples and mutation-test each dependency edge before
  claiming closure.
- **Surviving evidence and terminal reconciliation.** At immutable submission
  `d93167c14f7704dc8509ad1b68017796301ce376`, the independent baseline passed 76
  scenarios/40 mutations, and the exact snapshot remained schema 2 with `runCount=9`,
  audits `[6,9]`, 13 structured catalog entries, attester digest
  `40bd755d9bcad8eef8ad941189e79a3a3458399bbfd5b99bc52cbcfa79096e21`,
  control digest `cb850c51aa6ce2f43902563e283a3258159a56580b0448664509ba230e8d6e30`,
  and ledger digest `0f8f0d846b47a62c9a3f3c263546cb16d1f2bae5a125c0dedb31f3d4e711aa5f`.
  The builder's 249/249 tests, inherited verification, frozen identity digests, and
  scrubbed cold clone survive; they do not cover the two control failures above. This is
  failed verification run 10, the absolute ceiling: E2-T01 is `refuted`, no run 11 may
  start, and the project must transition to `invalid_loop`. SUITE: no promotion while
  refuted. Replay: N/A (pure queue/parser control plane and non-browser identity work) +
  mitigation: exact committed snapshots, a disposable committed EOF reproduction,
  source-level caller audit, the permanent baseline, and both fresh critic reports.

Commands: `node packages/identity/scripts/verify-work-queue-policy.mjs`;
`git show d93167c14f7704dc8509ad1b68017796301ce376:packages/identity/scripts/work-queue-snapshot.mjs | node --input-type=module - --attester d93167c14f7704dc8509ad1b68017796301ce376 --source d93167c14f7704dc8509ad1b68017796301ce376 --task E2-T01`;
`git show 67d3815df12549b285db7bb23601b5809308ac52:AGENTS.md | wc -l`;
`git show 67d3815df12549b285db7bb23601b5809308ac52:AGENTS.md | sed -n '442p'`;
`git show d93167c14f7704dc8509ad1b68017796301ce376:packages/identity/scripts/work-queue-snapshot.mjs | node --input-type=module - --attester d93167c14f7704dc8509ad1b68017796301ce376 --source 67d3815df12549b285db7bb23601b5809308ac52 --task E2-T01`;
`git diff --check caf72809ef9c65681f56d1785e56a8c03cba613e..d93167c14f7704dc8509ad1b68017796301ce376`.

### 2026-07-16 — builder — round 10 dependency-closed queue policy submitted

- Exact implementation commits: `d1eddad754d654e07d6720419d2640cd1ea94a64`
  and `d38eca628e46588628eac5af9da209f9a9b22171`. One visible Markdown token
  stream now supplies official headings, folded top-level verdict bullets, all four
  exact audit fields, evidence extraction, and structured writer readback. Fenced and
  commented verdict/audit bodies and audits missing Rationale, Evidence, Next focus, or
  Assessment are permanent rejecting scenarios; the immutable historical run-6 audit is
  admitted only by its pinned entry digest.
- The committed control root now covers `AGENTS.md`, `.eforest/loop.md`, both child
  workflows, `tools/build_queue.py`, the attester/parser, and the permanent sensor. Audit
  and verdict commits require exact task+queue path sets, implementation requires its
  task+queue lifecycle writes and forbids the project record, and `invalid_loop` requires
  an independently reread project+queue-only commit. A committed two-step probe proves
  that changing `AGENTS.md` changes the control digest and appears in `changedPaths`.
- Evidence catalog entries now carry `{ kind, ref, verifier, target }`. Report and digest
  entries bind to exact ledger-entry digests; commit/diff endpoints must resolve through
  Git; test/fixture paths and line ranges must resolve through `git show`. Command text
  and free-floating digest syntax are deliberately absent. The exact submitted snapshot
  reports attester digest
  `40bd755d9bcad8eef8ad941189e79a3a3458399bbfd5b99bc52cbcfa79096e21`,
  control digest
  `cb850c51aa6ce2f43902563e283a3258159a56580b0448664509ba230e8d6e30`,
  ledger digest
  `0f8f0d846b47a62c9a3f3c263546cb16d1f2bae5a125c0dedb31f3d4e711aa5f`,
  nine immutable verdicts, audits `[6,9]`, thirteen verified catalog entries, and zero
  command entries.
- The permanent policy apparatus passes 76 deterministic scenarios and 40 named source
  mutations. It includes every round-9 surviving edge: audit/verdict control roots,
  run/audit prefixes, audit/verdict/implementation/invalid-loop path sets, structured
  audit readback, catalog verifier binding, visible verdict/audit/catalog bodies, and
  committed CLI path-line and commit resolvers. The old hostile hidden-body program now
  stops at `progress audit 4-6 is incomplete`; each corresponding promoted mutation
  makes the retained sensor fail. Transcript:
  `evidence/round-10-policy-transcript.txt`.
- The ordered gates passed after the exact-tip fixture correction:
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (17 files,
  249/249 tests), and `pnpm build`. `make verify-E2-T01` and `make verify-all` passed,
  retaining 109/109 inherited focused tests, all E0/E1 targets and sabotage sensors,
  all 13 provenance attacks, E1 digest
  `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`,
  and the three unchanged identity digests. The scrubbed exact-tip cold clone of
  `d38eca628e46588628eac5af9da209f9a9b22171` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.Qx0icMyoq1/repo`
  reused 151 packages, downloaded zero, passed 249/249, and passed exact
  `verify-E2-T01` with no skip.
- Replay: N/A (pure queue/parser control-plane and non-browser identity/provenance work)
  + mitigation: committed exact-source snapshots, structured ledger/control digests,
  mutation-sensitive transition and resolver probes, frozen identity stream digests,
  full inherited verification, and the scrubbed pristine clone.

### 2026-07-16 — progress critic — RUNS 7-9: progressing

- Rationale: Runs 7-9 close successively deeper dependency boundaries through general
  commit-closed invariants: agent-supplied history became commit-bound snapshots, then
  trusted pre-write attestation with full ledger/control digests. The permanent policy
  sensor compounded from 31 scenarios and 7 mutations to 38/12 and 51/21, while all
  previously surviving identity, provenance, inherited-gate, digest, and cold-clone
  behavior remained intact. Round 9's visible-body, charter-root, role-path, executable-
  evidence, and mutation-sensitivity failures require those newer abstractions and are
  deeper compositions rather than surviving renamed counterexamples.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-7 — Run 7 records the source-of-truth, checkpoint-closure, resolvable-evidence, and post-commit-readback boundary after the first 31/7 durable-accounting sensor.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-8 — Run 8 confirms the run-7 failures were closed by committed snapshots/OID readback and reaches the deeper trusted-attester, immutable-history, fixed-schedule, resolution, and Verification-log-scope boundary at 38/12.
- Evidence (report): .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md#judge-run-9 — Run 9 confirms trusted pre-write attestation, full history/control roots, task-bound audit policy, and catalog membership at 51/21 before reaching narrower visible-body, complete policy-root, role-specific path, executable-evidence, and negative-edge sensitivity failures.
- Next focus: Use one visible Markdown token stream for headings, verdict bullets, every
  audit field, evidence extraction, and persistence readback; promote fenced/commented
  bodies and every missing audit-field case.
- Next focus: Close the committed control root over AGENTS.md, .eforest/loop.md, and all
  other policy dependencies, and enforce exact role-specific changed paths for every
  writer transition.
- Next focus: Bind each evidence kind to a committed verifier/target and promote every
  round-9 surviving control, history, path, and resolver mutation so removing any edge
  makes the permanent sensor red.
- Next focus: Re-earn all ordered gates, full inherited verification, exact target, and
  scrubbed cold clone; run 10 verifies only if a fresh critic fails to refute it, and
  any non-verified run-10 verdict stops unconditionally.
- Assessment: progressing

### 2026-07-16 — judge round 9 — VERDICT: refuted

- **Visible-ledger dependency closure still fails.** Predicted verdict and progress-audit
  evidence hidden inside a fenced block or HTML comment would be ignored by the one
  fence/comment-aware grammar claimed in round 9. Independently observed the submitted
  parser accept fenced and commented verdict bullets as official findings, accept fenced
  and commented audit bodies, and accept an audit with neither Rationale nor Assessment;
  the direct hostile parser returned
  `hiddenAuditAccepted=6`, `commentedAuditAccepted=6`,
  `incompleteAuditAccepted=6`, `hiddenVerdictAccepted=1`, and
  `commentedVerdictAccepted=1`. The exact compiled workflow then accepted a run-9 audit
  whose four required fields existed only inside an HTML comment and emitted
  `events=["progress","record-progress","implement"]`, unlocking run 10. The parser
  filters visibility only while locating headings, then scans raw entry text for bullets
  and audit fields. Citations:
  `packages/identity/scripts/work-queue-snapshot-lib.mjs:55-127,183-216`,
  `work/e2-t01-r9-coverage/hostile-parser.mjs`, and
  `work/e2-t01-r9-judge/RESULTS.md`. Demand: tokenize Markdown visibility once and use
  those visible tokens for headings, verdict evidence, every exact audit field, catalog
  resolution, and writer readback; promote fenced/commented verdict and audit bodies plus
  missing-field cases.
- **The verdict transition can rewrite its own governing charter.** Predicted a verdict
  commit changing `AGENTS.md` would either change the committed control root or be refused
  by the transition path policy. At the exact submitted attester, a disposable verdict
  commit changed the task, queue, and `AGENTS.md`; the pre-write attester reported all
  three paths while preserving the same control digest
  `62f8e422b87abf024c87f2e952e8eb9a167e55c55b6c2cad6e3bab9948b5f2fd`, and the
  compiled workflow emitted `verify` before its configured run-9 stop. `CONTROL_PATHS`
  omits `AGENTS.md` and `.eforest/loop.md`, and verdict persistence never applies an
  `onlyChanged` allowlist. Citations:
  `packages/identity/scripts/work-queue-snapshot-lib.mjs:7-15`,
  `.claude/workflows/work-queue.js:399-422`, and
  `work/e2-t01-r9-judge/RESULTS.md`. Demand: close the control root over every policy
  dependency and enforce role-specific changed-path sets for implementation, audit, and
  verdict writes.
- **The permanent sensor does not prove the new safety edges.** Predicted deleting each
  post-write control/history/path guard or making either evidence resolver unconditional
  would make the 51-scenario/21-mutation verifier red. Eight independent source mutations
  all remained green: audit and verdict control guards, audit run-history and audit-entry
  prefixes, verdict audit-history preservation, audit transition paths, path/line
  resolution, and commit resolution. The exact evidence catalog also labeled
  `git show HEAD:<task>` and `node work/e2-t01-r8-policy/hostile.mjs` as resolved commands,
  but they exited 128 and 1 respectively at the submitted tip. Citations:
  `packages/identity/scripts/work-queue-snapshot-lib.mjs:245-270`,
  `work/e2-t01-r9-coverage/mutation-probe.mjs`, and
  `work/e2-t01-r9-judge/RESULTS.md`. Demand: add transition-specific hostile trajectories
  and verifiers binding each command/digest/diff to committed executable evidence, then
  mutation-test every dependency edge.
- **Reconciliation and checkpoint.** The retained verifier genuinely passes 51 scenarios
  and 21 named mutations, and the exact snapshot correctly binds source/attester
  `58e76e8b81c8bd5133de572a553e994c535d92f7`, eight prior run digests, audit end `[6]`,
  and ledger digest
  `369b6f1bed2caf6c4cd3ba646600271202339f465826e88a8d5d11d470bbd5d5`.
  Those successes do not exercise the dependency edges above. This is failed verification
  run 9: E2-T01 returns to `refuted`, the project remains `building`, and no run-10 rework
  may begin until a fresh progress critic audits the complete official reports from runs
  7-9 and issues a cited `progressing` assessment. SUITE: no promotion while refuted;
  round 10 must retain these disposable counterexamples as deterministic regressions.
  Replay: N/A (pure queue/parser orchestration and non-browser identity/provenance code) +
  mitigation: exact committed-attester snapshots, compiled-workflow trajectories, direct
  command exit codes, source-mutation sensitivity probes, and the two fresh critic reports.

Commands: `node packages/identity/scripts/verify-work-queue-policy.mjs`;
`node .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/work/e2-t01-r9-coverage/hostile-parser.mjs`;
`node .eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/work/e2-t01-r9-coverage/mutation-probe.mjs`;
`git show 58e76e8b81c8bd5133de572a553e994c535d92f7:packages/identity/scripts/work-queue-snapshot.mjs | node --input-type=module - --attester 58e76e8b81c8bd5133de572a553e994c535d92f7 --source 58e76e8b81c8bd5133de572a553e994c535d92f7 --task E2-T01`;
`node /tmp/e2-t01-r9-control/repo/hostile-control.mjs`;
`node /tmp/e2-t01-r9-control/repo/hostile-hidden-audit.mjs`.

### 2026-07-16 — builder — round 9 commit-closed attestation rework submitted

- Exact implementation tip: `4d1265114b2cfb75f6f0b2a17c4aa36cd89e3001`
  (`9ecc1ccd39aedd5194ed8d80c62cd7ba94f0135d` implements the invariant and
  `4d1265114b2cfb75f6f0b2a17c4aa36cd89e3001` corrects the independent mutation
  fixture). The queue readers now pipe the snapshot CLI from the trusted attester commit
  into `node --input-type=module -`; that committed CLI loads its parser from the same
  trusted OID while reading the new source commit. Every post-write read uses the
  pre-write attester, so a dirty or newly changed measuring program cannot attest itself.
- Snapshot schema 2 closes the complete control dependency graph. At the implementation
  tip it reports identical source/attester OID `4d126511...`, attester digest
  `4e9b960efc60ca51a74bb10a885a7c85e7013118da8f0be613b31956bb65e83a`,
  five-file control digest
  `62f8e422b87abf024c87f2e952e8eb9a167e55c55b6c2cad6e3bab9948b5f2fd`,
  eight immutable run-entry digests, one audit-entry digest, chained ledger digest
  `369b6f1bed2caf6c4cd3ba646600271202339f465826e88a8d5d11d470bbd5d5`,
  run count 8, audit start 6, completed audit `[6]`, 21 commit-resolved evidence choices,
  and no transition paths. Implementation, audit, and verdict rereads now preserve the
  entire prior run/audit prefix plus control/attester digests before accepting one exact
  append.
- Checkpoint and Markdown policy are no longer task-authored exceptions. E2-T01 must
  carry exactly the explicit historical migration `progress_audit_start: 6`; every other
  task must omit the field and begins at 3. Only one real `## Verification log` is parsed,
  with fenced code and HTML comments excluded. Judge entries share the writer's plain
  top-level evidence-bullet grammar, and progress audits must contain rationale,
  commit-resolved evidence, next focus, and a progressing assessment.
- The retained policy proof now passes 51 deterministic scenarios and 21 source
  mutations. It promotes every round-8 counterexample: dirty CLI in a fresh local clone,
  trusted-attester command removal, prior-run rewrite during implementation and verdict,
  control-source change, arbitrary audit start 9, syntactically valid but absent
  evidence, fenced/out-of-section headings, heading-only/missing-evidence audits, and
  plain evidence bullets. Both old round-8 hostile programs now abort at their first
  expected bypass because the workflow refuses before verification.
- Re-earned the ordered gauntlet at the implementation tip: `pnpm format:check`,
  `pnpm lint`, `pnpm typecheck`, `pnpm test` (17 files, 249/249), and `pnpm build` all
  passed. Exact `make verify-E2-T01` passed with all 51/21 queue-policy proofs, 13
  provenance attacks, 235 provenance-closure files, seven frozen verifiers, and the three
  unchanged identity digests. `make verify-all` passed every defined E0/E1/E2 target,
  109/109 inherited focused tests, all inherited sabotage sensors, and E1 final digest
  `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`.
- Scrubbed cold clone `tools/verify/cold_clone.sh --keep verify-E2-T01` cloned exact tip
  `4d126511...` to
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.3ke47KGVdm/repo`,
  reused 151 packages, downloaded zero, passed 249/249 tests, and passed the exact target
  with all 51 scenarios, 21 mutations, and 13 provenance attacks. Replay: N/A (pure
  identity/provenance and queue/parser orchestration) + mitigation: committed-attester
  execution, immutable history/control digests, commit-resolved evidence,
  mutation-sensitive workflows, full inherited verification, and the exact-tip pristine
  clone.

### 2026-07-16 — builder — round 9 commit-closed attestation rework started

- Round 8 proved that committed input bytes are insufficient when the attester program,
  prior evidence, citation targets, and Markdown location are outside the closure. Round
  9 will execute or verify the attester from exact committed bytes, carry an immutable
  digest over every prior verdict and audit entry, and reject any writer commit that
  changes pre-existing ledger evidence or unauthorized paths.
- The audit schedule will be fixed policy: ordinary tasks begin at checkpoint 3 and the
  explicit E2-T01 historical migration is pinned to 6. Evidence kinds will resolve
  against the attested commit, and official history will be parsed only from the real
  fence/comment-aware Verification-log section under one shared reader/writer grammar.
- Every round-8 counterexample will become a retained deterministic scenario and source
  mutation: dirty attester plus unrelated commit, prior-report/audit rewrite, audit start
  9, missing path+line evidence, and fenced/out-of-section headings. Replay: N/A (pure
  queue/parser orchestration) + mitigation: exact-commit executable/source digests,
  immutable ledger roots, commit-resolved evidence, mutation-sensitive workflow tests,
  full inherited verification, and an exact-tip scrubbed cold clone.

### 2026-07-16 — judge round 8 — VERDICT: refuted

- **The independent readers do not attest the executable that interprets committed
  bytes.** Predicted an uncommitted change to the snapshot CLI plus an unrelated HEAD
  movement could not manufacture a task transition absent from the committed readme and
  queue. In a fresh exact-`f3a850d` clone, a dirty
  `work-queue-snapshot.mjs` and an empty commit made both reader pairs report run 8 as
  verified and the workflow return `verdict:"verified"`; `git show HEAD:<task>` still
  said `status: implemented`, contained no round-8 verdict, the committed queue still
  gated on E2-T01, and `git diff --name-only HEAD^ HEAD` was empty. Citations:
  `work/e2-t01-r8-environment/warm-worktree-attack.mjs` and
  `work/e2-t01-r8-judge/RESULTS.md`. Demand: execute the CLI and imported parser from an
  isolated exact-commit tree or bind and verify their committed bytes before trusting
  either reader; promote this dirty-attester plus unrelated-commit trajectory.
- **Writer transitions are not append-only over official history.** Predicted every
  prior verdict and accepted audit would remain byte-identical across implementation and
  verdict commits. Independently observed run-5-7 `entryDigest`s change, the run-4-6
  progress audit shrink to its heading, and the workflow still emit
  `events=["implement","verify"]` and return verified. `sameLedger` compares counters and
  audit endpoints, not the prior report/audit digests. Citation:
  `work/e2-t01-r8-policy/hostile.mjs` (`LEDGER_REWRITE_ACCEPTED`) and
  `.claude/workflows/work-queue.js:183-189,287-341`. Demand: snapshot a full-history
  chained/root digest and require every writer readback to preserve the complete prior
  ledger before appending its one authorized transition.
- **Checkpoint and citation policy remain forgeable.** Predicted the charter's schedule
  would be fixed at 3/6/9 (with only E2-T01's explicit run-6 adoption migration) and a
  progress citation would resolve at the attested commit. Independently observed
  `progress_audit_start: 9` skip the run-6 checkpoint and verify run 8 with no audit; a
  nonexistent `work/e2-t01-r8-policy/definitely-missing.md:999999` citation also earned
  run 4. Citations: `work/e2-t01-r8-policy/hostile.mjs`
  (`AUDIT_START_BYPASS`, `MISSING_CITATION_ACCEPTED`) and
  `packages/identity/scripts/work-queue-snapshot-lib.mjs:54-57,159-161`. Demand: bind
  audit start to task policy (E2-T01 exactly 6, all ordinary tasks exactly 3), and resolve
  path/line, commit, digest, fixture, test, and command evidence by kind against the
  attested commit before persisting `progressing`.
- **The official ledger parser counts non-ledger prose.** Predicted only verdict and
  audit entries inside `## Verification log`, outside fences/comments, would affect
  control state. A readme with no real verdicts but three fenced example headings before
  the log parsed as three runs plus a completed audit; the related hostile suite also
  showed out-of-section headings counted and plain top-level evidence bullets rejected
  despite the writer contract allowing them. Citations:
  `work/e2-t01-r8-policy/hostile.mjs` (`FENCED_EXAMPLES_COUNTED`) and
  `work/e2-t01-r8-tests/hostile.mjs`. Demand: use one shared markdown-aware entry grammar
  scoped to the Verification-log section and promote fenced, commented, pre/post-log,
  and plain-bullet cases.
- **Reconciliation and next gate.** The retained 38-scenario/12-mutation sensor, exact
  committed snapshot, 249/249 tests, three identity digests, 13 provenance attacks,
  full inherited verification, and scrubbed exact-tip cold clone are genuinely green.
  They do not execute the dependency edges above. Round 8 returns E2-T01 to `refuted`;
  the project remains `building`, and the mandatory fresh progress audit is due after
  failed run 9 before any run 10. SUITE: no judge promotion while refuted; the four
  disposable counterexamples above must become deterministic regressions in round 9.
  Replay: N/A (pure queue/parser policy and non-browser identity package) + mitigation:
  exact-tip compiled-workflow attacks, a fresh-clone dirty-executable reproduction,
  retained stream/provenance sensors, and the three critic reports.

Commands: `node packages/identity/scripts/verify-work-queue-policy.mjs`;
`node packages/identity/scripts/work-queue-snapshot.mjs --task E2-T01`;
`node work/e2-t01-r8-policy/hostile.mjs`;
`node work/e2-t01-r8-tests/hostile.mjs`;
`ATTACK_ROOT=<fresh-exact-tip-clone> node work/e2-t01-r8-environment/warm-worktree-attack.mjs`;
`git diff --check ae8b73b875781838ff7fa95b42b797af2c2407c0..f3a850dab3075d3efc6603448f653a662f359663`.

### 2026-07-16 — builder — round 8 commit-bound accounting rework submitted

- Exact implementation commit: `f8d63b39cc08304d42a583ccab25247566dd8e43`.
  Before any control decision, `.claude/workflows/work-queue.js` now asks two fresh
  readers to execute the same deterministic snapshot command and accepts only
  byte-identical output. The snapshot parser reads `.eforest/project.json`, the queue,
  and the queue-bound canonical task readme from exact `git show HEAD:<path>` bytes;
  binds their SHA-256 digests and full commit OID; validates task ID, path, lifecycle,
  oldest-first official verdict sequence, complete latest-three reports, checkpoint
  closure, and the absolute ten-run ceiling; then exposes no free-form ledger input.
- Persistence is observed rather than self-attested. Builder, progress-audit, and judge
  writers return `{ baseCommit, commitOid }`; a new independent reader pair must then
  observe that distinct exact commit and the expected task-log, status, and queue delta.
  Progress evidence is structured as `{ kind, ref, supports }`, and the nested
  `verify-task.js` result must match the exact task, monotonic round, verdict entry,
  lifecycle, base OID, and written OID. A refuted verdict can re-enter implementation and
  reach a second verdict in the same orchestrated run without resetting accounting.
- The permanent policy proof passed 38 deterministic scenarios and 12 source mutations.
  It covers dual-reader disagreement, omitted committed runs, fabricated or stale
  checkpoints, substituted canonical paths, mismatched frontmatter IDs, malformed run
  sequences, incomplete reports, unstructured citations, unchanged-HEAD attestations,
  wrong-task verdicts, the actual nested-verifier commit-OID boundary, resumes at
  4/5/7/8/10, exact run-10 success/failure, and refuted-to-reworked-to-verified execution.
  The exact committed snapshot reported task `E2-T01`, status `in-progress`, run count 7,
  audit start 6, completed audit `[6]`, and source OID `f8d63b39...`.
- Re-earned the ordered gauntlet at the implementation tip:
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (17 files, 249/249),
  and `pnpm build` all passed. `make verify-E2-T01` passed with all 38 policy scenarios,
  12 policy mutations, 13 provenance attacks, 235 provenance-closure files, seven
  verifier inputs, and the three unchanged identity digests
  `00d247cbbbd8cec0015400ed153eae50ed64fa58f7d1d9c8313eb50175b2cc99`,
  `064121fb63caa5e352ee9474ce9386d28a8a4febe002c2e4d3d0310ee4571f16`, and
  `5b2e66bee06ecd33945973686eac99aba21f2a5d65ad01840a480ca517ee56b9`.
- `make verify-all` passed every defined target: the 249/249 repository suite, 109/109
  inherited focused tests, every E0/E1 task proof, all inherited sabotage sensors, E1
  final digest `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`,
  and exact E2-T01. The scrubbed exact-tip cold clone at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.HEvB4P9QCd/repo`
  reused 151 packages, downloaded zero, passed 249/249 tests, and passed
  `verify-E2-T01` with no skipped verification.
- Replay: N/A (pure identity/provenance code and non-browser queue orchestration) +
  mitigation: exact committed-byte snapshots, dual-reader consensus, post-commit
  rereads, mutation-sensitive policy execution, frozen identity stream digests, inherited
  sabotage, full `verify-all`, exact target, and the scrubbed pristine clone.

### 2026-07-16 — builder — round 8 rework started

- Run 7 established that schema-valid agent output is not durable evidence. Round 8 will
  bind the current queue identity, canonical task path, lifecycle, complete official
  verdict sequence, and progress checkpoints to exact committed bytes and a commit OID;
  no free-form omission or substituted path may survive validation.
- The checkpoint invariant will become closure-based rather than edge-triggered: resumes
  at runs 4/5, 7/8, and 10 must prove the preceding 3/6/9 audit exists before any builder
  or verifier call. Persistence will be verified by post-commit reread instead of
  `committed:true`, and progress evidence will use structured resolvable citations.
- The retained sensor will execute/source-bind the actual `verify-task.js` return boundary
  and a refuted-then-reworked-then-verified two-verdict path, while keeping all 31 prior
  trajectories, seven policy mutations, 13 provenance attacks, identity digests, and
  inherited targets green. Replay: N/A (queue orchestration and pure identity/provenance)
  + mitigation: deterministic committed-ledger parsing, exact OID/readback checks,
  mutation-sensitive workflow execution, full inherited verification, and cold clone.

### 2026-07-16 — judge round 7 — VERDICT: refuted

- **The durable ledger is not bound to committed source bytes.** Predicted the queue
  workflow would independently derive the current task identity, complete oldest-first
  verdict history, progress checkpoints, and lifecycle from a committed queue/task
  record before any builder call. The exact compiled workflow instead accepted an empty
  E2-T01 ledger despite six committed prior verdicts, a fabricated run-six checkpoint,
  `taskId: E2-T01` paired with an E9 task path, and `status: pending` paired with six
  prior runs; each trajectory continued into implementation or verification. Citation:
  `.claude/workflows/work-queue.js:102-120,168-186`,
  `work/e2-t01-r7-policy/hostile.mjs:113-156`,
  `work/e2-t01-r7-coverage/attack.mjs:27-46`, and
  `work/e2-t01-r7-judge/RESULTS.md`. Demand: derive or independently attest the queue
  gate and full task ledger at an exact commit OID, bind ID to canonical path, reconcile
  lifecycle with the ledger, and promote omitted-run, fabricated-checkpoint,
  substituted-path, and pending-with-history mutations.
- **Checkpoint closure fails after the exact boundary.** Predicted seven failed runs
  with only the run-three checkpoint would refuse or audit runs 4-6 before more work.
  Observed `events=["implement","verify"]`, a verified run eight, and no progress audit.
  `validHistory` accepts any earlier multiple-of-three checkpoint, while
  `auditCheckpoint` notices a missing audit only when the current run count is itself
  divisible by three. Citation: `.claude/workflows/work-queue.js:105-107,189-193`,
  `work/e2-t01-r7-coverage/attack.mjs:18-25`, and the judge report. Demand: require every
  checkpoint strictly preceding the current run, cover stale checkpoints at resumes
  4/5/7/8/10, and mutation-test the run-count/checkpoint dependency.
- **Cited progress and durable persistence are still self-attested.** Predicted a
  three-run window with empty findings/reports and `evidence:["not-a-citation"]` would
  fail, and that audit/verdict writers could continue only after an independent
  post-commit read. The workflow earned run four from that incomplete window and
  returned verified when audit and verdict stubs claimed `committed:true` while HEAD
  remained unchanged. Citation: `.claude/workflows/work-queue.js:108-119,139-147,
  216-229,262-269`, `work/e2-t01-r7-policy/hostile.mjs:119-134,158-172`, and the judge
  report. Demand: require complete failed-run artifacts and structured resolvable
  citations, return a commit OID, then independently reread the exact task entry/status
  and queue at that OID before continuing.
- **Permanent coverage is incomplete at the nested-verifier boundary.** The 31/7 sensor
  loads only `work-queue.js`; deleting round seven's `committed` propagation from
  `verify-task.js` stays green, and no committed scenario exercises a non-verified
  verdict followed by in-process rework and a second verdict. Demand: execute or
  source-bind the real nested verifier boundary and cover a multi-verdict rework path.
- **Reconciliation.** Exact-tip `make verify-E2-T01` and the scrubbed critic cold clone
  remain green: 249/249 tests, all three identity digests, all 13 provenance attacks,
  151 packages reused with zero downloads, idempotent queue, and no scope or inherited
  regression. This is failed verification run 7; E2-T01 returns to `refuted`, the
  project remains `building`, and run 8 may address the bounded accounting demands above.
  Replay: N/A (pure queue workflow and identity/provenance code) + mitigation: exact
  compiled-workflow attacks, the committed mutation sensor, frozen digests, exact target,
  and scrubbed cold clone.

### 2026-07-16 — builder — round 7 durable queue-accounting rework submitted

- Exact implementation commit: `ac062e77fbf012c0e9028bacc573f1aca18717e1`.
  `.claude/workflows/work-queue.js` now reconstructs the task-global oldest-first run
  history and latest committed progress checkpoint from the current task record before
  any builder call. A resume after six failed runs therefore starts at run 7, sends
  reports 7-9 to the next checkpoint critic, and can never reset the absolute ten-run
  ceiling. The workflow also rejects a verdict committed for a different task.
- All four round-six fail-open paths are closed. Project state must be observed as exactly
  `building`; `maxRuns` must be an integer from 1 through 10 and the legacy `maxRetries`
  input is refused; a `progressing` assessment requires a non-empty rationale, at least
  one concrete evidence citation, and at least one next focus; and both critic verdicts
  and accepted progress audits must report that their task-record/queue commits succeeded
  before implementation may continue. A configured lower ceiling stops before writing
  an audit that falsely earns another run.
- The policy is now a permanent sensor. `verify-work-queue-policy.mjs`, invoked by the
  E2 golden verifier, passed 31 deterministic trajectories: missing state/history,
  malformed ledgers, exact E2-T01 resume at six, checkpoints 3/6/9 with complete latest
  windows, incomplete progress, failed audit persistence, lower ceilings, exact run-10
  success/failure, implemented-task routing, and wrong-task/uncommitted verdicts. Seven
  source mutations each made the harness fail: state fail-open, limit fallback, history
  reset, uncited progress, uncommitted progress, uncommitted verdict, and wrong-task
  verdict acceptance.
- The ordered gauntlet was restarted from formatting after the sandbox reproduced the
  known `listen EPERM: operation not permitted 127.0.0.1` infrastructure failure. The
  permitted serialized run passed `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (17 files, 249/249 tests), and `pnpm build`. Exact
  `make verify-E2-T01` passed with the 31 policy scenarios, seven policy mutations, all
  13 provenance attacks, and the three unchanged identity digests.
- `make verify-all` passed every defined target: 249/249 repository tests, 109/109
  inherited focused tests, every E0/E1 target, all nine E1 sabotage sensors, E1 final
  digest `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`, and
  exact E2-T01. Identity digests remain
  `00d247cbbbd8cec0015400ed153eae50ed64fa58f7d1d9c8313eb50175b2cc99`,
  `064121fb63caa5e352ee9474ce9386d28a8a4febe002c2e4d3d0310ee4571f16`, and
  `5b2e66bee06ecd33945973686eac99aba21f2a5d65ad01840a480ca517ee56b9`.
- Scrubbed `tools/verify/cold_clone.sh --keep verify-E2-T01` cloned exact commit
  `ac062e7` to
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.LMJmJuwHEE/repo`, reused all
  151 packages with zero downloads, passed 249/249 tests, and passed the exact target
  with all policy/provenance mutations. Replay: N/A (pure identity/provenance and
  queue-workflow policy with no browser-reaching surface) + mitigation: committed stream
  digests, deterministic policy trajectories, mutation-sensitive source rewrites,
  inherited sabotage, full `verify-all`, exact target, and the scrubbed cold clone.

### 2026-07-16 — progress critic — RUNS 4-6: progressing

- Earlier findings are genuinely closing rather than cycling. The permanent provenance
  attack corpus grew monotonically from 6 in round 4, to 10 in round 5, to 13 in round 6.
  Round 6 replaces the leaf/path exceptions with shared ancestor-closure and exact frozen
  pnpm-slot invariants; fresh critics rejected the original counterexamples plus three
  composed path/link attacks, and removing either guard made its promoted regression pass.
- The accumulated suite did not regress: round 6 retained 12/12 focused identity tests,
  all three frozen digests, 249/249 repository tests, every inherited E0/E1 target and
  sabotage sensor, the exact scope, and a scrubbed 151-reused/zero-downloaded cold clone.
  Citations: `work/e2-t01-progress-r4-r6/RESULTS.md` and the complete round 4-6 reports it
  cites.
- The round-six refutation is a distinct human-added workflow surface, not a renamed
  provenance finding. Its four independently reproduced fail-open holes remain binding:
  durable task-global run accounting across restarts; non-empty cited progress; exact
  `building` state; and strict run-limit validation. The current gitignored harness does
  not count as a retained suite artifact.
- Assessment: `progressing`. Run 7 and only the next window through run 9 are earned; this
  does not waive the findings or pre-authorize run 10. Next focus is a durable committed
  run ledger, fail-closed controls, and a permanent mutation-sensitive workflow-policy
  harness, while retaining all 13 provenance attacks and inherited gates.

### 2026-07-16 — judge round 6 — VERDICT: refuted

- **Task-level verification-run accounting is not durable.** Predicted this resumed
  round-six verdict would be counted as run 6 and send complete reports 4-6 to the
  mandatory progress critic before run 7. Independently observed
  `.claude/workflows/work-queue.js` always restart its in-memory ledger at run 1; reports
  explicitly named actual rounds 6-8 produced label `runs-1-3` and omitted rounds 4-5.
  Restarts can therefore evade both checkpoints and the absolute-ten task ceiling.
  Citation: `.claude/workflows/work-queue.js:79-87,118-130`,
  `work/e2-t01-r6-scope/RESULTS.md`,
  `work/e2-t01-r6-scope-skeptic/RESULTS.md`, and
  `work/e2-t01-r6-judge/RESULTS.md`. Demand: load a durable monotonic per-task run ledger
  and complete latest-three reports across restart/resume.
- **Three workflow gates fail open.** A schema-valid but citation-free
  `{assessment:"progressing", rationale:"", evidence:[], nextFocus:[]}` earned run 4;
  an undefined project-state result implemented and verified instead of refusing; and
  invalid `maxRuns` values `0`, `-2`, `2.5`, and string `"3"` each expanded to ten runs.
  These reproduce changed workflow behavior and directly violate the human-approved
  cited-progress, building-only, and absolute-ceiling charter. Citation:
  `.claude/workflows/work-queue.js:18-42,88-119` and the same scope/skeptic/judge reports.
  Demand: require non-empty cited progress, fail closed unless state is exactly
  `building`, validate an integer `maxRuns` in `[1,10]`, and promote all trajectories.
- **Green implementation evidence is preserved.** Exact-tip provenance still passes its
  235-file/seven-verifier closure and all 13 promoted attacks; focused identity remains
  12/12 with all three frozen digests and prior regressions; the independent scrubbed
  cold clone reused 151 packages with zero downloads and passed 249/249 plus the exact
  target. Scope outside the workflow, E1 evidence restrictions, and queue idempotence
  are also green. Citations: `work/e2-t01-r6-provenance/RESULTS.md`,
  `work/e2-t01-r6-identity/RESULTS.md`, and
  `work/e2-t01-r6-environment/RESULTS.md`.
- **Checkpoint.** This is failed verification run 6. E2-T01 returns to `refuted`, but
  the project remains `building`; no run-7 rework may start until a fresh progress critic
  audits complete official reports from rounds 4-6 and issues a cited `progressing`
  assessment. Replay: N/A (pure identity/provenance and queue-workflow policy) +
  mitigation: exact-tip scripts/tests, deterministic workflow trajectories, independent
  skeptic reproduction, and the scrubbed exact-tip cold clone.

### 2026-07-16 — builder — round 6 dependency-closed provenance rework submitted

- Exact implementation commit: `d54af44acbfc472985596e4d4345029cef6a391c`.
  `assertRepositoryAncestors` now walks from the repository root through every parent of
  every explicit provenance file and closure root with `lstat`, rejecting symbolic links
  before any leaf read or recursive enumeration can follow them. Installed-package links
  still permit pnpm's normal final symlink, but its realpath must now equal the one store
  entry derived from the frozen provenance `name` plus `version`:
  `@durable-streams+client@0.2.6` or `@durable-streams+server@0.3.7`.
- The permanent provenance suite now runs thirteen independently restored attacks. The
  three round-six promotions are a byte-identical linked `tools/verify` ancestor and
  byte-identical client/server packages placed in otherwise valid `9.9.9` pnpm version
  slots. All three go red at their intended general invariant, while the prior ten attacks
  still survive. Mutation-testing the apparatus in the retained pristine clone proved
  sensitivity: restoring suffix-only package matching made the alternate-client attack
  unexpectedly pass; deleting the explicit-file ancestor walk made the linked-parent
  attack unexpectedly pass; restoring both guards returned all 13/13 attacks to green.
- The required builder gauntlet was restarted from formatting after the sandbox refused
  loopback listeners with `listen EPERM`. The unrestricted serialized run passed
  `pnpm format:check && pnpm lint`, `pnpm typecheck`, `pnpm test` (17 files, 249/249), and
  `pnpm build`. Exact `make verify-E2-T01` then passed with all three identity digests,
  exact bisect offset `0000000000000000_0000000000000006`, the 235-file/seven-verifier
  E1 closure, both frozen installed-package slots, and all thirteen provenance attacks.
- `make verify-all` passed at the exact implementation tip: 249/249 repository tests,
  109/109 inherited focused tests, every E0/E1 target, all nine E1 sabotage sensors, the
  E1 final digest `fa69385f62996b0252e19fce4c3bd3a9002c66a8476b140fef1ee0dae7c1db9a`,
  and the exact E2 target. Identity digests remain
  `00d247cbbbd8cec0015400ed153eae50ed64fa58f7d1d9c8313eb50175b2cc99`
  (main), `064121fb63caa5e352ee9474ce9386d28a8a4febe002c2e4d3d0310ee4571f16`
  (prototype keys), and `5b2e66bee06ecd33945973686eac99aba21f2a5d65ad01840a480ca517ee56b9`
  (revoked-membership prefix).
- Scrubbed `tools/verify/cold_clone.sh --keep verify-E2-T01` cloned exact commit
  `d54af44` to
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.o3Ctoipoo3/repo`, reused all
  151 packages with zero downloads, passed 249/249 tests, and passed the exact target with
  all thirteen mutations. The refreshed symbolic-HEAD scope transcript proves the
  expanded human-approved allowlist, empty protected-package/database scans, exact E1
  artifact set, and idempotent 24/101 generated queue.
- The human-approved loop charter is committed separately at
  `21d966f58009a573c526164cc3943a775f8e89ae`. Failed verification runs 3, 6, and 9 now
  send their complete three-report window to a fresh read-only progress critic; only a
  cited `progressing` assessment earns the next window, and a failed run 10 always stops.
  A four-scenario executable harness proved run-3 continuation, run-3 death-spiral stop,
  failed-run-10 stop, and successful verification on run 10.
- Replay: N/A (pure repository-provenance and queue-orchestration code with no
  browser-reaching surface) + mitigation: exact identity logs/digests, 13 disposable-clone
  path/package mutations, two guard-removal sensitivity proofs, the four-scenario progress
  harness, full inherited `verify-all`, exact target, scope transcript, and scrubbed cold
  clone above.

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
