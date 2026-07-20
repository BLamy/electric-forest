---
id: E2-T06
epic: 2
title: "Stream namespaces: orgs, projects, and repos created through dispatch and resolved by a reducer view — no database anywhere"
priority: 206
status: in-progress
verification_run_ceiling: 3
verification_recovery_base_run: 0
verification_recovery_generation: 2
verification_recovery_control_commit: 6c925ef0aeee4edcb89beb27521acda3ca60a635
verification_invalid_loop_commit: 441e8372e12aad69a68540cfb0e83be3fdfec114
verification_resume_commit: 1b5b29d896e74c1ec31ae5bfd10e9f6c6c8d3eac
depends_on: [E2-T01, E2-T03]
estimate: M
capstone: false
---

## Goal

`@eforest/platform` (`packages/platform`; if E2-T01 landed the identity model under a
different package name, that task's naming governs and this task extends it) gives the
platform its namespace tree — **as events, resolved by a reducer, with no storage of any
kind outside streams** (bet 4). Org, project, and repo creation are dispatches through
the E0-T11 door, authenticated per E2-T03: `ns.org.create { v: 1, name }` appends to the
root namespace stream `ns:root`; `ns.project.create { v: 1, name }` and
`ns.repo.create { v: 1, name, project, visibility }` append to the per-org namespace
stream `ns:org:<org>` created as a side effect of the org-create event (minted by the
same dispatch handling, never by a client). Every accepted creation event carries
`actor: { sub }` **stamped by the server from the E2-T03-verified bearer token** — the
client payload carries no actor/owner field at all (one present is a `schema-violation`,
422). The namespace-resolution view is a pure reducer over `ns:root` + `ns:org:<org>`
logs, materializing: `resolve("org/repo")` → `{ repoStreamPrefix, visibility, owner,
project }` where `repoStreamPrefix` is the frozen `fs:<org>/<repo>` prefix under which
E1's branch streams live (`fs:<org>/<repo>:main:meta` etc.), and
`resolve("org/repo/branch")` narrows to that branch's metadata stream id. The view is
digestible: `ef replay <stream-dump> --digest` over the namespace reducer yields a
canonical SHA-256 per stream dump (E0-T04's instrument takes exactly one stream's JSONL
dump — nothing multiplexed), the view digest is defined over those per-stream replays in
the deterministic order frozen in the Contract below, and the golden creation logs
committed here replay to committed digests in two separate processes. Duplicates and malformed names are refused **before append**
through E0-T11's validator with frozen reason codes — `ns/name-taken`,
`ns/invalid-name`, `ns/org-not-found`, `ns/project-not-found`, `ns/reserved-name` — all
`validator-rejected` (409), all log-neutral by byte-identical head offset and dump
digest. After this task, `git diff` for the task contains no database, no key-value
store, no side file, no in-process `Map` that outlives a request without being derived
from replay: the only persistence in the tree remains the E0-T05/T07 stream store.

## Context

Epic 2's premise (ROADMAP.md, "Epic 2 — the-gates") is that platform records — users,
orgs, projects, repos — are "events on identity streams reduced to an authorization
view," with **no database** as bet 4. E2-T01 froze that model for identity
(user/org/membership/grant events → authorization view); this task extends the same
pattern to the namespace tree that everything else navigates by: E2-T07 authorizes
per-stream reads/writes against the `visibility` and `owner` this view materializes,
E2-T08 promotes `__registry__` into a project index derived from these same creation
events, E3's web app browses org → repo → tree by calling this resolver, and E4's
`ef init`/`ef clone` mint and resolve these paths from the CLI. If a single side table
sneaks in here, bet 4 is dead at the root of the tree and every downstream epic inherits
a second source of truth.

Builds on: E2-T01 (identity streams and the authorization view — the `actor.sub` values
stamped here are E2-T01 subjects, and org creation must be consistent with whatever org
identity events E2-T01 froze: if E2-T01 already defined an org-creation event, this task
**reuses it** and adds only project/repo/resolution, documenting the reuse in the
package README rather than minting a duplicate event type), E2-T03 (bearer verification
at every mutating door — an unauthenticated `ns.*` dispatch never reaches this task's
validators; it dies at T03's typed 401 with the log untouched), E0-T11 (the validator
extension point and the frozen 409 `validator-rejected` refusal shape these reason codes
ride on), E0-T04 (`ef replay --digest` as the evidence instrument), E1-T01
(the `fs:` stream naming this resolver maps into; the `fs:<org>/<repo>` org-scoped
prefix is frozen **here** — E1 repos created before org scoping are unaffected; nothing
rewrites them).

Contract frozen here, versioned from this task forward:

- **Event shapes**: `ns.org.create { v: 1, name }`, `ns.project.create { v: 1, name }`,
  `ns.repo.create { v: 1, name, project, visibility }` with
  `visibility ∈ {"public","private"}` (no default — absent is a 422), plus the
  server-stamped `actor: { sub }` on every accepted event. The target org for
  `ns.project.create` and `ns.repo.create` is named **exclusively by the dispatch's
  target stream id** `ns:org:<org>` — payloads carry no `org` field, and one present
  is a 422 `schema-violation`. Changing any shape later invalidates the golden logs
  committed here.
- **Name grammar**: org, project, and repo names match
  `^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$` (lowercase slug, 1–40 chars, no
  leading/trailing/double hyphen — `a--b` is refused as `ns/invalid-name`, as are
  `-a` and `a-`; a 40-char valid name passes, 41 chars fails the lookahead).
  Anything else is `ns/invalid-name`.
- **Reserved names**: `main`, `ns`, and `fs` are `ns/reserved-name` at every level.
  Names matching `^__.*__$` (`__registry__`, `__x__` et al.) need no reserved rule:
  underscores are outside the name grammar, so they refuse as `ns/invalid-name`.
- **Validation order** (frozen): grammar → reserved → org/project existence →
  uniqueness; the first failing check's reason code is the one returned. Hence
  `FOO` against an existing `foo` is `ns/invalid-name` (grammar, not
  `ns/name-taken`), and `__x__`-style names are `ns/invalid-name`, never
  `ns/reserved-name`.
- **Uniqueness scopes**: org names unique across `ns:root`; project names unique per
  org; repo names unique per org (across projects, so `org/repo` resolves without a
  project segment). Uniqueness is exact-string over live names in the reduced view at
  head. Violation is `ns/name-taken`.
- **Resolution semantics**: the view is a pure function of the namespace logs;
  `resolve` answers from reduced state only. `org` → `{ org: <name>, owner: actor.sub
  of the org-creating event, projects: [<name>...], repos: [{ name, project,
  visibility }...] }` with both lists sorted lexicographically by name (the shape E3's
  org → repo browsing and E2-T08's index consume); `org/repo` → `{ repoStreamPrefix:
  "fs:<org>/<repo>", visibility, owner: actor.sub of the creating event, project }`;
  `org/repo/branch` → the branch metadata stream id under that prefix. Branch
  resolution is **purely syntactic**: any nonempty, slash-free branch segment under a
  known `org/repo` maps to `fs:<org>/<repo>:<branch>:meta` — branch existence lives
  in E1's `fs:*` streams, which this resolver never consults and makes no claim
  about. The typed not-found result (a value, not an exception) applies to unknown
  org and repo segments, and to a malformed (empty or slash-containing) branch
  segment.
- **Digest composition over multiple streams** (frozen here): E0-T04's
  `ef replay <dump.jsonl> --digest` takes a single stream's dump in offset order —
  this task defines **no multiplexed dump format**. Golden fixtures commit **one dump
  file per stream** (`ns:root` plus each `ns:org:<org>`), and each `expected.json`
  carries one digest **per stream dump**. The **namespace-view digest** is defined as
  the E0-T04 canonical-JSON SHA-256 of the reduced state produced by replaying the
  streams in a fixed deterministic order: `ns:root` in full first, then each
  `ns:org:<org>` stream in full in lexicographic order of stream id (bytewise over the
  full stream id). This order is what the two-process replay harness, the fuzz
  differential oracle, and any from-scratch resolver must all target; per-stream
  offsets never interleave across streams, so no cross-stream offset ordering exists
  or is needed.
- **Refusal reason codes** (all E0-T11 `validator-rejected`, HTTP 409, `error.reason`
  set): `ns/name-taken`, `ns/invalid-name`, `ns/reserved-name`, `ns/org-not-found`
  (project/repo create naming a nonexistent org), `ns/project-not-found` (repo create
  naming a nonexistent project in that org). Documented in the package README beside
  E0-T11's class→code table and E2-T03's 401 contract.
- **Reconciliation with E0-T11's stream-not-found 404** (frozen here, additive): for
  dispatches whose target stream id matches the registered `ns:org:*` pattern, the
  dispatch door runs the namespace existence validator **before** E0-T11's
  stream-existence check, so `ns.project.create`/`ns.repo.create` against a
  never-created `ns:org:<org>` is 409 `validator-rejected` with `error.reason:
  ns/org-not-found` — not E0-T05's 404. This is a pattern-scoped carve-out, documented
  in the package README beside E0-T11's class→code table; for every target id *not*
  matching a registered `ns:*` pattern, E0-T11's frozen stream-not-found 404 (no
  `error.class`) is untouched, and `verify-E0-T11` re-runs green under this task's
  Makefile target to prove the carve-out is additive.
- **Serialization guarantee**: dispatch validation for `ns.*` actions reads reduced
  state at head and appends atomically with respect to other dispatches on the same
  stream (E0-T11's documented dispatch serialization); two racing creates of the same
  name resolve to exactly one accepted event and one `ns/name-taken` refusal.

Non-goals: enforcement of `visibility` on reads/writes (E2-T07 — this task only
materializes the flag and owner truthfully), the `__registry__` project index
(E2-T08 — it derives from these events later), org membership and roles beyond the
recorded creator (E2-T01's grants govern; T07 consumes), rename/transfer/delete of
namespace entities (future events, additive), and any web UI (E3). Per AGENTS.md 3a
this task has no browser-reaching surface: Replay browser evidence is declared N/A with
stream-layer digests as the mitigation.

## Deliverables

- `packages/platform/src/ns/events.ts` — the three frozen `ns.*` event schemas with
  runtime guards (exact fields, no extras, visibility enum, name grammar as a single
  exported `NS_NAME_RE` used by both schema and validator — one regex, no second
  implementation), and the actor-stamping contract: the dispatch payload schema
  **excludes** actor/owner; the appended event **includes** `actor.sub` injected from
  the E2-T03-verified token subject.
- `packages/platform/src/ns/reducer.ts` — the namespace reducer over `ns:root` and
  `ns:org:<org>` events, registered in E0-T10's registry, producing canonical-JSON
  reduced state (orgs → projects → repos with `visibility`, `owner`, `project`,
  `repoStreamPrefix`), digestible by `ef replay --digest` with zero
  namespace-specific flags.
- `packages/platform/src/ns/resolve.ts` — pure `resolvePath(state, path)` for
  `org`, `org/repo`, and `org/repo/branch` forms, returning the frozen result shapes
  or a typed not-found value; used by tests here and by E2-T07/E2-T08/E3 later — the
  single resolver, no lookalikes.
- Dispatch-door validators registered via E0-T11's extension point for the five frozen
  reason codes, reading reduced state at head for uniqueness and existence checks; the
  per-org stream mint for an accepted `ns.org.create` happens inside the same
  dispatch handling (documented, and covered by the serialization guarantee).
- `packages/platform/fixtures/ns/` — committed golden logs, **one dump file per
  stream** (`ns:root` plus each `ns:org:<org>`) per the frozen digest-composition
  rule, with sibling `*.expected.json` carrying the per-stream dump digests, the
  namespace-view digest (reduced state built by replaying `ns:root` then each
  `ns:org:<org>` in lexicographic stream-id order), and the resolved tuples for at
  least: (a) **two-orgs-shared-repo-name** — two orgs each with a project and a repo
  of the *same name* (proving uniqueness is per-org, resolution unambiguous), one repo
  `public` and one `private`, created by two different E2-T01 subjects (owners
  differ); (b) **refusal-neutral** — a valid creation sequence interleaved with one
  refused duplicate org, one refused duplicate repo, one malformed name, one reserved
  name, and one repo-create against a missing org, whose final digest equals the
  digest of the valid subsequence alone.
- `packages/platform/test/ns.test.ts` — over real HTTP through `/api/dispatch` with
  E2-T03 bearer tokens: happy-path create org → project → repo and literal-assert
  the resolved tuple including `owner` equal to the token subject and
  `repoStreamPrefix` equal to the frozen `fs:<org>/<repo>`; actor forgery (payload
  carrying `actor`/`owner`/`sub` fields) refused 422 `schema-violation`, log-neutral;
  each of the five reason codes with before/after head-offset + digest byte-equality;
  per-org uniqueness (same repo name in two orgs both accepted); resolution of an
  unknown org, an unknown repo, and a malformed (empty or slash-containing) branch
  segment returning the typed not-found value, plus the complementary literal
  assertion that a well-formed nonexistent branch segment under a known org/repo
  resolves syntactically to `fs:<org>/<repo>:<branch>:meta` (no not-found, no
  existence check); a race of ≥ 20
  concurrent same-name creates yielding exactly one accepted event per name.
- `packages/platform/test/ns.fuzz.test.ts` — seeded (seed committed): random valid
  and invalid name candidates (unicode, homoglyphs, `..`, `/`, empty, 41 chars,
  uppercase, `__x__`, trailing hyphen, null bytes), random create sequences with
  duplicate injections across ≥ 5 seeds; after each run assert zero 5xx, zero
  crashes, final view digest equal to an independent in-process model (a plain object
  applying only the accepted creates — a differential oracle, not the reducer
  checking itself), and every refused dispatch log-neutral by digest.
- `evidence/` — golden-replay digest transcripts from two separate processes
  (`e2-t06-golden-digests.txt`), the refused-duplicate before/after offset+digest
  pairs (`e2-t06-refusal-neutrality.txt`), fuzz seeds + digests (`e2-t06-fuzz.txt`),
  sensitivity transcripts (`e2-t06-sensitivity.md`), and the no-database sweep output
  (`e2-t06-no-database.txt`) plus its committed path-and-line-anchored allowlist
  (`e2-t06-no-database-allowlist.txt`).
- `Makefile`: `verify-E2-T06` per the E0-T02 target contract — golden replays (two
  processes), the full test files, refusal neutrality, the fuzz run, the sensitivity
  proof, the no-database sweep, plus re-runs of `verify-E2-T01`, `verify-E2-T03`, and
  `verify-E0-T11` (the latter proving the `ns:org:*` validator carve-out did not
  disturb the frozen stream-not-found 404 for non-ns streams) proving the extension is
  additive; nonzero exit on any failure.

## Acceptance criteria

- [ ] `make verify-E2-T06` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] Golden view digests: for both golden fixtures, every committed per-stream dump
      replays via `ef replay <dump> --digest` through the namespace reducer to a
      digest byte-identical to its committed `expected.json` value, and the
      namespace-view digest — computed per the frozen composition rule (`ns:root`
      first, then each `ns:org:<org>` in lexicographic stream-id order) — is
      byte-identical to the committed value, in two separate node processes (distinct
      pids printed; harness fails on equal pids); transcript in
      `evidence/e2-t06-golden-digests.txt`.
- [ ] Resolution is literal: for golden (a), `resolvePath` returns — asserted as exact
      values, not shapes — `repoStreamPrefix === "fs:<org>/<repo>"` for both same-named
      repos under their respective orgs, `visibility` `"public"` for one and
      `"private"` for the other, `owner` equal to each creating token's subject, the
      bare `org` form for each golden org returning the frozen `{ org, owner,
      projects, repos }` shape as a deep-equal literal (lexicographically sorted
      lists, exact project/repo names, exact visibility per repo), and
      the `org/repo/branch` form returning the branch metadata stream id under that
      prefix; unknown org, unknown repo, and a malformed (empty or slash-containing)
      branch segment each return the typed not-found value (no throw); and a
      well-formed nonexistent branch segment under a known org/repo resolves
      syntactically to `fs:<org>/<repo>:<branch>:meta` — no not-found, no
      existence check.
- [ ] Owner provenance: the accepted events' `actor.sub` equals the verified bearer
      token's subject in every test dispatch, and a dispatch whose payload smuggles
      any actor/owner/sub field is refused 422 `schema-violation` with head offset and
      dump digest byte-identical before and after.
- [ ] Refusal neutrality per reason code: for each of `ns/name-taken`,
      `ns/invalid-name`, `ns/reserved-name`, `ns/org-not-found`,
      `ns/project-not-found`, the test records head offset and `ef replay --digest`
      dump digest of the target namespace stream immediately before and after the
      refused dispatch and asserts both byte-identical — except where the refusal
      targets a stream that does not exist (the `ns/org-not-found` case, whose
      target `ns:org:<org>` was never created): there the dispatch itself is still
      the 409 `ns/org-not-found` per the E0-T11 reconciliation frozen in the Contract
      (the `ns:org:*` validator runs before the stream-existence check — not E0-T05's
      404), and the test instead asserts **both** nonexistence checks — not either:
      (1) a subsequent protocol-level GET on `ns:org:<org>` returns E0-T05's frozen
      stream-not-found 404 with its literal body, AND (2) `ns:org:<org>` is absent
      from the stream listing — AND
      that `ns:root`'s head offset and dump
      digest are byte-identical before and after — no stream minted as a side
      effect, no byte moved anywhere; each refusal is HTTP 409 with
      `error.class: 'validator-rejected'` and the exact spec-stated `error.reason`
      (literal assertions); pairs committed to
      `evidence/e2-t06-refusal-neutrality.txt`. Golden (b)'s final digest equals the
      digest of its valid subsequence alone.
- [ ] Race integrity: ≥ 20 concurrent same-name create dispatches (same scope) yield
      exactly one accepted event, and **every** losing dispatch is literal-asserted
      as HTTP 409 with `error.class: 'validator-rejected'` and `error.reason:
      'ns/name-taken'` — no other status, class, or reason for any loser, and zero
      5xx responses occur anywhere during the race; the post-race dump
      replays to a view containing exactly one entity of that name — a view or log
      with two, or a final state violating the validators' own uniqueness rule,
      fails this criterion.
- [ ] Unauthenticated `ns.*` dispatch dies at E2-T03's door: the test sends each
      creation action with no token and with a garbage token, asserts T03's typed 401
      (exact frozen body), and asserts the namespace log digest unchanged — this
      task's validators are never the first line of defense.
- [ ] Fuzz survival + differential oracle: all committed seeds complete with zero
      5xx, zero crashes/unhandled rejections, every invalid name refused with the
      predicted reason code, final view digests equal to the independent model, and
      seeds + digests committed in `evidence/e2-t06-fuzz.txt`.
- [ ] No database, provably: `verify-E2-T06` runs a committed sweep script that greps
      the task's diff and `packages/platform` for storage tells — `sqlite`, `postgres`,
      `pg`, `mysql`, `level`, `redis`, `lowdb`, `better-sqlite3`, `writeFile`/`fs.`
      writes outside the E0-T07 store and `evidence/`, and new workspace
      dependencies — and applies a **binary rule**: the sweep **exits nonzero** on any
      grep hit or new dependency not present, path-and-line-anchored (exact file:line
      for grep hits, exact package name for dependencies), on a committed allowlist at
      `evidence/e2-t06-no-database-allowlist.txt`; no free-text disposition, no
      builder judgment at run time — the allowlist itself is the reviewable artifact
      the critic audits entry by entry. The sweep's output (every hit, its file:line,
      and its allowlist match or the nonzero failure) is committed to
      `evidence/e2-t06-no-database.txt`. A sabotage step inside `verify-E2-T06`
      inserts one disallowed hit (e.g. an unallowlisted `better-sqlite3` mention in a
      swept file) in a scratch worktree and asserts the target turns red; additionally a
      restart proof: kill the server, restart on the same E0-T07 `--data-dir`, and
      assert `resolvePath` answers identically for every golden tuple — any answer
      that survives only in process memory or in a non-stream file fails this
      criterion.
- [ ] Sensitivity proof runs inside `make verify-E2-T06`: in a scratch worktree,
      (a) no-op the uniqueness validator (accept duplicates) and (b) make the door
      trust a payload-supplied owner instead of the token subject — each turns the
      suite red; transcripts committed as `evidence/e2-t06-sensitivity.md`. Any
      sabotage the target stays green on fails this criterion.
- [ ] No regression: `verify-E2-T01`, `verify-E2-T03`, and `verify-E0-T11` re-run
      green against this tree (the E0-T11 re-run proving the `ns:org:*` carve-out left
      the frozen 404 for non-ns streams intact), and all root gates pass (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build`).
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared explicitly
      per AGENTS.md, with golden view digests, refusal-neutrality pairs, and the
      no-database sweep as the stream-layer evidence currency.

## Adversarial verification

The claim under attack: "the namespace tree exists only as replayable events — creation
goes through one authenticated door, the view is a pure reduction, duplicates and
garbage never enter the log, ownership comes from the token and nowhere else, and there
is no database hiding anywhere." Use your own inputs throughout; invent at least one
more angle.

1. **The side-table hunt.** Do not trust the builder's sweep — run your own. Diff the
   task's commits and classify every new dependency, every `fs.` write, every module
   with mutable module-level state. Then the runtime probe: create a namespace tree,
   `kill -9` the server, wipe nothing, restart on the same `--data-dir`, and demand
   every `resolvePath` answer be identical; next, restart on a *copy of the stream
   store directory alone* (nothing else from the old process's filesystem footprint)
   — any resolution answer that degrades proves state lived outside the streams and
   refutes bet 4 outright. Finally replay the raw dumps with `ef replay --digest`
   from a process that never ran the server: a digest mismatch against the live view
   refutes "pure reduction."
2. **Owner forgery from every direction.** Mint two E2-T03 tokens for different
   subjects. Create an org as subject A; then attack: payload `actor` fields, payload
   `owner`, nested `actor` inside `payload.name`-adjacent objects, `__proto__`
   pollution attempting to preseed `actor`, and a raw protocol `POST /streams/ns:root`
   append of a hand-crafted event carrying `actor: { sub: B }` (per E0-T11 doctrine
   the raw door's status for reducer-backed streams is whatever E2-T03 and E0-T13
   froze — verify the doctrine holds; expected outcome at T06 time: an
   unauthenticated raw append is E2-T03's typed 401, and an authenticated raw append
   to a reducer-backed `ns:*` stream gets whatever status E0-T13 froze for the raw
   door on such streams; if the raw append lands, the forged owner in the view is a
   refutation of this task's provenance claim regardless, whoever's door leaked).
   Any accepted event whose `actor.sub` differs from the authenticated subject of the
   dispatch that created it refutes owner provenance.
3. **Duplicate races, your own concurrency.** Do not reuse the builder's race test.
   Two clients, ≥ 50 racing rounds per scope (org name, project name per org, repo
   name per org, and the cross-project repo-name case: same repo name under two
   *projects* of one org must yield one accept + one `ns/name-taken`). After every
   round, dump and replay: a log containing two live same-name entities in one scope
   — even if the view masks one — refutes the serialization guarantee; cite the two
   offsets. Also race an org-create against a repo-create into that org (repo
   dispatched before the org's accept is durable): the outcome must be either a clean
   accept-after or `ns/org-not-found`, deterministically classifiable — a repo event
   landing in a nonexistent org's stream is a refutation.
4. **Name-grammar differential.** Build your own candidate set: `A-a`, `a--b`, `-a`,
   `a-`, 40 chars (must pass), 41 chars (must fail), `main`, `__registry__`, `ns`,
   `fs`, `а` (Cyrillic), `a/b`, `a b`, `a\0b (a name containing a raw NUL byte, 0x00)`, `.`, `..`, empty string, and a
   name that is valid but equals an existing name uppercased (`FOO` vs existing
   `foo` — must fail grammar, since uppercase is outside it, not `ns/name-taken`).
   Predict each verdict and reason code before sending. Any wrong code, any accepted
   invalid name, or any refusal that moved a byte (dump-diff, and tail the stream
   live via SSE during refusals — any emitted frame refutes neutrality) is a
   refutation. Then check both enforcement sites agree: an event hand-crafted to
   bypass the validator but hit the reducer (if any such path exists) must not
   produce a reduced entity the validator would have refused.
5. **Resolution oracle, from scratch.** Write your own resolver that never imports
   `@eforest/platform`: parse the raw dumps, apply the frozen uniqueness and
   precedence rules yourself, and compare against `resolvePath` for every path in the
   goldens plus 100 fuzzed paths (unknown orgs, valid org + unknown repo, branch
   segments, trailing slashes, empty segments). Any disagreement refutes either the
   resolver or the frozen semantics — bisect which with `ef bisect` against the
   offending log prefix.
6. **Apparatus sabotage, your own.** Beyond re-running the builder's committed
   sensitivity proofs: (a) make the reducer silently drop `visibility` (default
   everything public) — `verify-E2-T06` must go red on the golden digests; (b) make
   the sweep script's grep pattern list empty — the sweep must fail loudly, not pass
   vacuously (a sweep that exits 0 on an empty pattern list refutes the no-database
   apparatus); (c) point the goldens' `expected.json` digest at the wrong value and
   confirm red. Any green run under sabotage refutes the measuring apparatus and,
   with it, every digest cited in this task.
7. **Cold-clone, unauth first.** Run the whole thing through
   `tools/verify/cold_clone.sh` with scrubbed env, and before presenting any token,
   probe every `ns.*` dispatch and the per-org stream mint path unauthenticated and
   with malformed/expired tokens: anything other than E2-T03's exact typed 401 —
   including a 409 from this task's validators, which would prove namespace
   validation runs before authentication — refutes the door ordering; any log byte
   moved refutes neutrality.

Refutation currency: a dump + offset pair where a duplicate or forged-owner event
entered the log, a resolution answer that survives a stream-store-only restart
differently than the live view, a digest pair that should match and doesn't, or an
exact HTTP transcript with the wrong status/class/reason. "Repo names should allow
uppercase" is a design note, not a finding. No refutation → promote your from-scratch
resolver comparison and your best fuzz-found name case into the committed corpus.

## Verification log

### 2026-07-19 — human resume — RUNS 1-3 authorized

- Authorization: APPROVED
- Task: E2-T06
- Stopped after run: 0
- Authorized runs: 1-3
- Scope: control-plane recovery transition and E2-T06 verification only

### 2026-07-19 — human resume — RECOVERY 2 RUNS 1-3 authorized

- Authorization: APPROVED
- Task: E2-T06
- Recovery generation: 2
- Stopped after run: 0
- Authorized runs: 1-3
- Scope: control-plane recovery transition and E2-T06 verification only
