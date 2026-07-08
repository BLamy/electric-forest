---
id: E3-T02
epic: 3
title: "Web app shell: authenticated React app served by the platform, browser-verify harness wired, DOM offset/digest exposure contract frozen"
priority: 302
status: pending
depends_on: [E2]
estimate: M
capstone: false
---

## Goal

`apps/web` (`@eforest/web`) exists in the pnpm workspace: a Vite-built React app whose
production bundle is served by `packages/platform` (`@eforest/platform`) — the same
process that owns E2's auth doors, so there is exactly one origin and zero CORS. An
unauthenticated `GET` of any app route (`/`, `/:org`, `/:org/:repo`) answers with a
302 into E2-T04's `/auth/login`, travels the emulated-Auth0 authorization-code+PKCE
flow, and lands back on the app authenticated via the `ef_session` cookie — no second
login system, no client-side token handling, the cookie stays HttpOnly and the app
never sees a JWT. Authenticated, the shell renders: client-side routing for `/`,
`/:org`, and `/:org/:repo` (route components may be placeholders — E3-T04/T05 fill
them — but the router, layout chrome, and 404 route are real), and the signed-in
identity (`sub` + email) read from the platform's session-backed reduced identity view
via `GET /api/whoami` (a thin JSON door added here: the E2-T01 authorization view's
user record for the cookie's session, plus the identity stream's name, the offset the
view was reduced to, and its `stateDigest` — never claims from a token). **Frozen
here, for every future E3 view:** the DOM exposure contract — any DOM region that
renders stream-derived state carries `data-ef-stream` (the stream name it reduced),
`data-ef-offset` (the offset it has replayed/hydrated to), and `data-ef-digest`
(`stateDigest` from `@eforest/protocol` over the reduced state at that offset) on the
region's root element; the shell's identity region is the first conforming instance,
carrying the identity stream's triple from `/api/whoami`. Also standing after this
task: the **browser-verify harness** — `@eforest/browser-verify`
(`packages/browser-verify`), a Playwright-based library that cold-boots the stream
server + platform + built app on ephemeral ports and fresh data dirs, drives the
emulator login as a named test subject, fails on **any** console error or uncaught
exception anywhere in the run, and exposes `collectEfRegions(page)` returning every
`[data-ef-stream]` region's attribute triple for out-of-band comparison against the
server — wired as `make verify-E3-shell`, green from a cold clone, and the gate every
later E3 task's Playwright evidence builds on.

## Context

Epic 3 is the web app, and this task is where the browser becomes a first-class,
*instrumented* citizen: before any real view exists, we freeze how a view must prove
itself. The capstone (the-reading-room, E3-T10) claims "DOM exposes the stream offset
it has replayed to and it matches the server's head" — that claim needs a uniform,
machine-readable place to live (`data-ef-stream` / `data-ef-offset` /
`data-ef-digest`) and a standing apparatus that reads it (`@eforest/browser-verify`).
E2-T04 already planted the seed (`data-identity-offset` / `data-identity-digest` on
the server-rendered login page); this task generalizes that idea into the frozen,
stream-named triple every React view will carry, and moves the identity display from
the platform's server-rendered page into the SPA shell without changing a single
identity fact's source of truth (the reduced view, never the token).

Builds on: E2-T04 (the login flow, `ef_session` cookie, and session-validity-by-replay
this shell sits behind — this task adds **no** auth code, no new identity event types,
and no cookie changes; the app is a static bundle plus one read-only JSON door),
E2-T02 (the emulator the harness logs in through, from a cold clone), E2-T07 (the
platform enforces per-stream authorization on the doors `/api/whoami` fronts), E2-T12
(the Playwright + Replay pattern the harness industrializes). Unblocks: every other
E3 task — E3-T03's `useServerReducer` hooks will populate the triple on live regions,
E3-T04..T09 each add regions the harness must find conformant, and E3-T10 asserts
offset-equals-head through `collectEfRegions`. Deliberately **not** dependent on
E3-T01 (the deterministic browse corpus): the shell needs a logged-in user, not a
seeded forest, so the two tasks can be worked in either order.

Contracts frozen here (versioned in `apps/web/README.md`; changing any of them later
invalidates every E3 task's golden evidence and requires a queue-visible revision):

- **DOM exposure**: every stream-backed region's root element carries all three of
  `data-ef-stream`, `data-ef-offset`, `data-ef-digest`; the offset is the exact offset
  the rendered state was reduced to (as a decimal string), the digest is
  `stateDigest` over that reduced state, and the triple must be *internally
  consistent* — a region may lag the server head (live tail is E3-T03's job) but its
  digest must always be the digest *of* its stated offset's state. Partial triples
  are contract violations, not degraded modes.
- **Serving**: the platform serves the built app with SPA fallback (unknown non-`/api`
  paths get `index.html` when authenticated, 302 to login when not); `/api/*` and
  `/auth/*` never fall back.
- **Harness**: `@eforest/browser-verify`'s exported surface — `bootWorld()` (fresh
  data dir, ephemeral ports, returns URLs + a handle to dispatch/dump streams
  out-of-band), `loginAs(page, subject)`, `collectEfRegions(page)`, and the
  zero-console-error invariant that is on by default and cannot be silenced per-test
  without a string reason that appears in the transcript.

Non-goals: any real data view (repo list is E3-T04, repo home E3-T05, tree E3-T06,
viewer E3-T07), live tailing or the hooks themselves (E3-T03 — the shell's identity
region may hydrate once from `/api/whoami` and stay static), styling beyond a legible
layout, and the seed corpus (E3-T01).

## Deliverables

- `apps/web/` — `@eforest/web`: Vite + React + TypeScript, in the workspace, wired
  into root `pnpm build` / `lint` / `typecheck` / `format:check`.
- `apps/web/src/routes.tsx` — client-side router for `/`, `/:org`, `/:org/:repo`,
  and a 404 route; layout chrome with the identity region and a logout control that
  hits E2-T04's `POST /auth/logout`.
- `apps/web/src/identity.tsx` — the identity region: fetches `/api/whoami` once,
  renders `sub` + email from the reduced view, and stamps
  `data-ef-stream`/`data-ef-offset`/`data-ef-digest` from the response onto its root
  element — the first conforming instance of the frozen contract.
- `packages/platform/src/web/spa.ts` — static serving of `apps/web/dist` with the
  SPA fallback + auth-gate rule above (unauthenticated app routes 302 to
  `/auth/login`; `/api/*` unauthenticated gets a typed 401, never a redirect, never
  HTML).
- `packages/platform/src/api/whoami.ts` — `GET /api/whoami`: for a valid session,
  `{ user: { sub, email }, stream, offset, digest }` where `offset` is the identity
  stream offset the view was reduced to and `digest` is `stateDigest` of that view;
  invalid/absent session → typed 401 `{ error: { class: 'auth-refused' } }`,
  log-neutral.
- `packages/browser-verify/` — `@eforest/browser-verify`: `bootWorld()`,
  `loginAs()`, `collectEfRegions()`, the default-on console-error tripwire
  (`console.error`, `pageerror`, and failed same-origin requests all fail the run),
  and a README documenting the exported surface as frozen.
- `apps/web/test/shell.pw.ts` — the shell suite on the harness: unauthenticated
  redirect; full login-to-shell; identity region triple verified out-of-band
  (`offset` equals an independent `GET` of the identity stream's head at that moment,
  `digest` equals `ef replay --digest --reducer` over an independent dump truncated
  to that offset — literal string equality); client-side navigation across all
  routes + browser back/forward with zero full-page reloads (asserted by a
  navigation-lifecycle probe, not eyeballs); deep-link to `/:org/:repo` while
  authenticated renders the shell (SPA fallback), while unauthenticated 302s to
  login; logout returns to logged-out; zero console errors across everything.
- `Makefile`: `verify-E3-shell` — builds `apps/web`, runs the shell suite through
  the harness on a fresh data dir; joins `verify-all`. Later E3 tasks add suites to
  this same gate rather than inventing parallel ones.
- `evidence/` — `e3-t02-shell-playwright.txt` (full transcript incl. both
  out-of-band equality assertions and the redirect/401 checks),
  `e3-t02-whoami-neutrality.txt` (before/after identity-stream head-offset +
  event-count + digest triples for unauthenticated and forged-cookie `/api/whoami`
  probes), `e3-t02-sensitivity.md` (sabotage transcripts: injected console error,
  hardcoded offset, hardcoded digest — each turning the harness red, with the exact
  failing assertion quoted). The Replay recording of the login-to-shell walkthrough
  (`tools/replay/record-run.sh -o e3-t02-final`) — login through the emulator form,
  shell with the session user visible and the identity triple in the DOM, route
  navigation, logout — is cited by URL in the Verification log; if
  `tools/replay/preflight.sh` fails, declare `Replay: N/A (<reason>) + mitigation`
  per AGENTS.md.

## Acceptance criteria

- [ ] `make verify-E3-shell` exits 0 from a cold clone via
      `tools/verify/cold_clone.sh` with scrubbed env — emulator only, loopback only,
      fresh data dir, ephemeral ports (two concurrent harness runs on one machine do
      not collide).
- [ ] The gate is auth, not obscurity: with a fresh browser context (no cookie),
      `GET /`, `/:org`, and `/:org/:repo` each 302 into `/auth/login`, and
      unauthenticated `GET /api/whoami` returns the typed 401 JSON body — never the
      app bundle, never HTML, never a redirect — with the identity stream's
      head-offset + event-count + view-digest triple byte-identical before and after
      the probes (`evidence/e3-t02-whoami-neutrality.txt`).
- [ ] Login lands the shell: the harness drives E2-T04's flow through the emulator
      as a named subject and arrives on `/` with the identity region showing that
      subject's `sub` + email sourced from `/api/whoami` (the test asserts the
      rendered values equal the reduced view's record fetched out-of-band, not the
      emulator profile) — transcript in `evidence/e3-t02-shell-playwright.txt`.
- [ ] The triple is the stream's truth: `collectEfRegions(page)` on the shell finds
      exactly one region, `data-ef-stream` names the identity stream,
      `data-ef-offset` equals an independent HTTP fetch of that stream's head at
      assert time, and `data-ef-digest` equals `ef replay --digest --reducer` over an
      independent dump of that stream truncated to that offset — literal string
      equality on all three, in the committed transcript.
- [ ] No partial triples anywhere: the harness sweeps the full DOM for elements
      carrying any of the three attributes and fails if any element carries a strict
      subset — enforced as a standing harness invariant, not a shell-specific
      assertion.
- [ ] The SPA is an SPA: navigating `/` → `/:org` → `/:org/:repo` → back → forward
      triggers zero full document loads after the initial one (navigation-lifecycle
      probe asserted in the suite), the 404 route renders for an unknown path, and
      an authenticated deep-link `GET /:org/:repo` (fresh tab, existing cookie)
      serves `index.html` and renders the shell at that route.
- [ ] Zero console errors, and the tripwire is default-on: the entire suite —
      redirects, login, navigation, logout — records no console errors, no uncaught
      exceptions, and no failed same-origin requests; grepping the suite shows no
      per-test silencing of the tripwire.
- [ ] Sensitivity, three ways: in a scratch worktree, (a) an injected
      `console.error` in the shell's mount path, (b) `data-ef-offset` hardcoded to a
      stale value, and (c) `data-ef-digest` hardcoded to a plausible-looking hash
      each independently turn `make verify-E3-shell` red, with the failing assertion
      captured in `evidence/e3-t02-sensitivity.md`; the unmodified tree re-runs
      green.
- [ ] The app never holds a credential: the built bundle and the suite's recorded
      network traffic contain no JWT, no `code_verifier`, and no session id outside
      the HttpOnly cookie (asserted by scanning `apps/web/dist` and the har/network
      log in the test, not by review); `document.cookie` in the app context does not
      expose `ef_session`.
- [ ] Harness surface frozen and reused-by-construction: `@eforest/browser-verify`'s
      README documents `bootWorld`/`loginAs`/`collectEfRegions` as the frozen
      surface, and `apps/web/test/shell.pw.ts` imports the harness rather than
      booting servers inline (`git grep` shows no server-spawn code in the suite
      itself).
- [ ] Replay (browser layer): a Replay recording of the full login-to-shell
      walkthrough — emulator form, shell with the session user and the identity
      triple visible in the DOM, route navigation, logout — is cited by URL in the
      Verification log, or the AGENTS.md fallback is declared loudly.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0, and `make verify-E2-T04` and `verify-E2-T12`
      re-run green on this tree (the shell changed the platform's web surface; E2's
      claims must survive it).

## Adversarial verification

The claim under attack: "the app lives behind E2's gates with no second auth path,
the DOM triple is the stream's truth and not decoration, and the harness is a real
tripwire that later E3 tasks can trust." Boot your own world with
`@eforest/browser-verify`, use your own subjects and dumps. Invent at least one more
angle.

1. **Walk around the gate.** Enumerate paths, not just the three routes: static
   asset URLs under the app's mount, `index.html` directly, `/api/whoami` with no
   cookie / a forged cookie (valid HMAC + fabricated session id, per E2-T04's angle
   5) / an ended session's cookie, a deep link with a mangled cookie, and any
   Vite-emitted file that might be served pre-auth. Any response that leaks the
   authenticated shell, the reduced view's data, or a non-typed error refutes the
   gate; any of these probes appending anything to any stream (diff the raw dump)
   refutes log-neutrality.
2. **Interrogate the triple like a prosecutor.** At the logged-in point (live or
   through the Replay MCP on the cited recording), read the identity region's three
   attributes; independently fetch the stream head and compute `ef replay --digest`
   over your own dump truncated to the stated offset. All must agree. Then dispatch
   a fresh identity event out-of-band (harness `bootWorld` hands you the dispatch
   door), reload, and demand the triple move to the new truth; a stale or unchanged
   offset/digest after the reload refutes it. Finally check internal consistency the
   cheap fake breaks: force the region to render at a non-head offset if you can
   contrive one — a digest that matches head-state while the offset says otherwise
   proves the digest is not computed from the stated offset's state.
3. **Sabotage the measuring apparatus yourself.** Do not trust
   `e3-t02-sensitivity.md` — reproduce it: in a scratch worktree, inject a console
   error in a *lazy-loaded* route component (not the mount path the builder chose),
   hardcode each attribute separately, and additionally make `/api/whoami` return a
   digest of the *wrong* stream's state. `make verify-E3-shell` must go red for each,
   with the failure naming the violated assertion; any green run refutes the harness
   as the standing gate every later E3 task plans to lean on.
4. **Hunt the second auth path.** Read `apps/web/src` and the built bundle for any
   token handling, any `Authorization` header construction, any localStorage/
   sessionStorage/IndexedDB writes of identity material, any non-HttpOnly cookie.
   Record the suite's network traffic yourself and grep it for JWT-shaped strings
   and the session id. Then attack the seam: call `POST /auth/logout` from the app's
   fetch context with a forged body, and hit `/api/whoami` cross-origin from a
   scratch page — a CORS grant or a state-changing GET is a finding.
5. **Break the SPA fallback.** Authenticated: request `/api/nonexistent`,
   `/auth/nonexistent`, a path with encoded traversal (`/%2e%2e/`,
   `/..%2fpackage.json`), an org route whose segment is `api` or `auth`, and an
   asset path that shadows an API route. The fallback must never serve `index.html`
   for `/api/*` or `/auth/*`, must never serve files outside `apps/web/dist`, and a
   traversal that reads anything outside the dist dir refutes the serving contract
   outright.
6. **Fuzz the one new door.** ≥ 200 malformed requests at `/api/whoami`: mangled
   `ef_session` bytes, oversized cookies, absurd headers, method confusion (POST,
   OPTIONS, HEAD). Every response is the typed 401/405 JSON, zero 5xx, zero uncaught
   exceptions in the platform log, and the identity stream's head-offset +
   event-count + digest triple is byte-identical before and after the run (dump
   diff) — the same currency E2 refusals trade in.
7. **Cold-start and collision honesty.** Run `make verify-E3-shell` through
   `tools/verify/cold_clone.sh` with env scrubbed and the network observed — any
   non-loopback reach refutes the cold-clone claim. Run two harness worlds
   concurrently — a port or data-dir collision refutes `bootWorld`'s isolation, which
   E3-T10's cold-start capstone depends on. Then re-run `make verify-E2-T04` and
   `verify-E2-T12` yourself: the SPA mount rearranged the platform's routes, and a
   quietly broken E2 gate is exactly the regression this task is positioned to
   cause.
8. **Confirm the recording tells the claimed story.** Through the Replay MCP,
   verify the cited recording actually contains: the emulator login form, the shell
   with the subject's identity rendered, the triple present in the DOM at a point
   where you can cross-check the offset against the transcript's out-of-band value,
   and the logout. A recording missing a claimed scene, or showing a console error
   the transcript doesn't, fails sufficiency.

Refutation currency: a URL that renders authenticated content without a valid
session, a triple attribute that disagrees with an independent replay of its stated
stream and offset, a sabotage that leaves the harness green, a credential found in
the bundle/storage/wire, a 5xx or an appended event from a probe, or an E2 verify
target that no longer passes. "The shell is sparse" is by design, not a finding.

## Verification log
