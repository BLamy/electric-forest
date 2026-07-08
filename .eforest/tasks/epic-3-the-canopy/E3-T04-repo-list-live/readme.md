---
id: E3-T04
epic: 3
title: "Repo list and org browse on the registry derived stream: new repos appear live, private repos invisible cross-tenant"
priority: 304
status: pending
depends_on: [E3-T03]
estimate: M
capstone: false
---

## Goal

The E3-T02 web app shell (`packages/webapp`, `@eforest/webapp`; the shell's authoritative
package name and route conventions are E3-T02's) gains its first real read surfaces: the
**repo list** at `/` (the authenticated identity's repos, backed by
`GET /registry/me`) and **org browse** at `/orgs/:org` (that org's projects and repos,
backed by `GET /registry/org/:org`, public subset for non-members per the E2-T08
contract). Both pages read the E2-T08 `__registry__` derived stream **exclusively through
E3-T03's `useServerReducer`** — hydrate from the door's snapshot at its `asOf` offset,
live-tail its E0-T06 frames, client-replay through the same registry reducer
(`packages/platform/src/registry/reducer.ts`, imported, never reimplemented) — with **no
side store**: no localStorage, no IndexedDB, no module-level cache, no component state
that outlives the hook. Every row resolves the entry's org/repo names to its stream
namespace via the entry's immutable `repoStreamPrefix` and links into the E3-T05 repo
route `/orgs/:org/repos/:repo`; renames change the link text and href, never the carried
prefix. Each list region exposes the E3-T02-frozen DOM contract attributes (referred to
here as `data-ef-stream` / `data-ef-offset` / `data-ef-digest`; the authoritative
attribute names are frozen in E3-T02 and this task binds to those, not to a restatement)
naming the `__registry__` stream, the offset the hook has replayed to, and the canonical
state digest of its reduced registry state. The headline behaviors, both proven under
Playwright against the E3-T01 seed corpus inside `make verify-E3-T04`: (1) **live
appearance** — a second client, a plain node process using the E0 writer (never the
browser), dispatches `ns.repo.create` while the list is open, and the new row renders
without reload within E2-T08's frozen 2000 ms live budget, after which the region's
`data-ef-offset` equals the server's `__registry__` head fetched out-of-band and its
`data-ef-digest` equals `ef replay --digest` of the `__registry__` dump at that head; and
(2) **cross-tenant invisibility** — a second browser identity (non-member of the private
repo's org) holds the same pages open, snapshot and live, while a private repo is
created, and neither the DOM, the hook state, nor any network byte delivered to that
identity ever names the private repo. Filtering is the server's (`filterForIdentity` per
E2-T08); the client renders exactly what its doors deliver and nothing it wasn't sent.
One Replay recording covers both the appearance and the absence with zero console errors.

## Context

ROADMAP.md, "Epic 3 — the-canopy": the React app on server-side redux hooks begins with
"repo list". This is the first task where E2-T08's promise — "every list view names the
derived stream or reducer it reads" — is cashed in a browser: the repo list IS the
registry derived stream, rendered. It is also the first task where the tenancy boundary
built in Epic 2 faces a browser adversary, so the cross-tenant probe here is not a
formality — a private-repo byte reaching a non-member's network tab refutes E2-T08's
filter as deployed, not just this page.

Builds on: **E3-T03** (the `useServerReducer` hook — hydration at an offset from
`/state`-shaped doors, live tail of `/events`-shaped frames, client replay to digest
parity with the server head; this task adds zero hook mechanics and consumes the hook's
frozen API as-is — any gap discovered here is a finding against E3-T03), **E3-T02** (the
authenticated shell, the browser-verify Playwright harness, and the frozen DOM
offset/digest exposure contract this task's regions implement), **E3-T01** (the
deterministic seed corpus with golden per-stream digests — the corpus must include at
least two orgs, mixed public/private repos owned by two distinct E2-T01 identities, and
one renamed repo, so this page has something worth asserting; both reached transitively
through E3-T03's dependency closure), **E2-T08** (the `__registry__` derived stream, the
three read doors with `asOf` + sorted `entries` + immutable `repoStreamPrefix`, the
identity-filtered live frames, and the 2000 ms live budget — all consumed, none
redefined), and **E2-T04** (the web session whose identity the doors filter by).

Contract notes, binding here:

- **The page state is the hook state.** The registry reducer is imported from
  `@eforest/platform` and registered client-side for `useServerReducer`'s replay; there
  is no second reducer, no client-side re-sort beyond the door's frozen `(org, repo)`
  order, and no client-side visibility filtering — a client that filters is a client
  that received what it shouldn't have.
- **`repoStreamPrefix` is the join key** between the registry listing world and the
  stream world every later E3 task lives in (E3-T05 repo home, E3-T06 tree). Row links
  carry it (e.g. serialized into the route state or re-derived from the entry at
  navigation); a rename changes `repo` and the href, never the prefix.
- Non-goals: repo home content (E3-T05), any `fs:` stream reads (E3-T06+), pagination or
  search (the contract is the full filtered list, per E2-T08), public unauthenticated
  browse pages beyond what `/orgs/:org` already answers for anonymous (rendering the
  public subset for a logged-out session is in scope only as far as the door already
  provides it), and any new server endpoint — this task adds **zero server surface**.

## Deliverables

- `packages/webapp/src/routes/RepoList.tsx` — `/`: the authenticated identity's repos
  via `useServerReducer` over `GET /registry/me` (snapshot + live), rows sorted as
  delivered, each row `data-testid="repo-row"` with org, repo name, visibility, and a
  link to `/orgs/:org/repos/:repo`; the list region carrying the E3-T02 DOM contract
  attributes for the `__registry__` stream.
- `packages/webapp/src/routes/OrgBrowse.tsx` — `/orgs/:org`: that org's
  projects/repos via `GET /registry/org/:org`, same row shape, same region attributes;
  renders the door's answer for whatever identity the session has (member: full;
  non-member/anonymous: public subset) with **no client-side branching on membership**.
- `packages/webapp/src/registry/useRegistry.ts` — the one thin binding of
  `useServerReducer` to the registry doors + imported registry reducer, shared by both
  routes; no other module in the webapp touches registry data.
- `packages/webapp/test/repo-list.spec.ts` — the Playwright suite (E3-T02 harness):
  seed-corpus rendering vs goldens per identity, the live-appearance run with the
  second-client node dispatcher, the cross-tenant probe with a second browser context
  and full network capture, zero-console-error assertions throughout.
- `tools/verify/e3-t04/second-client.ts` (or equivalent under the task's verify
  recipe) — the node-side dispatcher that performs the live `ns.repo.create` (public,
  for appearance) and the private creation (for the absence probe) through the E0-T11
  dispatch door with an E2-T05 token, printing dispatch-accept timestamps and the
  resulting `__registry__` offsets for the transcripts.
- `evidence/` — `e3-t04-render-parity.txt` (per-identity rendered rows vs committed
  goldens, plus the region digest vs `ef replay --digest` of the `__registry__` dump),
  `e3-t04-live-appearance.txt` (dispatch-accept and row-appearance timestamps, the DOM
  offset, the out-of-band server head, the dump digest), `e3-t04-cross-tenant.txt`
  (identity B's complete captured network log for the probe window with the grep result
  for the private repo's name and prefix — zero hits — plus the window-discipline
  timestamps), `e3-t04-no-side-store.txt` (the sweep + reload-behavior transcript), and
  `e3-t04-sensitivity.md`.
- `Makefile`: `verify-E3-T04` per the E0-T02 target contract — boots the platform
  server on a fresh data dir, runs the E3-T01 seed, builds the webapp, runs the
  Playwright suite (under `tools/replay/record-run.sh -o e3-t04-final` for the final
  recorded pass), then the digest/offset verdict phase; nonzero exit on any failure.

## Acceptance criteria

- [ ] `make verify-E3-T04` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, zero `SKIPPED:` lines, against a data dir created by the run
      (seed corpus dispatched in-run, nothing reused from development).
- [ ] Render parity on the seed corpus: for each corpus identity (at minimum: an owner,
      an org member, a non-member, and anonymous on `/orgs/:org`), the rendered rows
      literal-equal the committed E3-T01/E2-T08 filtered-listing golden for that
      identity (same entries, same `(org, repo)` order), and the list region's
      `data-ef-digest` equals both (a) the committed golden registry digest and (b)
      `ef replay --digest` over the `__registry__` dump taken at the region's
      `data-ef-offset`. Transcript in `evidence/e3-t04-render-parity.txt`.
- [ ] Live appearance without reload: with `/` open and hydrated for an authorized
      identity, the node second client dispatches `ns.repo.create`; Playwright asserts
      the new `repo-row` renders within 2000 ms of dispatch-accept **with zero page
      reloads and zero re-navigations** (navigation count asserted), and afterward the
      region's `data-ef-offset` equals the server's `__registry__` head fetched
      out-of-band and its `data-ef-digest` equals the dump digest at that head.
      Timestamps, offsets, and digests in `evidence/e3-t04-live-appearance.txt`.
- [ ] The appearance rode the tail, not a refetch: the captured network log for the
      appearance window contains no second snapshot request after hydration — the new
      row is attributable to a live frame (frame and its `__registry__` offset quoted
      in the transcript). A row that appears via a re-issued snapshot fetch fails this
      criterion.
- [ ] Cross-tenant invisibility, snapshot and live: a second browser context
      authenticated as a non-member identity B holds `/` and `/orgs/:org` open while
      identity A creates a **private** repo in that org. Window discipline per E2-T08:
      B's tail stays connected until after A's own open list has rendered the new row
      (≥ 2000 ms past dispatch-accept), and at that instant (a) B's DOM contains no row
      for it, (b) B's hook state (evaluated in-page) contains no entry for it, and
      (c) B's complete captured network traffic for the window — every response body
      and every live frame — contains zero occurrences of the private repo's name and
      of its `repoStreamPrefix`. Full capture and grep result committed in
      `evidence/e3-t04-cross-tenant.txt`. One matching byte fails this criterion.
- [ ] No side store: the committed sweep greps the task's diff for `localStorage`,
      `sessionStorage`, `indexedDB`, service-worker registration, and module-level
      mutable caches of registry entries, exiting nonzero on any unwaived hit; and the
      behavioral proof — after building list state, a hard reload with the server
      stopped renders no rows (loading/error state, not stale entries), and a reload
      with the server up rehydrates to the same digest. Transcript in
      `evidence/e3-t04-no-side-store.txt`.
- [ ] Row links resolve and survive rename: every rendered row's href is the E3-T05
      route for its `(org, repo)`; for the corpus's renamed repo the row shows the new
      name, links via the new name, and the entry's `repoStreamPrefix` (asserted from
      hook state in-page) is byte-identical to its committed creation-time value.
- [ ] One Replay recording (`tools/replay/record-run.sh -o e3-t04-final`) contains both
      headline behaviors — the live appearance in A's session and the absence in B's —
      with zero console errors and zero uncaught exceptions anywhere in the recording;
      URL plus point/time anchors at (a) A's hydration, (b) the live frame arriving,
      (c) the new row rendered with the head-equal offset, (d) B's list at the
      probe-window close, cited in the Verification log.
- [ ] Sensitivity proof inside `make verify-E3-T04`: in a scratch worktree, (a) make
      the client tail silently drop `registry.repo-added` frames — the live-appearance
      criterion goes red; (b) make the region publish a stale `data-ef-offset` (head−1)
      — the offset-equality assertion goes red; (c) point the rendered list at an
      unfiltered door response (bypass `filterForIdentity` in a sabotaged server build)
      — the cross-tenant network grep goes red; (d) reintroduce a module-level entry
      cache — the sweep or the stopped-server reload probe goes red. Any sabotage the
      suite stays green on fails this criterion; transcripts in
      `evidence/e3-t04-sensitivity.md`.
- [ ] No regression: `verify-E3-T02` and `verify-E3-T03` re-run green against this
      tree, and all root gates pass (`pnpm format:check && pnpm lint && pnpm typecheck
      && pnpm test && pnpm build`).

## Adversarial verification

The claim under attack: "the repo list is the registry derived stream rendered through
`useServerReducer` — nothing else feeds it, it follows the stream live to the server's
head, and no identity's browser is ever sent a private repo it may not see." Use your
own identities, repo names, and timings throughout; invent at least one more angle.

1. **Leak hunt at the wire, crueler than the builder's.** Run your own probe: multiple
   non-member identities plus an anonymous context, all holding `/orgs/:org` open in
   both live modes, while you drive a burst of private creations, private→public→private
   flips, and renames of private repos from a member identity. Capture every response
   body and every frame each context receives and grep for every private name and
   prefix you used — including *transient* appearances mid-flip and names leaked
   through rename frames. One byte naming a private entry in a non-member's capture
   refutes; cite the frame and its offset. Also evaluate the hook state in-page: an
   entry present in client memory but hidden by rendering refutes just as hard as a
   rendered row.
2. **Side-store hunt.** Beyond re-running the committed sweep: build list state, then
   (a) hard-reload with the server killed — any row rendered refutes "no side store";
   (b) restart the server on a copy of the stream-store directory alone and demand the
   page rehydrate to the identical digest; (c) inspect the built bundle (not just the
   diff) for storage APIs the sweep's grep of source might miss; (d) open a second tab
   and check the two tabs share nothing except the server — a BroadcastChannel or
   shared worker ferrying entries between tabs is a side store.
3. **Tail honesty.** The live appearance must be event-machine behavior, not polling
   theater. In the recording (Replay MCP) and in your own re-run: after hydration,
   block or delay all snapshot-shaped requests at the network layer and dispatch a
   create — the row must still appear via the tail. Then inspect the appearance moment:
   the frame's `__registry__` offset must equal the offset the region publishes and the
   server head. A page that quietly refetches the snapshot on a timer, or a DOM offset
   that trails the head after the row rendered, refutes.
4. **Offset/digest currency audit.** Race it: fire N rapid creates from your node
   client and, when the list settles, demand `data-ef-offset` equal the true head (not
   head minus stragglers) and `data-ef-digest` equal `ef replay --digest` of the dump
   at that offset — recompute the digest yourself, never trust the page's. Then
   sabotage: mutate one rendered row's text via injected script and confirm the
   harness's parity assertion is against hook-state/digest, not a screenshot — a
   parity check that still passes with a vandalized DOM row is measuring nothing;
   conversely a digest that recomputes green while the DOM shows a row the state lacks
   refutes the exposure contract.
5. **Reducer duplication and re-sort hunt.** Diff audit: any second implementation of
   registry reduction, filtering, or sorting in the webapp (a re-sort, a `filter(...)`
   on visibility, a hand-rolled entry merge) refutes the "renders exactly what the
   doors deliver" clause — find it by making the server door return a deliberately
   odd-but-valid ordering in a scratch build and checking whether the page "fixes" it.
6. **Rename adversary.** With the list open live, rename a repo a→b→a from your node
   client: the row's name and href must track each frame, `repoStreamPrefix` must never
   change (assert in-page after each hop), and no ghost row (old name lingering
   alongside new) may exist at any settle point. A stale href 404ing into E3-T05's
   route, or a prefix that followed the rename, refutes the join-key contract.
7. **Apparatus sabotage, your own.** Re-run the committed sensitivity proofs, then add:
   (a) make the cross-tenant grep search for the wrong string — the harness must fail
   its own self-check, not pass vacuously (confirm the grep is anchored to the exact
   name/prefix the probe created, quoted in the transcript); (b) shrink the probe
   window so B disconnects before A's row renders — the window-discipline assertion
   must go red. Any green run under sabotage refutes the measuring apparatus and every
   transcript cited here.
8. **Cold-clone, poisoned.** `tools/verify/cold_clone.sh verify-E3-T04` with scrubbed
   env, then again with a warm dev server on likely ports and a browser-profile
   directory planted with a logged-in session — the run must build its own world (paths
   printed) and the recording must show the login interaction executing, not inherited
   auth. Works-only-warm refutes.

Refutation currency: a captured frame or response body carrying a private entry to a
non-member (byte-quoted, offset-cited), a DOM `data-ef-offset` unequal to the server
head after settle, a digest pair that should match and doesn't, a row rendered from a
killed server, a Replay point link contradicting a claim, or a diff hunk reimplementing
the reducer/filter/sort. "The list should paginate" is a design note, not a finding. No
refutation → promote your leak-hunt burst script and your rename-adversary sequence into
the committed suite.

## Verification log

(appended over time by builders and critics)
