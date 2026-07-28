---
id: E3-T02
epic: 3
title: "Web app shell: authenticated React app served by the platform, browser-verify harness wired, DOM offset/digest exposure contract frozen"
priority: 302
status: implemented
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
E3 task — E3-T03's `useStreamReducer` hooks will populate the triple on live regions,
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

### 2026-07-27 — builder — CLAIM: implemented

- Candidate: `b33332173f640faf113a3f0ace0d18677b7f513a`, based exactly on verified
  E3-T01 `815cc2c75343164bcd803552c203ad0a316cacb4`. Lifecycle commit:
  `6462944`.
- Exact-head gates: `make verify-E3-T02`, `make verify-E2-T04`, and
  `make verify-E2-T12` all exited 0. The registered E3 target ran format, lint,
  typecheck, all 34 root test files / 413 tests, production builds, the pinned
  emulator checks, the browser shell proof, the sensitivity-spine check,
  self-check, and task-board listing, ending `verify-E3-T02: OK`. The E2
  regressions ended `verify-E2-T04: OK` and `verify-E2-T12: OK`; the latter
  re-earned the no-database sweep (`violations=0`), both detector expected-red
  probes, the eight-sabotage E2-T08 matrix, and the seven-operation E2-T10 route
  inventory including `/api/whoami`.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T02` cloned exact candidate
  `b33332173f640faf113a3f0ace0d18677b7f513a`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated dependencies from the
  lockfile-verified pnpm store, scrubbed the environment, repeated all 413 tests
  and the complete shell verifier, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Stream evidence:
  `evidence/e3-t02-shell-playwright.txt` and
  `evidence/e3-t02-whoami-neutrality.txt`. The fresh shell run exposed exactly
  one complete region:
  `stream=__identity__`,
  `offset=0000000000000000_0000000000000370`,
  `digest=7ccf4d7ccc97cf5584fe3a77064e8f2206075708282c1b6344a52206dcf6dd2a`.
  The offset equaled an independent official-stream head read and the digest
  equaled an independent `ef replay --digest --reducer` result using
  `packages/identity/reducer.mjs`. Absent and forged-session `/api/whoami`
  requests returned the typed 401 while the before/after empty identity stream
  remained byte-identical at offset `...0000`, count `0`, and digest
  `d7d5719bb372d21f2b5ead4baf8c7a45efb148254cdb7322af57c81f645ac2ad`.
- Browser proof: the shell transcript records two collision-free worlds,
  authentication of `auth0|ada-shell`, asset and deep-link gating, a complete
  DOM triple with no partial regions, home/org/repo/back/forward/404 navigation
  with one document load, credential scans with zero JWT/verifier/session
  findings, logout, and
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
- Sensitivity: `evidence/e3-t02-sensitivity.md` records three independent
  disposable-worktree runs of the public `make verify-E3-shell` command.
  Injecting a mount-path `console.error`, replacing the DOM offset with
  `...0000`, and replacing the DOM digest with a plausible 64-hex value each
  turned the gate red at the intended assertion; the restored tree re-ran
  green. The E2 compatibility repairs are also sensitivity-backed: the complete
  eight-mutation E2-T08 apparatus and all five E2-T10 attacks re-ran green /
  expected-red on the final candidate.
- Replay:
  https://app.replay.io/recording/cf01688c-056b-4fe6-ac03-cc4d547f1e08 .
  The same Replay Chromium session produced local
  `recordings/e3-t02-final.mp4` (H.264/yuv420p, 1280x720, 30 fps, 11.7 s,
  153740 bytes; SHA-256
  `c1e039a042fb940f92b0de2476e8ad2422b8262592d5bc383b111d95678e7abd`).
  Its walkthrough covers emulator login, the identity stream truth
  (`auth0|ada-replay`, `ada.replay@canopy.test`, stream `__identity__`, offset
  `...0373`, digest
  `28e690d669cd35cffedb6cf7b826ed3b6018b2ebcdd1ea6a7abc253e2c7913d0`),
  client-side route navigation, and logout. Replay MCP interrogation found a
  263-second timeline, zero console errors/warnings, 19 requests with zero
  failed or slow requests, all loopback and 2xx, plus source-execution hits for
  `/api/whoami`, the triple render, `pushState`, `popstate`, and `/auth/logout`.
  The MP4 stayed local; only Replay recording data was uploaded.

### 2026-07-27 — judge round 1 — VERDICT: refuted

- P1 production serving is not wired through the shipped platform runtime.
  Predicted `createPlatformProductionRuntime(..., { webRoot })` would put an
  unauthenticated `GET /` behind the SPA gate and return `302 /auth/login`.
  Observed a direct candidate-runtime probe return the legacy server-rendered home
  as `200 text/html`. `packages/platform/src/production.ts:130-153` passes
  `webRoot` to `PlatformGateway` but omits it from `new PlatformWebApp(...)`, while
  `packages/platform/src/bin.ts:13` supplies no app root. The green browser harness
  bypasses that production seam by injecting `webRoot` directly into
  `PlatformWebApp` at `packages/browser-verify/src/index.ts:264-276`. Demand: wire
  the built app root into the actual production app/bin configuration and make the
  browser proof boot that shipped topology.
- P2 the credential-wire scan cannot observe the fields it claims to clear.
  Predicted the recorded network evidence could detect a JWT, `code_verifier`, or
  session identifier outside the allowed HttpOnly-cookie channel. Observed
  `packages/browser-verify/src/index.ts:310-337` retain only method, origin,
  pathname, and status; query strings, request headers and bodies, and response
  headers and bodies are discarded before `apps/web/test/shell.pw.ts:229-235`
  scans the lossy lines. Demand: capture and scan the relevant wire fields with an
  explicit HttpOnly `Cookie`/`Set-Cookie` exception, and add a sensitivity mutation
  that leaks a credential through one of those fields.
- P1 coverage is insufficient for the production-runtime hunk. Predicted the
  recording and standing browser gate would execute the same composition the
  platform binary ships. Observed both `packages/platform/test/spa.test.ts:17-44`
  and `packages/browser-verify/src/index.ts:264-278` construct
  `PlatformWebApp` directly, so the erroneous production wiring never executes.
  Demand: exercise the production runtime/bin path and map every changed browser
  hunk to execution, a concrete waiver, or deletion.
- Replay critic — `VERDICT: needs_evidence` — P1 PKCE coverage is insufficient.
  The recording shows the emulator login form but does not expose an asserted
  `code_challenge`/method followed by authorization-code redemption among its 19
  requests at the
  [login start](https://app.replay.io/recording/cf01688c-056b-4fe6-ac03-cc4d547f1e08?point=324518553662932344022923355357196&time=275.352492370295).
  Demand: record and assert the PKCE challenge/redemption sequence without exposing
  the verifier secret.
- Replay critic — P2 independent digest parity is insufficient. The DOM and
  `/api/whoami` show the same
  `28e690d669cd35cffedb6cf7b826ed3b6018b2ebcdd1ea6a7abc253e2c7913d0`
  at the
  [identity inspection](https://app.replay.io/recording/cf01688c-056b-4fe6-ac03-cc4d547f1e08?point=27908595614679429993017877786001420&time=72743.26190476191),
  but both are one authority inside the recording. Demand: attach the independently
  replayed digest artifact and make its literal comparison visible and citable.
- Replay critic — P2 direct deep-link coverage is insufficient. The observed
  non-root routes are SPA clicks/history transitions, including
  [back](https://app.replay.io/recording/cf01688c-056b-4fe6-ac03-cc4d547f1e08?point=47379708834219791877528298041901058&time=120665.21204356181)
  and
  [forward](https://app.replay.io/recording/cf01688c-056b-4fe6-ac03-cc4d547f1e08?point=49002301602517324642850152009170946&time=122917.32570688539);
  document commits occur only for authentication and logout. Demand: record a fresh
  document load of `/maple/reading-room` (and retain the authenticated SPA result).
- Replay critic — P2 changed-browser-hunk coverage is insufficient. Recorded source
  shows the happy identity render and ordinary link handling, but the identity-error
  and modified-click branches are unexecuted and the scoped static diff was not
  supplied to the Replay critic. Demand: provide the exact scoped diff and exercise,
  concretely waive, or delete every unexecuted browser behavior.
- Replay critic — P2 emulator fixture isolation is insufficient. The seeded
  `auth0|ada-replay` identity is observed entering `/api/whoami` at the
  [request initiation](https://app.replay.io/recording/cf01688c-056b-4fe6-ac03-cc4d547f1e08?point=19471113219546277524750386189041919&time=44887.73224043716),
  but no recorded server source or deployment configuration proves the fixture is
  excluded from production. Demand: provide and exercise the environment gate or
  deployment configuration that isolates emulator-only fixture data.
- Surviving checks: `make verify-E3-T02` and `make verify-E2-T04` passed at the
  submission; an independent out-of-band identity event followed by reload advanced
  the DOM triple atomically from offset `...0385` to `...0579`; both no-database
  detector probes went expected-red; and an independently injected false
  `/api/whoami` digest made the public shell gate fail at the exact truth assertion.
  The local MP4 exists at the claimed path and matches its declared H.264 geometry,
  duration, size, and SHA-256. Replay recording data remains durably uploaded at the
  cited Replay URL; the MP4 remains local for chat embedding.
- Lifecycle: failed verification run 1. E3-T02 returns to `in-progress`; the project
  remains `building`; run 2 may rework the findings above under the ordinary
  three-run ceiling. SUITE: retain the false-whoami-digest sabotage and promote
  production-runtime composition plus wire-scan sensitivity checks after the
  refutations clear.

### 2026-07-27 — builder run 2 — CLAIM: implemented

- Candidate: `116ffa31d19d452444df5323e8ab70e3409b5edc`, retaining the
  invalid-identity-response repair at `9446b6acb673f206d0c7cc64692ec69f4fca5b5f`
  and adding the bounded-capture doctrine at `116ffa3`. The app now validates the
  complete `/api/whoami` runtime shape before rendering it; syntactically valid but
  structurally invalid JSON reaches the committed
  `Identity could not be replayed.` alert rather than throwing from render.
- Exact-head gates: `make verify-E3-T02`, `make verify-E2-T04`, and
  `make verify-E2-T12` all exited 0 at `116ffa31d19d452444df5323e8ab70e3409b5edc`.
  Each re-earned the 34-file / 413-test root suite and production build.
  `verify-E3-T02` additionally re-earned shipped-runtime topology, seven full-wire
  credential sensitivities, credential-free fixture login, the committed sanitized
  proof panel, S256 PKCE redemption with no verifier exposure, literal independent
  CLI/DOM digest equality, SPA/history/404 and authenticated deep-link coverage,
  the valid-JSON invalid-shape identity alert, recovery, logout, and
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
  `verify-E2-T04` ended with its Auth0 61/61, emulator 6/6, auth 10/10, and
  zero-console-warning/error browser proof. `verify-E2-T12` re-earned the local
  capstone plus the E2-T11, E2-T07, E2-T08, E2-T09, and E2-T10 evidence and
  source-sabotage matrices.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T02` cloned exact
  `116ffa31d19d452444df5323e8ab70e3409b5edc`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated only from the
  lockfile-verified pnpm store under the scrubbed environment, repeated all 413
  tests and the complete browser verifier, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Stream evidence: refreshed
  `evidence/e3-t02-shell-playwright.txt`,
  `evidence/e3-t02-independent-digest.txt`,
  `evidence/e3-t02-identity-replay.jsonl`, and
  `evidence/e3-t02-pkce.txt`. The deterministic gate exposed one complete identity
  region at offset `0000000000000000_0000000000000370`, digest
  `7ccf4d7ccc97cf5584fe3a77064e8f2206075708282c1b6344a52206dcf6dd2a`,
  with exact independent replay equality. The final local walkthrough's sanitized
  receipt independently replayed its two-event `__identity__` log to offset
  `0000000000000000_0000000000000373` and digest
  `28e690d669cd35cffedb6cf7b826ed3b6018b2ebcdd1ea6a7abc253e2c7913d0`;
  the same literal digest was visible in the committed proof panel.
- Browser evidence: one disposable rehearsal completed every locator and error path
  before recording. The concise replacement walkthrough then used Replay Chromium
  and real Playwright pointer/history events to show the password-free emulator
  login, current S256/redeemed/verifier-not-exposed receipt, independent CLI/DOM
  digest equality, modified-click branch, Maple, Reading room, back, forward, 404,
  the valid-JSON invalid-shape identity alert, route removal and recovery, zero
  console errors/warnings, and logout back to a form with zero password fields.
  The same browser run produced local
  `recordings/e3-t02-run2-short-final.mp4` (verified H.264/yuv420p,
  1280x720, 30 fps, 9.2 s after the lifecycle script's stale-frame compression,
  227988 bytes; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
  `ffmpeg` decoded the complete artifact without error and contact-sheet inspection
  confirmed the proof panel, navigation/404, identity-error, recovery, and logout
  frames. The earlier 43-minute partial and the first short attempt were aborted,
  deleted, and are not evidence.
- Replay: N/A (tenant policy denied sending the full local-app browser recording to
  the external Replay service even after explicit approval) + mitigation: the
  lifecycle close ran with `--upload false` and reported
  `Upload skipped by --upload false.`; the verified local same-session MP4 above,
  committed Playwright transcript and event-log/digest artifacts, exact-head
  `verify-E3-T02`, and pristine cold-clone run stand in. No MP4 or Replay recording
  was uploaded, and no recording ID or URL is claimed.

### 2026-07-27 — judge round 2 — VERDICT: refuted

- P1 full-wire credential scanner — FAILED. Predicted any protected literal outside
  the allowed `ef_session=<id>.<hmac>` cookie value would turn
  `scanCredentialLeaks` red, including a literal placed in another attribute of an
  otherwise HttpOnly `Set-Cookie` response. Observed this independent probe return
  `UNEXPECTED_GREEN {"observations":1,"fields":4}`:
  `Set-Cookie: ef_session=abc.def; Path=/builder-password-secret; HttpOnly; SameSite=Lax`
  with `secretLiterals: ["builder-password-secret"]`.
  `packages/browser-verify/src/index.ts:746-753` first exempts the entire header,
  then removes `ef_session=...;[^,]*`, erasing every same-header attribute before
  the second scan. The committed sensitivity covers a non-HttpOnly session cookie
  at `tools/verify/e3_t02_wire_sensitivity.mjs:56-63` and blesses the whole
  HttpOnly header at lines 75-92, but never attacks secret-bearing cookie
  attributes. This contradicts the network-scan acceptance criterion at this
  readme's lines 184-188 and the run-2 claim of seven full-wire sensitivities.
  Demand: parse `Cookie` and `Set-Cookie` structurally, exempt only the exact allowed
  session-cookie value/channel, scan every remaining cookie name, attribute, and
  value, add expected-red sensitivities for secret/session material in
  `Path`/`Domain`/extension attributes, then re-run and re-record.
- Surviving checks: exact submission `f905bc0ceb7726e4d64eb645e038d2ad0aee57f9`
  passed `make verify-E3-T02`; a pristine clone of that exact submission passed
  `tools/verify/cold_clone.sh verify-E3-T02`; and `make verify-E2-T04` passed.
  The E3 gate re-earned 34 files / 413 tests, the shipped production binary +
  `EF_WEB_ROOT` topology, the existing seven wire sensitivities, password-free
  S256 challenge/code redemption, independent CLI/DOM digest equality, authenticated
  deep-link, modified-click, invalid-shape alert/recovery, neutral shell, and clean
  browser telemetry. An independent disposable-clone mutation that weakened
  `isWhoami` to accept every object made the public `make verify-E3-shell` gate turn
  red while waiting for the required identity alert, so that detector is sensitive.
- Browser evidence: the local
  `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  is H.264/yuv420p at 1280x720 and 30 fps, lasts 9.2 seconds, is 227988 bytes,
  decodes completely, and dense frame inspection shows the one-click login, proof
  receipt, route/history/404 sequence, identity error, recovery, and logout. No
  long or aborted artifact is cited. The run-2
  `Replay: N/A (tenant policy denial) + mitigation` is sufficient under the
  declared fallback: Playwright, the same-session local MP4, stream receipts, and
  cold-clone proof stand in; no Replay URL is invented.
- Regression boundary: the independent `make verify-E2-T12` rerun re-earned the
  413-test root suite/build, local config/browser capstone, E2-T11, E2-T07, and the
  E2-T08 no-database detector/sensitivity before its redundant remaining tail was
  interrupted after this refutation became conclusive. It is not claimed as a
  completed independent E2-T12 pass; the builder's exact-candidate E2-T12 pass
  remains the committed claim under review.
- COVERAGE: the shipped production runtime, fixture-only login, browser/server wire
  capture, PKCE, proof receipt, identity success/error paths, ordinary and modified
  navigation, deep-link, neutral styles, traversal refusals, logout, and recording
  harness all executed in the exact gate, local walkthrough, or focused production
  proof. Type/config/documentation branches are waived as non-runtime declarations.
  The scanner exception hunk is executed but refuted by the probe above.
- Lifecycle: failed verification run 2. E3-T02 returns to `in-progress`; the
  project remains `building`. The durable ledger parses `runCount=2` under the
  default absolute `runCeiling=10`; run 3 is the last run before the first required
  three-run progress audit, not the absolute ceiling. SUITE: retain the
  malformed-identity sabotage; do not promote the cookie scanner until the missing
  attribute sensitivities fail red and the repaired control passes green.

### 2026-07-27 — builder run 3 — CLAIM: implemented

- Candidate implementation: `12dacff93635106d670c81106c09f7f72d7de914`,
  directly above canonical run-2 refutation
  `147ae9791973505bebaaed1b5d07df766eed648b`. The credential scanner now parses
  request `Cookie` pairs and response `Set-Cookie` records structurally. It exempts
  only the exact anchored `ef_session=<id>.<hmac>` value in its allowed channel
  (and requires exactly one valueless `HttpOnly` attribute for a response session);
  it separately scans cookie names, all other cookie values, and every
  `Path`/`Domain`/`SameSite`/`Expires`/`Max-Age`/extension attribute name and value.
  Duplicate session cookies and malformed cookie syntax fail closed and remain
  scannable.
- Sensitivity: the exact judge probe
  `Set-Cookie: ef_session=abc.def; Path=/builder-password-secret; HttpOnly; SameSite=Lax`
  now returns expected red at
  `browser.response[0].headers.set-cookie.set-cookie[0].attribute[0].value`.
  `evidence/e3-t02-wire-sensitivity.txt` records 20 expected-red attacks:
  all original full-wire channels; each standard cookie attribute; extension
  names and values; other request-cookie names and values; combined response
  cookies; malformed request/response cookies; and the invented duplicate-session
  boundary. The exact allowed session control, with clean scanned attributes and
  other cookies, remains green.
- Ordered gates: the first sandbox-constrained attempt reached the root tests but
  the native Durable Streams store aborted, producing 186 cascading failures
  unrelated to this scanner-only diff. The correctly permissioned restart then
  passed, in order, `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (34 files / 413 tests), and `pnpm build`.
  Exact-head `make verify-E3-T02` passed the same 413 tests, production build,
  shipped-runtime/emulator topology, all 20 scanner sensitivities, and the full
  browser verifier with `console.error=0 pageerror=0 requestfailed=0
  non-loopback=0`. The refreshed browser transcript reports 39 network
  observations and 355 scanned fields with zero JWT, verifier, or session leakage.
- Regression and policy boundary: exact-head `make verify-E2-T04` ended
  `verify-E2-T04: OK`, including Auth0 61/61, emulator 6/6, auth 10/10, and clean
  browser telemetry. Exact-head
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios. Its printed
  `recovery commit escaped its exact lifecycle path set` exception is the
  deliberately caught expected-red synthetic recovery mutation, not a weakened or
  bypassed policy.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T02` cloned exact
  `12dacff93635106d670c81106c09f7f72d7de914`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated from the lockfile-verified
  store under the scrubbed environment, repeated all 413 tests and the complete
  verifier, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Browser evidence reuse: the scoped diff from `147ae97` to `12dacff` contains only
  `packages/browser-verify/src/index.ts`, the wire-sensitivity harness, and its
  evidence; it has no `apps/web` or shipped UI/runtime behavior hunk. Per the run-3
  instruction, no replacement walkthrough was recorded. The accepted run-2 local
  `recordings/e3-t02-run2-short-final.mp4` remains the browser artifact (H.264,
  1280x720, 30 fps, 9.2 s; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
- Replay: N/A (tenant policy denied sending the local-app recording to the external
  Replay service) + mitigation: the already accepted same-session local MP4 above,
  refreshed full-wire Playwright transcript, 20-case sensitivity evidence,
  exact-head E3/E2 gates, and exact pristine-clone proof stand in. No upload,
  recording ID, or Replay URL is claimed.

### 2026-07-27 — judge round 3 — VERDICT: refuted

- P1 multi-header duplicate-session boundary — FAILED. Predicted the scanner would
  reject more than one `ef_session` across a complete wire observation and would
  scan a protected literal in the duplicate value. Observed both independent
  probes return unexpected green. A response observation with separate
  `Set-Cookie: ef_session=clean.signature; Path=/; HttpOnly; SameSite=Lax` and
  `Set-Cookie: ef_session=critic-secret-marker.signature; Path=/; HttpOnly; SameSite=Lax`
  fields returned `{"observations":1,"fields":16}`; a request observation with
  separate `Cookie: ef_session=clean.signature` and
  `Cookie: ef_session=critic-secret-marker.signature` fields returned
  `{"observations":1,"fields":6}`. `inspectCookieHeader` is invoked once per header
  entry, so `sessionCookies` and `sessionRecords` count only the current serialized
  value at `packages/browser-verify/src/index.ts:809-821` and `:840-849`; each
  duplicate is independently classified as the one allowed session and its protected
  literal is exempted. The committed duplicate sensitivity covers two sessions
  inside one request header only at
  `tools/verify/e3_t02_wire_sensitivity.mjs:189-197`. This contradicts the run-3
  claim that duplicate session cookies fail closed at this readme's lines 541-550.
  Demand: aggregate same-name cookie records across all header fields in one
  observation, or fail closed on duplicate `Cookie`/`Set-Cookie` header fields; add
  request and response multi-header expected-red cases while retaining the exact
  single-session controls; then re-run the complete gate.
- The run-2 counterexample is repaired. The exact
  `Set-Cookie: ef_session=abc.def; Path=/builder-password-secret; HttpOnly; SameSite=Lax`
  probe now turns red at
  `browser.response[0].headers.set-cookie.set-cookie[0].attribute[0].value`.
  Independent attacks placing protected literals in quoted attributes, an
  `Expires` value containing a comma, extension names and values, combined cookies,
  malformed separators, and request-cookie names and values all turned red. Exact
  clean single-session request and response controls remained green.
- Surviving checks: independent `make verify-E3-T02` passed at exact submission
  `feae5d42da216f371f31ff0304ed29fef1ca76e1`, whose implementation remains candidate
  `12dacff93635106d670c81106c09f7f72d7de914`. It re-earned format, lint,
  typecheck, all 34 test files / 413 tests, production builds, the 20 committed
  wire sensitivities, shipped-runtime and emulator topology, the complete browser
  verifier, and ended `verify-E3-T02: OK` with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`. The builder's
  exact-candidate E2-T04, policy, and pristine-clone passes remain committed claims
  under review; this critic stopped redundant long gates after the independent
  counterexample and complete E3 gate made the verdict conclusive.
- COVERAGE and browser evidence: the run-3 scoped diff
  `147ae9791973505bebaaed1b5d07df766eed648b..12dacff93635106d670c81106c09f7f72d7de914`
  changes only `packages/browser-verify/src/index.ts`, the wire-sensitivity harness,
  and its transcript; there is no `apps/web` or shipped UI/runtime behavior hunk.
  Reusing the independently accepted run-2 walkthrough is therefore honest. The
  local `recordings/e3-t02-run2-short-final.mp4` again matched SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this local verified MP4,
  the full Playwright transcript, stream/digest receipts, exact-head E3 gate, and
  committed cold-clone proof; no Replay URL is invented.
- Lifecycle: failed verification run 3. E3-T02 returns to `in-progress` and the
  project remains `building`. This is the first mandatory three-run checkpoint:
  `.eforest/loop.md:94-104` requires a separate fresh progress critic over runs 1-3
  before any builder run 4. This judge does not author that audit. Run 3 is not the
  absolute ceiling; continuation depends on a durable `progressing` audit.
  SUITE: retain the repaired attribute sensitivities and promote both multi-header
  duplicate-session probes with the fix.

### 2026-07-27 — progress critic — RUNS 1-3: progressing

- Rationale: Runs 1-3 show genuine convergence with no evidenced regression. Run 2 closed the broad run-1 production-topology and lossy-wire-observation failures through the shipped production runtime, full request/response field capture, permanent production and credential sensitivities, password-free S256 PKCE proof, independent digest evidence, deep-link/error/modified-navigation coverage, and a green exact-head/cold-clone gate. Its new failure was narrower and deeper: the scanner exempted an entire structurally valid HttpOnly Set-Cookie line, including a protected literal in an attribute. Run 3 replaced that broad exception with structural request/response cookie parsing and compounded the permanent suite from seven to twenty expected-red channels, closing the exact run-2 attribute counterexample plus quoted, Expires-comma, standard/extension attribute, malformed, combined-cookie, and same-header duplicate cases while the complete E3 gate remained green. The run-3 finding is a deeper compositional boundary—duplicate session records split across multiple header fields are evaluated independently—not a repeated old failure or one-off rewording. The window therefore earns run 4, strictly focused on observation-wide aggregation; it does not waive that remaining counterexample.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-1 — Establishes the broad initial production-runtime, lossy wire-capture, PKCE, digest, deep-link, error-path, and fixture-isolation findings that later runs had to close.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-2 — Confirms the run-1 production, browser, PKCE, digest, and wire-capture findings survived repaired gates, and isolates the narrower whole-Set-Cookie attribute exemption as the sole blocking counterexample.
- Evidence (diff): 147ae9791973505bebaaed1b5d07df766eed648b..12dacff93635106d670c81106c09f7f72d7de914 — Resolves to the run-3 structural cookie-scanner, permanent sensitivity-harness, and transcript changes without unrelated UI or shipped-runtime behavior changes.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-3 — Confirms the exact run-2 attribute counterexample and broader cookie-attribute attacks are now red, clean controls and the complete E3 gate remain green, and identifies the deeper multi-header request/response aggregation gap.
- Next focus: Aggregate Cookie and Set-Cookie records across every same-name header field in one complete wire observation before deciding whether the single ef_session exception is allowed; duplicate session records across fields must fail closed and keep every non-exempt value scannable.
- Next focus: Add permanent expected-red request and response cases with duplicate ef_session records split across separate header fields, and retain exact green controls for one clean request Cookie session and one clean HttpOnly response Set-Cookie session before re-running the complete exact-head and cold-clone gates.
- Assessment: progressing

### 2026-07-27 — builder run 4 — CLAIM: implemented

- Candidate: `46d04ffcb0fb5456ab20f2271ae1bc9a5430e3ef`, directly above the
  durably accepted runs 1-3 progress audit
  `c86e468cbbf93af092923f1bd427fded2fffb96f`. The scanner now parses every
  case-insensitive request `Cookie` or response `Set-Cookie` header field in a
  complete wire observation before allowing any exception. Only one aggregate
  exact `ef_session=<id>.<hmac>` record may be exempted; response exemption still
  requires its single valueless `HttpOnly` attribute. Multiple session records
  across fields disable every session exception, and any malformed same-channel
  field fails the aggregate closed so its raw value and every otherwise parsed
  component remain scannable.
- Exact counterexamples: the judge-shaped request and response observations, each
  containing clean and protected-literal session values in two separate header
  fields, both returned expected red at the duplicate session value with the
  protected literal SHA-256. The permanent transcript now records 23 expected-red
  attacks: the prior 20 plus request multi-header duplicate, response multi-header
  duplicate, and an invented mixed-case cross-field boundary whose first field
  combines an `Expires` comma, a clean cookie, and a session record. Exact one
  clean request session and one clean HttpOnly response session controls remain
  green.
- Gates: after Prettier identified and corrected only the new sensitivity layout,
  the ordered sequence restarted from the top and passed
  `pnpm format:check && pnpm lint`, `pnpm typecheck`, `pnpm test` (34 files /
  413 tests), and `pnpm build`. Exact-head `make verify-E3-T02` passed the same
  root suite/build, shipped production topology, Auth0 61/61 and emulator 6/6,
  all 23 wire sensitivities, and the complete browser proof with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
- Regression and policy: exact-head `make verify-E2-T04` ended
  `verify-E2-T04: OK`, including 413 root tests, Auth0 61/61, emulator 6/6,
  auth 10/10, and clean browser telemetry. Exact-head
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios. Its printed recovery-path exception
  is the deliberately caught expected-red synthetic mutation; no control-plane
  rule was weakened or bypassed.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T02` cloned exact
  `46d04ffcb0fb5456ab20f2271ae1bc9a5430e3ef`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated from the
  lockfile-verified store under the scrubbed environment, repeated all 413 tests
  and the complete verifier, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Browser evidence reuse: the scoped diff from `c86e468` to `46d04ff` changes only
  `packages/browser-verify/src/index.ts`, the wire-sensitivity harness, and its
  transcript; there is no `apps/web` or shipped UI/runtime hunk. No replacement
  walkthrough was recorded. The accepted
  `recordings/e3-t02-run2-short-final.mp4` remains the browser artifact (H.264,
  1280x720, 30 fps, 9.2 s; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
- Replay: N/A (tenant policy denied sending the local-app recording to the external
  Replay service) + mitigation: the accepted same-session local MP4, full-wire
  Playwright transcript, 23-case permanent sensitivity transcript, exact-head
  E3/E2 gates, and pristine-clone proof stand in. No upload, recording ID, or
  Replay URL is claimed.

### 2026-07-27 — judge round 4 — VERDICT: refuted

- P1 encoded-wire credential bypass — FAILED. Predicted the full-wire scanner would
  reject credentials after ordinary HTTP percent encoding. Observed four independent
  probes return unexpected green at exact submission
  `6ba1044e79bcacb3bbab1e307c706d7df9afb003`: URL
  `?proof=AdaShell1234%21` with secret literal `AdaShell1234!`; form body
  `proof=AdaShell1234%21`; form body
  `code%5Fverifier=critic-value`; and URL JWT-shaped value
  `eyJabcdefghijk%2Eabcdefghijk%2Eabcdefghijk`. The scanner matches only raw
  values at `packages/browser-verify/src/index.ts:789-799`, then inspects the raw
  URL and a UTF-8-decoded but still percent-encoded body at `:920` and `:935`.
  The browser proof supplies the real subject password as a protected literal at
  `apps/web/test/shell.pw.ts:423-425`, so its `jwt=0 verifier=0` receipt can remain
  green while encoded credentials are on the recorded wire. Demand: retain raw
  scanning, additionally scan bounded canonical percent-decoded URL query and form
  components plus relevant header values, fail closed on malformed encodings, and
  promote all four probes with encoding-safe clean controls.
- The run-3 counterexample is repaired. Independent request and response
  observations with the protected secret in the second `Cookie`/`Set-Cookie` field
  both turned red at that value. Sixteen further observation-wide attacks turned
  red: case variants, interleaved malformed fields, three-session observations,
  combined-plus-separate records, split secret attributes, `Expires` commas,
  quoted delimiters, reversed ordering, folded control characters, and
  request/response channel confusion. Four exact controls remained green,
  including multi-field observations containing exactly one valid session. The
  aggregate logic is at `packages/browser-verify/src/index.ts:894-919`; the
  permanent request/response probes are at
  `tools/verify/e3_t02_wire_sensitivity.mjs:199-235`.
- Surviving checks: independent exact-head `make verify-E3-T02` passed at
  submission `6ba1044e79bcacb3bbab1e307c706d7df9afb003`. It re-earned format,
  lint, typecheck, all 34 test files / 413 tests, production builds, Auth0 61/61,
  emulator 6/6, all 23 committed wire sensitivities, the browser proof with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`, and ended
  `verify-E3-T02: OK`. The new encoded probes demonstrate why that green gate is
  insufficient. After the conclusive counterexample, the critic did not redundantly
  rerun E2-T04, policy, or the long cold clone; their exact-candidate passes remain
  the builder's committed claims.
- COVERAGE and browser evidence: the run-4 diff from audit
  `c86e468cbbf93af092923f1bd427fded2fffb96f` to candidate
  `46d04ffcb0fb5456ab20f2271ae1bc9a5430e3ef` changes only
  `packages/browser-verify/src/index.ts`, the wire-sensitivity harness, and its
  transcript; there is no shipped UI/runtime hunk. Reusing the accepted walkthrough
  is honest. The local `recordings/e3-t02-run2-short-final.mp4` independently
  verified as H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes,
  SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`.
  Replay: N/A (tenant policy denied sending the local-app recording to the external
  Replay service) + mitigation: this local verified MP4, the full Playwright
  transcript, stream/digest receipts, the exact-head E3 gate, and the builder's
  committed pristine-clone proof; no upload or Replay URL is claimed.
- Lifecycle: failed verification run 4. E3-T02 returns to `in-progress`; the
  project remains `building`. The accepted runs 1-3 `progressing` audit remains
  valid and authorized this run; no new progress audit is due at run 4. SUITE:
  retain all 23 cookie/aggregation sensitivities and add the four percent-encoding
  probes plus clean controls with the repair.

### 2026-07-27 — builder run 5 — CLAIM: implemented

- Candidate: `d4fb0a6a076056aeab59a001c11ba048c9d7c8a5`, directly above canonical
  run-4 refutation `60d17a92b33b425ecdc6d20f5eee20d98c7d5e66`. Raw URL, header,
  structured cookie, and body scans remain intact. The scanner now additionally
  canonicalizes only URL query names/values, `application/x-www-form-urlencoded`
  names/values, and textual header/cookie components. It does not percent-decode
  URL paths or non-form/binary bodies.
- Normalization is bounded to 8 KiB per component and two decode passes.
  Malformed escapes, invalid UTF-8, overlong components/decode bombs, and a
  residual third recursive encoding fail closed as explicit findings. Form/query
  raw `+` becomes space before percent decoding, while `%2B` remains a literal
  plus; raw scanning remains alongside both representations so neither
  plus-to-space direction can erase a protected literal.
- Exact probes and suite: the four critic probes now return expected red at their
  canonical fields: URL and form `AdaShell1234%21` match protected
  `AdaShell1234!`; form name `code%5Fverifier` reports `code_verifier`; and URL
  JWT separators `%2E` report `JWT`. The permanent transcript now contains 36
  expected-red cases: the prior 23 plus those four, malformed URL/form escapes,
  double and recursive encoding, overlong and percent-decode-bomb components,
  both plus/space directions, and an encoded header secret. Clean encoded
  URL/form/header controls and exact session-cookie controls remain green.
- Gates: the ordered `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (34 files / 413 tests), and `pnpm build` sequence passed.
  Exact-head `make verify-E3-T02` passed the same suite/build, production and
  emulator topology, all 36 sensitivities, and the complete browser proof. Its
  refreshed transcript scanned 39 observations / 363 fields and ended
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
- Regression: the first `make verify-E2-T04` attempt passed 412 tests but an
  unrelated registry long-poll fixture cleanup hook timed out after 120 seconds;
  that code is outside this scanner-only diff. The complete gate was restarted
  from the top without modification and passed all 413 tests, production build,
  Auth0 61/61, emulator 6/6, auth 10/10, clean browser telemetry, and terminal
  `verify-E2-T04: OK`.
- Policy and cold clone: exact-head
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery exception is
  the caught expected-red synthetic mutation. `tools/verify/cold_clone.sh
  verify-E3-T02` cloned exact `d4fb0a6a076056aeab59a001c11ba048c9d7c8a5`,
  checked out pinned emulate `82eb835947c97fcf6e0596a4377acbb01ca13ede`,
  hydrated from the lockfile-verified store under the scrubbed environment,
  repeated all 413 tests and the complete verifier, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Browser evidence reuse: the scoped diff from `60d17a9` to `d4fb0a6` changes
  only `packages/browser-verify/src/index.ts`, the wire-sensitivity harness, and
  its transcript; there is no `apps/web` or shipped UI/runtime hunk. The accepted
  `recordings/e3-t02-run2-short-final.mp4` remains the browser artifact (H.264,
  1280x720, 30 fps, 9.2 s; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
- Replay: N/A (tenant policy denied sending the local-app recording to the
  external Replay service) + mitigation: the accepted same-session local MP4,
  refreshed full-wire Playwright transcript, 36-case permanent sensitivity
  transcript, exact-head E3/E2 gates, and pristine-clone proof stand in. No
  upload, recording ID, or Replay URL is claimed.
