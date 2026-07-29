---
id: E3-T02
epic: 3
title: "Web app shell: authenticated React app served by the platform, browser-verify harness wired, DOM offset/digest exposure contract frozen"
priority: 302
status: in-progress
verification_run_ceiling: 16
verification_recovery_base_run: 13
verification_recovery_generation: 2
verification_recovery_control_commit: e33a2e68bf23f3ee4345f3617411128e8930456a
verification_resume_commit: 944da0e42db3dd20337c40857acfe07e5f0ca0dd
verification_invalid_loop_commit: 0d56fbeaef259b363994ba1b2acba8cae717bd63
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

### 2026-07-28 — builder run 10 — CLAIM: implemented

- Candidate: `16d3d4fcd06ee5dae9d806c2e26e5643600ab6a8`, directly above
  canonical runs-7-9 progress audit
  `6a4a559fea0087cbfb8a28b0b849fbd51a305c24`. The provenance grammar
  remains the sole validity and error path. A separate bounded alternate-
  representation search follows only successful ordinary percent decodes within
  the existing two-pass and 8 KiB limits and is consulted exclusively for
  protected-secret matching. Failed alternate decodes add no errors, and
  alternate representations cannot trigger JWT, verifier, or session grammar
  findings.
- Exact run-9 attacks and safe controls: `%25%36%33ritic` and
  `c%25%37%32itic` now expose protected literal `critic` and go red in all
  twelve wire positions: URL name/value, form name/value, non-cookie header
  name/value, request Cookie name/value, Set-Cookie cookie name/value, and
  Set-Cookie attribute name/value. The same-depth `%25%41%42` family remains
  green with `secretLiterals: ["critic"]`, so the alternate search neither
  weakens primary validity nor over-flags unrelated successful decodes.
- Permanent suite: all prior 111 named expected-red cases and every existing
  red/green matrix survive. The two exact hidden-literal attacks add 24 named
  reds for 135 total. A generated four-way per-character corpus (raw,
  direct-percent, nested-percent, and same-depth percent-octet spelling)
  enumerates all 4,096 spellings of `critic` across all twelve positions:
  49,152 protected-literal expected-red scans.
- Ordered gates: `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (34 files / 413 tests), and `pnpm build` passed. Exact candidate
  `make verify-E3-T02` passed the complete named/generated sensitivity suite and
  browser proof at 39 network observations / 611 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`, ending
  `verify-E3-T02: OK`. Exact `make verify-E2-T04` and
  `make verify-E2-T12` each completed their full regression/browser/sensitivity
  closures and ended with their registered `OK` markers.
- Policy, self-check, and pristine clone:
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery exception
  is the caught expected-red synthetic mutation. `tools/verify/self_check.sh`
  exited 0 with `CANOPY_SENSITIVITY_SPINE_OK` and the no-green-washing audit.
  `tools/verify/cold_clone.sh verify-E3-T02` cloned exact implementation head
  `16d3d4fcd06ee5dae9d806c2e26e5643600ab6a8`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated from the
  lockfile-verified store under the scrubbed environment, reran the complete
  target, and ended `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Coverage and browser evidence reuse: the implementation diff
  `6a4a559fea0087cbfb8a28b0b849fbd51a305c24..16d3d4fcd06ee5dae9d806c2e26e5643600ab6a8`
  changes only `packages/browser-verify/src/index.ts`, the wire-sensitivity
  harness, and its transcript; there is no `apps/web` or shipped UI/runtime
  hunk. The accepted `recordings/e3-t02-run2-short-final.mp4` was independently
  revalidated as H.264/yuv420p, 1280x720, 30 fps, 9.2 seconds, 227988 bytes,
  SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`.
- Replay: N/A (tenant policy denied external upload) + mitigation: the accepted
  local MP4, refreshed full-wire Playwright transcript, exact stream/digest
  receipts, all named/generated sensitivity matrices, exact E3/E2 regression
  gates, policy/self-check, and pristine-clone proof stand in. Per the recorded
  policy blocker, no upload was retried and no recording ID or Replay URL is
  claimed. Run 10 is the absolute autonomous ceiling; the fresh critic owns the
  terminal verdict.

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

### 2026-07-27 — judge round 5 — VERDICT: refuted

- P1 bounded canonical decoder — FAILED. Predicted malformed percent encoding
  exposed only after the second allowed decode pass would fail closed. Observed
  both a URL query value `proof=%2525GG` and header value
  `x-proof: %2525GG` return unexpected green. Pass one yields `%25GG`, pass
  two yields malformed `%GG`, and then
  `packages/browser-verify/src/index.ts:718-738` checks only for a residual
  valid `%HH` triplet rather than re-running the malformed-escape check. Demand:
  validate the terminal representation after every pass and at loop exit, and
  promote URL, form, and header cases where malformed escapes appear only after
  the final bounded pass.
- P1 decoded control delimiters — FAILED. Predicted canonical query/form/header
  representations containing decoded C0 or DEL controls would fail closed.
  Observed URL query values `proof=AdaShell1234%00%21`,
  `proof=AdaShell1234%2500%21`, and
  `proof=AdaShell1234%1F%21` all return unexpected green when scanned against
  the protected literal `AdaShell1234!`. The canonical path at
  `packages/browser-verify/src/index.ts:838-856` sends decoded representations
  directly to JWT/name/literal inspection; the existing control-character
  detector at `packages/browser-verify/src/index.ts:741-745` is used by cookie
  parsing but not by canonical query, form, or header inspection. Demand:
  reject decoded NUL/C0/DEL controls in every canonicalized field and promote
  single- and double-encoded delimiter attacks.
- P2 safe encoded-percent controls — FAILED. Predicted ordinary encoded literal
  percent data would remain green. Observed URL query, form value, and header
  value `100%25` each fail as `malformed percent encoding`: after `%25`
  correctly decodes to literal `%`, the next pass treats that literal as a new
  malformed escape at `packages/browser-verify/src/index.ts:718-727`. The
  committed green controls at
  `tools/verify/e3_t02_wire_sensitivity.mjs:448-460` cover `%20` and `%2B`
  but omit `%25`. Demand: distinguish a terminal decoded literal percent from
  malformed encoded input, retaining raw scans while adding green `%25`
  controls for URL, form, and header fields.
- Surviving checks: all four run-4 probes now turn red at their canonical
  fields. Independent attacks covering single/double/triple/over-depth
  encoding, mixed-case escapes, raw-plus versus `%2B`, invalid UTF-8,
  just-below/above 8 KiB, query and form names/values, content-type
  case/parameters, raw-only paths and non-form bodies, and the existing clean
  controls behaved as claimed. The committed
  `node tools/verify/e3_t02_wire_sensitivity.mjs` run passed all 36 recorded
  expected-red cases, demonstrating that the permanent suite omits the
  counterexamples above. The exact run-5 implementation diff
  `60d17a92b33b425ecdc6d20f5eee20d98c7d5e66..d4fb0a6a076056aeab59a001c11ba048c9d7c8a5`
  remains verifier-only: scanner, sensitivity harness, and transcript.
- Browser evidence and fallback: reusing the accepted run-2 walkthrough remains
  honest because run 5 changes no shipped UI/runtime behavior. Local
  `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this local verified
  MP4, the Playwright and stream/digest receipts, the exact-head builder gates,
  and committed pristine-clone proof; no Replay URL is invented.
- Lifecycle: failed verification run 5. E3-T02 returns to `in-progress`; the
  project remains `building`. The accepted runs 1-3 `progressing` audit
  authorizes run 6. If run 6 does not verify, a fresh progress critic must audit
  the complete runs 4-6 window before any run 7. SUITE: retain all 36 current
  sensitivities and promote the terminal-malformed, decoded-control, and safe
  `%25` cases with the repair.

### 2026-07-27 — builder run 6 — CLAIM: implemented

- Candidate: `5da4b562b41724f2faef84fb8700615e7afb75eb`, directly above canonical
  run-5 refutation `45582038a7515b9b1104e8f574e0461ccde59cca`. The bounded
  canonical decoder now validates the normalized raw component, every decoded
  representation, and final loop exit. It rejects C0/DEL controls immediately,
  retains the 8 KiB and two-pass ceilings, reports a residual valid escape as
  recursive, and reports an ambiguous terminal percent followed by two
  alphanumerics as malformed.
- Literal percent semantics: decoding stops when no valid `%HH` escape remains,
  so a `%25` that becomes a standalone literal percent is safe rather than fed
  into another malformed-input pass. The raw representation remains scanned.
  Consequently URL, form, and header `100%25` controls are green, while
  `%2525GG` decodes through `%25GG` to the malformed terminal `%GG` and fails
  closed.
- Exact probes and suite: independent URL and header `%2525GG` probes now report
  `malformed percent encoding`; the form variant is permanent too. The three
  specified URL controls—single-encoded NUL, double-encoded NUL, and encoded
  unit separator—report `control percent encoding`. An invented double-encoded
  DEL in a form name also turns red. All prior 36 expected-red cases remain, for
  43 total, while the prior encoded nonsecret/session controls and the three new
  `%25` controls remain green.
- Gates: ordered `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (34 files / 413 tests), and `pnpm build` passed. Exact-head
  `make verify-E3-T02` passed the same suite/build, production and emulator
  topology, all 43 sensitivities, and the complete browser proof at 39
  observations / 363 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
- Regression, policy, and cold clone: exact-head `make verify-E2-T04` passed all
  413 tests, production build, Auth0 61/61, emulator 6/6, auth 10/10, clean
  browser telemetry, and terminal `verify-E2-T04: OK`.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery exception is
  the caught expected-red synthetic mutation. `tools/verify/cold_clone.sh
  verify-E3-T02` cloned exact `5da4b562b41724f2faef84fb8700615e7afb75eb`,
  checked out pinned emulate `82eb835947c97fcf6e0596a4377acbb01ca13ede`,
  hydrated from the lockfile-verified store under the scrubbed environment,
  repeated all 413 tests and the complete verifier, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Browser evidence reuse: the scoped diff from `4558203` to `5da4b56` changes
  only `packages/browser-verify/src/index.ts`, the wire-sensitivity harness, and
  its transcript; there is no `apps/web` or shipped UI/runtime hunk. The accepted
  `recordings/e3-t02-run2-short-final.mp4` remains the browser artifact (H.264,
  1280x720, 30 fps, 9.2 s; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
- Replay: N/A (tenant policy denied external upload) + mitigation: the accepted
  same-session local MP4, refreshed full-wire Playwright transcript, 43-case
  permanent sensitivity transcript, exact-head E3/E2 gates, and pristine-clone
  proof stand in. No upload, recording ID, or Replay URL is claimed.
- Lifecycle note: if a critic refutes run 6, no run 7 may begin until a fresh
  progress critic durably audits the complete runs 4-6 window.

### 2026-07-28 — judge round 6 — VERDICT: refuted

- P1 whole-wire header-name coverage — FAILED. Predicted every recorded HTTP
  header name and value would be inspected for credential markers. Observed four
  independent one-observation attacks return unexpected green: raw
  `code_verifier: clean`, case-varied `Code_Verifier: clean`, encoded
  `code%5Fverifier: clean`, and valid-token header name
  `adashell1234!: clean` with `adashell1234!` supplied as the protected literal.
  The scanner destructures `[name, value]` at
  `packages/browser-verify/src/index.ts:1034-1044`, but for every non-cookie
  header it passes only `value` to raw and canonical inspection at
  `packages/browser-verify/src/index.ts:1045-1046`; the credential matchers are
  at `packages/browser-verify/src/index.ts:833-845`. The permanent corpus covers
  encoded header values but no ordinary header name. Demand: inspect every
  non-cookie header name in raw and bounded-canonical form, retain structured
  cookie-name/attribute-name inspection, and promote the four attacks plus safe
  header-name controls.
- P1 terminal malformed decoding — FAILED. Predicted the repaired decoder would
  validate every representation exposed at its final bounded exit. The run-5
  URL/form/header `%2525GG` attacks now turn red and all three `100%25` controls
  remain green, but URL values `%2525G_`, `%2525G-`, `%2525_G`, and `%2525G`
  return unexpected green; the same hidden terminal forms remain green in form
  names and values. Two valid decode passes expose `%G_`, `%G-`, `%_G`, or `%G`,
  but the terminal check at `packages/browser-verify/src/index.ts:741-747`
  rejects only a percent followed by two alphanumerics. Demand: replace that
  shape-specific heuristic with a stated, principled literal-percent versus
  malformed-input policy and promote these terminal forms across URL, form, and
  header components.
- Surviving checks: the committed
  `node tools/verify/e3_t02_wire_sensitivity.mjs` run passed all 43 expected-red
  mutations and all three green control groups. Independent C0/DEL,
  plus/space, recursive/over-depth, form content-type case/parameter, raw-only
  encoded-path, and non-form-body attacks behaved as claimed. Unicode
  normalization/confusable probes were explored but are not findings because
  this task promises literal matching, not Unicode canonical equivalence.
  `git diff --check` and
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0.
  An independent exact-head `make verify-E3-T02` passed format, lint, and
  typecheck and entered the root test suite before the critic stopped it after
  the conclusive counterexamples; E2 and cold-clone gates were not redundantly
  rerun after refutation.
- COVERAGE and browser evidence: the run-6 implementation diff
  `45582038a7515b9b1104e8f574e0461ccde59cca..5da4b562b41724f2faef84fb8700615e7afb75eb`
  remains verifier-only: `packages/browser-verify/src/index.ts`, the sensitivity
  harness, and its transcript. Reusing the accepted walkthrough remains honest.
  Local `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this local verified
  MP4, Playwright and stream/digest receipts, the committed sensitivity corpus,
  and the builder's exact-head/pristine-clone receipts; no upload or Replay URL
  is claimed.
- Lifecycle: failed verification run 6 at exact submission
  `eedb4cef5cbe8bc158aa628e67d1300efb221ee8`, candidate
  `5da4b562b41724f2faef84fb8700615e7afb75eb`. E3-T02 returns to
  `in-progress`; the project remains `building`. No builder run 7 may begin
  until a separate fresh progress critic durably audits the complete runs 4-6
  window and records `progressing`. This judge does not author that audit.
  SUITE: retain all 43 current sensitivities and add the header-name and
  terminal-malformed probes with any repair.

### 2026-07-27 — progress critic — RUNS 4-6: progressing

- Rationale: Runs 4-6 show genuine, bounded convergence rather than a repeated unmodified symptom. Run 4 closed the runs-1-3 observation-wide Cookie/Set-Cookie aggregation gap, retained the complete prior corpus and clean controls, and exposed the deeper encoded-wire boundary. Run 5 closed all four encoded-wire counterexamples by adding bounded canonical scanning across URL query, form, and header values, growing the permanent expected-red corpus from 23 to 36 while raw scans and green controls survived; its failures moved inside decoder terminal-state/control semantics. Run 6 closed the exact final-pass `%2525GG`, decoded C0/DEL, and safe `%25` control failures, grew the corpus to 43, and preserved all earlier attacks and three green control groups. The remaining header-name omission is a new whole-wire field-completeness boundary. The remaining malformed-terminal variants do reveal that run 6's alphanumeric lookahead is a shape-specific heuristic, so continuation is justified only for a principled grammar replacement, not another enumerated regex patch. This window is not yet a death spiral because each earlier exact counterexample stays closed, tests compound monotonically, controls prevent overblocking, and no regression is evidenced; a run-7 heuristic variant patch would fail this rationale.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-4 — Confirms the run-3 multi-header aggregation counterexample was repaired across broader observation-wide attacks with controls, then isolates ordinary percent-encoded wire fields as the deeper new failure.
- Evidence (diff): 60d17a92b33b425ecdc6d20f5eee20d98c7d5e66..d4fb0a6a076056aeab59a001c11ba048c9d7c8a5 — Resolves to the run-5 bounded canonical scanner and permanent sensitivity expansion that repaired run 4 without shipped UI/runtime changes.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-5 — Confirms every run-4 encoded probe turned red and broad encoding boundaries survived, while identifying terminal malformed-state, decoded-control, and safe-percent control gaps.
- Evidence (diff): 45582038a7515b9b1104e8f574e0461ccde59cca..5da4b562b41724f2faef84fb8700615e7afb75eb — Resolves to the run-6 decoder-exit/control repair and promoted sensitivity cases, with the verifier-only scope preserved.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-6 — Confirms all 43 committed attacks and three green control groups survive, the run-5 exact failures are repaired, and isolates non-cookie header-name coverage plus the remaining shape-specific terminal-percent heuristic.
- Next focus: Scan every whole-wire non-cookie header name as well as its value in both raw and bounded-canonical form; retain structured cookie-name and attribute-name handling, and add exact raw, case-varied, encoded, protected-literal, and safe-name controls.
- Next focus: Replace the terminal percent lookahead heuristic with a stated, principled percent grammar that distinguishes literal decoded percent data from malformed encoded input at every bounded representation and terminal exit; promote `%G_`, `%G-`, `%_G`, `%G`, safe `%25`, and corresponding URL/form/header controls. Do not add another shape enumeration.
- Assessment: progressing

### 2026-07-28 — builder run 7 — CLAIM: implemented

- Candidate: `19fc16317999b490ffb78294d1333ef3c16e2515`, directly above the
  accepted runs-4-6 progress audit
  `c1c35ed67131f8a73e1b7548578b24da9524a407`. Every non-cookie header
  now contributes both its name and value to the raw and bounded-canonical
  scanner. The structured Cookie and Set-Cookie paths continue to inspect
  cookie names, values, and attribute names without flattening their semantics.
- Whole-wire header proof: raw `code_verifier`, case-varied `Code_Verifier`,
  encoded `code%5Fverifier`, and a protected-token header name all turn red.
  Raw `x-canopy-proof`, encoded `x%2Dcanopy-proof`, and a literal-percent
  header-name control remain green.
- Percent grammar: the decoder now uses a documented left-to-right grammar with
  three states—complete encoded octets, literal percent, and malformed
  percent—instead of enumerating suffix shapes. Raw input admits only complete
  `%HH` octets. After one decode, an incomplete percent whose provenance is a
  direct `%25` is terminal literal data; after the second bounded decode, the
  same incomplete grammar state crossed a recursive boundary and is malformed.
  A complete octet still present at the two-pass ceiling is recursive. The 8
  KiB ceiling, two-pass ceiling, raw scans, and C0/DEL rejection remain intact.
- Exact attacks and property suite: nested `%2525G_`, `%2525G-`, `%2525_G`,
  and `%2525G` turn red, while direct `100%25` data stays green. The permanent
  corpus contains 51 named expected-red cases plus the full suffix product of
  `G`, `_`, and `-` at lengths zero through two (13 suffixes), exercised across
  URL, form-name, form-value, header-name, and header-value channels. Every
  nested recursive form is red and every corresponding direct-literal-percent
  control is green; no suffix-shape list exists in the implementation.
- Gates: ordered `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (34 files / 413 tests), and `pnpm build` passed. Exact candidate
  `make verify-E3-T02` passed the same suite/build, production and emulator
  topology, all 51 named sensitivities and both 13-suffix property matrices,
  and the complete browser proof at 39 observations / 605 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
- Regression, policy, and cold clone: exact candidate `make verify-E2-T04`
  passed all 413 tests, production build, Auth0 61/61, emulator 6/6, auth
  10/10, clean browser telemetry, and terminal `verify-E2-T04: OK`.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery exception
  is the caught expected-red synthetic mutation. `tools/verify/cold_clone.sh
  verify-E3-T02` cloned exact
  `19fc16317999b490ffb78294d1333ef3c16e2515`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated from the
  lockfile-verified store under the scrubbed environment, repeated all 413
  tests and the complete verifier, and ended `cold_clone: verify-E3-T02 PASSED
  from a pristine clone`.
- Browser evidence reuse: the scoped implementation diff from `c1c35ed` to
  `19fc163` changes only `packages/browser-verify/src/index.ts`, the
  wire-sensitivity harness, and its transcript; there is no `apps/web` or
  shipped UI/runtime hunk. The accepted
  `recordings/e3-t02-run2-short-final.mp4` remains the browser artifact (H.264,
  1280x720, 30 fps, 9.2 s; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
- Replay: N/A (tenant policy denied external upload) + mitigation: the accepted
  same-session local MP4, refreshed full-wire Playwright transcript, permanent
  named and property sensitivity corpus, exact-head E3/E2 gates, policy gate,
  and pristine-clone proof stand in. No upload, recording ID, or Replay URL is
  claimed.

### 2026-07-28 — judge round 7 — VERDICT: refuted

- P1 mixed percent-sequence grammar — FAILED. Predicted each percent occurrence
  in a recorded URL, form name/value, header name/value, or cookie component
  would retain its own provenance through the bounded canonical scan. Observed
  `%25%2525G`, `%25x%2525G_`, `left%25middle%2525G-right`, and
  `%2525G%25` all return unexpected green in URL query values, form names and
  values, non-cookie header names and values, and ordinary cookie values. A
  protected literal `critic`, encoded as
  `%25%252563%252572%252569%252574%252569%252563`, also returns green.
  `classifyPercentGrammar` stops at the first incomplete percent occurrence at
  `packages/browser-verify/src/index.ts:723-740`, and
  `canonicalPercentDecode` treats any pass-zero malformed classification as
  terminal literal data for the complete component at
  `packages/browser-verify/src/index.ts:772-775`; later complete or recursively
  encoded sequences are therefore never classified. Demand: track
  percent grammar and provenance per occurrence, or continue classifying later
  complete sequences after admitting a direct `%25` literal, then promote the
  mixed-order and multiple-sequence examples across every affected channel.
- COVERAGE property matrix — INSUFFICIENT. Predicted the claimed generated
  grammar proof would vary percent occurrence count and adjacency as well as
  suffix shape. Observed the 13-suffix matrix at
  `tools/verify/e3_t02_wire_sensitivity.mjs:574-623` emits exactly one percent
  sequence per tested component, so it cannot detect a direct literal percent
  masking a later nested sequence. Demand: add generated adjacency/order cases
  with at least two percent sequences, including a hidden protected-literal
  sensitivity, while retaining the existing direct `%25` green controls.
- The run-6 findings are repaired. Independent raw `code_verifier`,
  case-varied `Code_Verifier`, encoded `code%5Fverifier`, and protected-literal
  header-name probes all turned red; safe raw and encoded header names remained
  green. Nested `%2525G_`, `%2525G-`, `%2525_G`, and `%2525G` turned red,
  while their direct `%25` controls stayed green. Structured cookie handling
  also survived: an exact single-session request-cookie exception remained
  green and an encoded `code_verifier` ordinary cookie name turned red.
- Surviving checks: independent exact-submission `make verify-E3-T02` passed at
  `0be4e8ee36c4a3b423702f6115ef5e01be468b0c`, re-earning format, lint,
  typecheck, all 34 test files / 413 tests, production builds, Auth0 61/61,
  emulator 6/6, all 51 committed sensitivities, both 13-suffix matrices, and
  the browser proof with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`; that green
  result demonstrates the permanent-suite gap above. The proportional E2-T04
  critic rerun was stopped after the counterexample became conclusive; the
  builder's exact-candidate E2-T04, policy, and pristine-clone passes remain
  committed claims rather than redundant independent reruns.
- COVERAGE and browser evidence: the run-7 implementation diff
  `c1c35ed67131f8a73e1b7548578b24da9524a407..19fc16317999b490ffb78294d1333ef3c16e2515`
  changes only `packages/browser-verify/src/index.ts`, the sensitivity harness,
  and its transcript; there is no shipped UI/runtime hunk. Reusing the accepted
  walkthrough remains honest. Local
  `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this local verified
  MP4, the full Playwright transcript, stream/digest receipts, exact-submission
  E3 gate, and committed cold-clone proof; no upload or Replay URL is claimed.
- Lifecycle: failed verification run 7 at exact submission
  `0be4e8ee36c4a3b423702f6115ef5e01be468b0c`, candidate
  `19fc16317999b490ffb78294d1333ef3c16e2515`. E3-T02 returns to
  `in-progress`; the project remains `building`. The accepted runs-4-6
  progress audit authorizes builder run 8. If run 9 does not verify, a separate
  fresh progress critic must durably audit the complete runs 7-9 window before
  any builder run 10. SUITE: retain all 51 named sensitivities and both current
  property matrices; add mixed-adjacency/order coverage with the repair.

### 2026-07-28 — builder run 8 — CLAIM: implemented

- Candidate: `ef3207c5be34f3e3c41b66550107fec1ec136577`, directly above
  canonical run-7 refutation
  `ae23e6b3b2555292bc1dfebf80a76972a759cddb`. Canonical percent
  decoding now represents each character as a unit and records an independent
  provenance depth on every percent emitted by decoding. The left-to-right
  grammar scans all occurrences: an incomplete depth-one percent remains
  direct literal `%25` data, but it never terminates classification of later
  complete, nested, or malformed occurrences. Incomplete depth-two input fails
  closed, and valid adjacent percent-octet runs decode together so UTF-8
  semantics remain intact. The two-pass and 8 KiB bounds, raw scans, and
  C0/DEL controls are unchanged; there are no input-shape special cases.
- Exact run-7 counterexamples: `%25%2525G`, `%25x%2525G_`,
  `left%25middle%2525G-right`, and `%2525G%25` now turn red independently
  in URL names/values, form names/values, non-cookie header names/values,
  request-cookie names/values, Set-Cookie cookie names/values, and Set-Cookie
  attribute names/values. The hidden protected literal `critic` in
  `%25%252563%252572%252569%252574%252569%252563` turns red in the same
  twelve positions.
- Permanent suite: all previous 51 named sensitivities survive and the five
  mixed cases across twelve component positions add 60, for 111 named
  expected-red cases. The generated mixed-order matrix crosses all 13 suffixes
  over four adjacent/separated/literal-before/literal-after/multiple-percent
  templates and all twelve positions (624 expected-red observations). Five
  clean mixed-percent templates across the same twelve positions add 60 green
  controls, while both prior 13-suffix red/green property matrices remain.
- Gates: ordered `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (34 files / 413 tests), and `pnpm build` passed. Exact candidate
  `make verify-E3-T02` passed the same suite/build, production and emulator
  topology, all named and generated sensitivities, and the complete browser
  proof at 39 observations / 605 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`; terminal
  `verify-E3-T02: OK`.
- Regression, policy, and cold clone: exact candidate `make verify-E2-T04`
  passed all 413 tests, production build, Auth0 61/61, emulator 6/6, auth
  10/10, clean browser telemetry, and terminal `verify-E2-T04: OK`.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery exception
  is the caught expected-red synthetic mutation. `tools/verify/cold_clone.sh
  verify-E3-T02` cloned exact
  `ef3207c5be34f3e3c41b66550107fec1ec136577`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated from the
  lockfile-verified store under the scrubbed environment, repeated all 413
  tests and the complete verifier, and ended `cold_clone: verify-E3-T02 PASSED
  from a pristine clone`.
- Browser evidence reuse: the scoped implementation diff from `ae23e6b` to
  `ef3207c` changes only `packages/browser-verify/src/index.ts`, the
  wire-sensitivity harness, and its transcript; there is no `apps/web` or
  shipped UI/runtime hunk. The accepted
  `recordings/e3-t02-run2-short-final.mp4` remains the browser artifact (H.264,
  1280x720, 30 fps, 9.2 s; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
- Replay: N/A (tenant policy denied external upload) + mitigation: the accepted
  same-session local MP4, refreshed full-wire Playwright transcript, permanent
  named and generated mixed-sequence sensitivity corpus, exact-head E3/E2
  gates, policy gate, and pristine-clone proof stand in. No upload, recording
  ID, or Replay URL is claimed.

### 2026-07-28 — judge round 8 — VERDICT: refuted

- P1 same-depth adjacent percent octets — FAILED. Predicted a single encoding
  layer representing literal `%AB` would remain green. Observed `%25%41%42`
  fail as `malformed percent encoding` in all twelve claimed positions: URL,
  form, non-cookie header, request Cookie, and response Set-Cookie
  names/values/attributes. The same 12/12 failure occurs for
  `%25%64%65%61%64%62%65%65%66`, `%25%41%42%25%43%44`, and
  `left%25%41%42middle%25%43%44right`. These are unambiguously same-layer
  encoded bytes, not the recursive ambiguity of a raw `%25AB`.
- Root cause: `PercentUnit` preserves provenance only on percent characters at
  `packages/browser-verify/src/index.ts:712-718`; decoded `A`/`B` characters
  lose their same-pass provenance at `:795-798`. On pass two the classifier at
  `:736-755` therefore reinterprets a depth-one literal percent followed by
  same-pass decoded hex characters as a deeper `%AB` octet, and the bounded
  decoder at `:823-845` rejects it. This contradicts the run-8 claim that valid
  adjacent percent-octet runs preserve their UTF-8 semantics.
- COVERAGE safe controls — INSUFFICIENT. The five clean mixed templates at
  `tools/verify/e3_t02_wire_sensitivity.mjs:763-769` avoid a literal percent
  followed by two same-layer encoded hex characters, so their sixty green
  observations cannot detect this false positive. Preserve provenance for
  every decoded unit, or otherwise prevent same-pass decoded hex characters
  from being reinterpreted as a deeper octet; promote the four safe examples
  above across all twelve positions.
- Surviving checks: independent exact-submission `make verify-E3-T02` passed at
  `5b5e3416574de0e419455765c8a3d70958567a63`, re-earning format, lint,
  typecheck, all 34 test files / 413 tests, production builds, Auth0 61/61,
  emulator 6/6, all 111 named sensitivities, the 624 generated mixed expected
  reds, sixty mixed green controls, the browser proof at 39 observations / 605
  fields with `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`,
  self-check and board audit, and terminal `verify-E3-T02: OK`. The new safe
  controls demonstrate why that green gate is insufficient. The builder's
  exact-candidate E2-T04, policy, and pristine-clone passes remain committed
  claims; they were not redundantly rerun after the conclusive counterexample.
- COVERAGE and browser evidence: the run-8 implementation diff
  `ae23e6b3b2555292bc1dfebf80a76972a759cddb..ef3207c5be34f3e3c41b66550107fec1ec136577`
  remains verifier-only: scanner, sensitivity harness, and transcript. Reusing
  the accepted walkthrough is honest. Local
  `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this local verified
  MP4, the full Playwright transcript, stream/digest receipts, exact-submission
  E3 gate, and committed cold-clone proof; no upload or Replay URL is claimed.
- Lifecycle: failed verification run 8 at exact submission
  `5b5e3416574de0e419455765c8a3d70958567a63`, candidate
  `ef3207c5be34f3e3c41b66550107fec1ec136577`. E3-T02 returns to
  `in-progress`; the project remains `building`. The accepted runs-4-6 progress
  audit authorizes builder run 9. If run 9 fails, a separate fresh progress
  critic must durably audit the complete runs 7-9 window before any builder run
  10. SUITE: retain all 111 named sensitivities and every generated red/green
  property matrix; add the four same-depth safe controls across all twelve
  positions with the repair.

### 2026-07-28 — builder run 9 — CLAIM: implemented

- Candidate: `b61d6d3089fbcd900f64813eea6b534ff0de30dc`, directly above
  canonical run-8 refutation
  `70ef36f2197d6d6cdbd299fa46bcc36e30146c93`. Every decoded unit now
  carries its decode-pass depth, not only percent characters. At depth zero,
  complete `%HH` input decodes normally. At deeper levels, a percent begins
  another escape only when both hex units came from a shallower depth; hex
  units emitted in the same pass remain literal neighbors. Adjacent encoded
  byte runs decode only while their source depths match, preserving UTF-8 and
  per-pass provenance without input-shape cases. Depth-two malformed or
  residual recursively encoded input still fails closed; the two-pass and 8
  KiB bounds, raw scans, and C0/DEL controls are unchanged.
- Exact run-8 controls: `%25%41%42`,
  `%25%64%65%61%64%62%65%65%66`, `%25%41%42%25%43%44`, and
  `left%25%41%42middle%25%43%44right` are green independently in URL
  names/values, form names/values, non-cookie header names/values,
  request-cookie names/values, Set-Cookie cookie names/values, and Set-Cookie
  attribute names/values: 48 exact controls.
- Permanent suite: all prior 111 named expected-red cases, the 13-suffix
  matrices, the 624 mixed-order expected-red observations, and the 60 prior
  mixed green controls survive. A generated matrix crosses 36 decoded hex
  pairs over all twelve component positions (432 green same-depth octet-run
  controls); its corresponding genuinely nested forms are red in the same 432
  positions, proving the repair does not disable deeper recursive detection.
- Gates: ordered `pnpm format:check && pnpm lint`, `pnpm typecheck`,
  `pnpm test` (34 files / 413 tests), and `pnpm build` passed. Exact candidate
  `make verify-E3-T02` passed the same suite/build, production and emulator
  topology, all named and generated sensitivities, and the complete browser
  proof at 39 observations / 605 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`; terminal
  `verify-E3-T02: OK`.
- Regression, policy, and cold clone: exact candidate `make verify-E2-T04`
  passed all 413 tests, production build, Auth0 61/61, emulator 6/6, auth
  10/10, clean browser telemetry, and terminal `verify-E2-T04: OK`.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery exception
  is the caught expected-red synthetic mutation. `tools/verify/cold_clone.sh
  verify-E3-T02` cloned exact
  `b61d6d3089fbcd900f64813eea6b534ff0de30dc`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated from the
  lockfile-verified store under the scrubbed environment, repeated all 413
  tests and the complete verifier, and ended `cold_clone: verify-E3-T02 PASSED
  from a pristine clone`.
- Browser evidence reuse: the scoped implementation diff from `70ef36f` to
  `b61d6d3` changes only `packages/browser-verify/src/index.ts`, the
  wire-sensitivity harness, and its transcript; there is no `apps/web` or
  shipped UI/runtime hunk. The accepted
  `recordings/e3-t02-run2-short-final.mp4` remains the browser artifact (H.264,
  1280x720, 30 fps, 9.2 s; SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`).
- Replay: N/A (tenant policy denied external upload) + mitigation: the accepted
  same-session local MP4, refreshed full-wire Playwright transcript, permanent
  named and generated same-depth/deeper sensitivity corpus, exact-head E3/E2
  gates, policy gate, and pristine-clone proof stand in. No upload, recording
  ID, or Replay URL is claimed.
- Lifecycle note: if a critic refutes run 9, no run 10 may begin until a fresh
  progress critic durably audits the complete runs 7-9 window and records
  `progressing`.

### 2026-07-28 — judge round 9 — VERDICT: refuted

- P1 same-depth protected-literal decoding — FAILED. Predicted provenance would
  keep the harmless same-pass `%25%41%42` control green without suppressing a
  credential that an ordinary second canonical decode exposes. Observed
  `%25%36%33ritic` return green with `secretLiterals: ["critic"]` in all twelve
  wire positions: URL name/value, form name/value, non-cookie header name/value,
  request Cookie name/value, Set-Cookie cookie name/value, and Set-Cookie
  attribute name/value. The ordinary decode sequence is
  `%25%36%33ritic` -> `%63ritic` -> `critic`. The first pass assigns the percent,
  `6`, and `3` the same depth at
  `packages/browser-verify/src/index.ts:784-814`; `isEncodedPercentAt` then
  suppresses that second interpretation at `:739-755`, so
  `canonicalPercentDecode` never places `critic` in the representations inspected
  for secrets at `:817-855`. Demand: preserve the same-depth spelling as a
  non-error green path, but also inspect its alternate bounded canonical
  representation for protected literals; promote this exact case and generated
  per-character mixed raw/encoded variants across all twelve positions.
- COVERAGE same-depth matrix — INSUFFICIENT. Predicted the new property corpus
  would vary whether same-depth hex octets can themselves spell a protected
  percent escape. Observed the 36-pair matrix at
  `tools/verify/e3_t02_wire_sensitivity.mjs:791-809` runs with
  `secretLiterals: []`; it proves only green/error classification and cannot
  detect the credential false negative above. An independent 4-way per-character
  encoding search found the same class in multiple forms, including
  `c%25%37%32itic` -> `c%72itic` -> `critic`. Demand: add a red property matrix
  whose decoded target is a protected literal while retaining all current safe
  green controls.
- Surviving checks: independent exact-submission `make verify-E3-T02` passed at
  `7f34d56deb0a1077f070015e0367c6a8e8b150e4`, re-earning format, lint,
  typecheck, all 34 test files / 413 tests, production builds, Auth0 61/61,
  emulator 6/6, all 111 named sensitivities, the 48 exact same-depth controls,
  both 432-observation same-depth/deeper matrices, and the browser proof with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`; that green result
  demonstrates the permanent-suite gap. The work-queue policy independently
  exited 0 with `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery
  exception was the caught expected-red mutation. The builder's exact-candidate
  E2-T04 and pristine-clone passes remain committed claims and were not
  redundantly rerun after the conclusive counterexample.
- COVERAGE and browser evidence: every executable run-9 scanner hunk is exercised
  by the named/generated verifier, while the interface/comment changes are
  waived; the missing protected-literal dimension above prevents sufficiency.
  The run-9 diff remains verifier-only, with no shipped UI/runtime hunk, so reuse
  of the accepted walkthrough is honest. Local
  `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this local verified
  MP4, the full Playwright transcript, stream/digest receipts, exact-submission
  E3 gate, and committed cold-clone claim; no upload or Replay URL is claimed.
- Lifecycle: failed verification run 9 at exact submission
  `7f34d56deb0a1077f070015e0367c6a8e8b150e4`, candidate
  `b61d6d3089fbcd900f64813eea6b534ff0de30dc`. E3-T02 returns to
  `in-progress`; the project remains `building`. No builder run 10 may begin
  until a separate fresh progress critic durably audits the complete runs 7-9
  window and records `progressing`. SUITE: retain all existing named and
  generated red/green cases; add the protected-literal alternate-decode matrix
  with the repair.

### 2026-07-28 — progress critic — RUNS 7-9: progressing

- Rationale: Runs 7-9 materially converge without weakening an earlier boundary.
  Run 7 replaced the run-6 suffix heuristic with per-occurrence grammar, added
  non-cookie header-name coverage, and grew the permanent corpus to 51 named
  expected reds plus red/green generated suffix matrices; the newly exposed
  failure was compositional, where one admitted literal percent masked a later
  encoded occurrence. Run 8 made classification continue across every occurrence,
  closed all mixed-order and hidden-literal attacks in twelve wire positions, and
  compounded the suite to 111 named expected reds, 624 mixed-order reds, and 60
  mixed green controls; its failure was the dual false positive caused by losing
  provenance on decoded non-percent units. Run 9 preserved provenance for every
  decoded unit, closed the four same-depth false positives in all twelve positions,
  and added paired 432-observation green/red matrices while all earlier reds and
  gates survived. Its remaining false negative is narrower and mechanically
  explained: the validity grammar correctly protects the literal spelling
  `%25%41%42`, but the secret scanner does not separately inspect successful
  alternate bounded decodings such as `%25%36%33ritic` to `%63ritic` to `critic`.
  That is a missing representation-search dimension, not a renamed prior finding
  or a regression. One final run is justified only by separating primary grammar
  validity from bounded alternate representations used for secret matching; any
  further enumerative exception or any non-verified run-10 verdict stops the loop.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-7 — Confirms the run-6 header-name and malformed-terminal findings were repaired, then isolates mixed percent occurrence ordering and missing multi-occurrence property coverage.
- Evidence (diff): ae23e6b3b2555292bc1dfebf80a76972a759cddb..ef3207c5be34f3e3c41b66550107fec1ec136577 — Resolves to the run-8 per-occurrence provenance implementation and its twelve-position mixed red/green corpus expansion.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-8 — Confirms the run-7 mixed-order and hidden-literal counterexamples are closed while identifying the same-depth decoded-unit provenance false positive.
- Evidence (commit): b61d6d3089fbcd900f64813eea6b534ff0de30dc — Resolves to the run-9 every-unit provenance repair and paired same-depth/deeper property corpus.
- Evidence (report): .eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-run-9 — Confirms all run-8 safe controls are green and all earlier red matrices survive, then isolates the missing alternate bounded representation `%25%36%33ritic` to `critic`.
- Next focus: Implement a principled bounded representation search separate from the primary provenance grammar: retain the primary grammar as the sole malformed/recursive validity decision, but collect every successfully decoded representation reachable within the existing two-pass and 8 KiB bounds for protected-literal matching. A failed alternate decode must not turn safe `%25%41%42` into an error; a successful alternate path must expose `%25%36%33ritic` as `critic`.
- Next focus: Promote `%25%36%33ritic` and `c%25%37%32itic` as exact expected-red cases in all twelve wire positions, then generate a protected-literal red property matrix over per-character raw/percent-encoded spellings and alternate percent-octet placements across all twelve positions. Retain `%25%41%42`, the other 47 exact same-depth controls, and the complete same-depth green property matrix unchanged.
- Next focus: Run 10 must retain all 111 named expected reds, every existing generated red/green matrix, raw scanning, structured Cookie/Set-Cookie exceptions, C0/DEL and malformed/recursive bounds, then pass ordered root gates, `make verify-E3-T02`, `make verify-E2-T04`, `make verify-E2-T12`, work-queue policy/self-check, and one exact-head pristine `tools/verify/cold_clone.sh verify-E3-T02`. Run 10 is the absolute autonomous ceiling: any non-verified verdict records `invalid_loop` before another builder call.
- Assessment: progressing

### 2026-07-28 — judge round 10 — VERDICT: refuted

- P1 encoded URL-path protected literals — FAILED. Predicted the claimed
  full-URL credential scan would expose a protected literal after the same
  bounded percent representations regardless of whether it appeared in a
  query component or a path segment. Observed all five independent path probes
  return unexpected green with `secretLiterals: ["critic"]`:
  `/%63ritic`, `/%2563ritic`, `/%25%36%33ritic`, `/c%72itic`, and
  `/%63%72%69%74%69%63`. The scanner raw-inspects the full URL at
  `packages/browser-verify/src/index.ts:1172`, but calls the canonical and
  alternate representation search only for query names and values at
  `:1173-1187`; an encoded path is therefore outside the matcher despite being
  part of the recorded request URL. Demand: human intervention is required
  before any rework because run 10 is the absolute autonomous ceiling.
- COVERAGE full-URL claim — INSUFFICIENT. Predicted the permanent property
  corpus would include every semantically decoded URL component covered by the
  transcript's `full-url` claim. Observed `componentObservations` generate only
  URL query name/value positions before the header and cookie positions at
  `tools/verify/e3_t02_wire_sensitivity.mjs:568-659`; no encoded path case
  exists, so the green exact gate cannot detect this escape. The critic's
  five-case path property failed 5/5. Demand: any human-authorized recovery must
  add encoded path-segment reds without weakening the same-depth green controls.
- The run-9 findings are repaired. Independently, both
  `%25%36%33ritic` and `c%25%37%32itic` produced a `secret literal`
  finding in all twelve committed positions, `%25%41%42` remained green in all
  twelve, and all 4,096 per-character spellings across twelve positions
  produced actual `secret literal` findings (49,152 checks rather than passing
  on a generic percent error). Malformed, control, recursive/header-name,
  request Cookie, and HttpOnly Set-Cookie boundaries survived. The committed
  transcript retains 135 unique named expected reds plus every prior red/green
  matrix and ends `E3_T02_WIRE_SENSITIVITY_OK mutations=135`.
- Gates and cold-clone evidence: the independent work-queue policy completed
  all 127 scenarios and exited 0 with `WORK_QUEUE_POLICY_OK`. An exact-head
  `make verify-E3-T02` rerun re-earned format, lint, and typecheck, then hit the
  known long-poll registry-test timeout after 125 seconds; the critic stopped
  the already-failed run after the scanner counterexample became conclusive and
  does not raise that environmental/pre-existing failure as a finding. The
  builder's pristine-clone receipt names exact implementation
  `16d3d4fcd06ee5dae9d806c2e26e5643600ab6a8`, whose direct parent is the
  committed runs-7-9 audit; no contradictory cold-clone artifact was found,
  but its green verifier also lacks the encoded-path attack above.
- COVERAGE and browser evidence: the run-10 diff is confined to the credential
  verifier, sensitivity harness/transcript, task log, and generated queue; no
  shipped `apps/web` or platform-runtime hunk changed, so walkthrough reuse is
  honest. Local `recordings/e3-t02-run2-short-final.mp4` independently matches
  SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: the verified local
  MP4, full Playwright transcript, stream/digest receipts, sensitivity corpus,
  policy proof, and inspected pristine-clone receipt; no upload retry or Replay
  URL is claimed.
- SUITE: the critic attack was kept outside implementation because this verdict
  cannot edit implementation and run 10 cannot authorize rework. A future
  human-authorized recovery must promote encoded URL-path protected-literal
  cases before another claim.
- Lifecycle: failed verification run 10 at exact submission
  `21a4e6a1324c000fc13f97c3b8b6e4b90c73baeb`, implementation
  `16d3d4fcd06ee5dae9d806c2e26e5643600ab6a8`. E3-T02 returns to
  `in-progress`; the project is `invalid_loop`. No builder run 11 is
  authorized.

### 2026-07-28 — human resume — RUNS 11-13 authorized

- Authorization: APPROVED
- Task: E3-T02
- Stopped after run: 10
- Authorized runs: 11-13
- Scope: control-plane recovery transition and E3-T02 verification only

### 2026-07-28 — builder run 11 — CLAIM: implemented

- Candidate: `0caa2c88ddbeec208feae5a72f0e6d1a1c1b0c2e`, directly above
  the bound human-recovery head
  `c1a0371bda81d5711aa2567641ff5b7e9557256f`. The scanner now
  isolates every raw URL pathname segment and routes it through the same
  `inspectCanonical` path already used for query, form, header, and cookie
  components. Canonical provenance remains the sole validity/error decision;
  the bounded ordinary alternate representations remain exclusively
  protected-secret matching inputs.
- Exact run-10 attacks: `/%63ritic`, `/%2563ritic`,
  `/%25%36%33ritic`, `/c%72itic`, and
  `/%63%72%69%74%69%63` each produce a `secret literal` finding.
  The permanent generated path matrix crosses all 4,096 four-way
  per-character spellings of `critic` through a path segment and requires an
  actual `secret literal` result for every spelling.
- Safe controls and retained suite: `%25%41%42` and the other three exact
  same-depth families remain green in URL paths with
  `secretLiterals: ["critic"]`. All prior 135 named expected reds and every
  existing red/green matrix survive; the five path probes bring the named
  total to 140. The existing 4,096-spelling twelve-position protected-literal
  matrix remains green as a sensor, alongside the new 4,096-spelling path
  matrix.
- Ordered gates: the first chain stopped at format, the scanner was
  mechanically formatted, and the entire chain restarted from the top.
  `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm
  build` then passed with 34 files / 413 tests and a production build. Exact
  candidate `make verify-E3-T02` passed all 140 named reds, both
  4,096-spelling matrices, all retained matrices, and the complete browser
  receipt at 39 network observations / 611 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`; terminal
  `verify-E3-T02: OK`.
- Regression, policy, and pristine clone: exact `make verify-E2-T04` passed
  its full Auth0/emulator/session browser closure with zero console warnings,
  errors, or uncaught exceptions and ended `verify-E2-T04: OK`. Exact
  `make verify-E2-T12` passed its capstone browser proof and E2-T07 through
  E2-T11 regression/sensitivity closure, ending `verify-E2-T12: OK`.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios; its printed recovery exception
  is the caught expected-red mutation. `tools/verify/self_check.sh` exited 0
  with `CANOPY_SENSITIVITY_SPINE_OK`. The exact-head
  `tools/verify/cold_clone.sh verify-E3-T02` cloned
  `0caa2c88ddbeec208feae5a72f0e6d1a1c1b0c2e`, checked out pinned
  emulate `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated under the
  scrubbed environment, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Coverage and browser evidence reuse: the implementation diff
  `c1a0371bda81d5711aa2567641ff5b7e9557256f..0caa2c88ddbeec208feae5a72f0e6d1a1c1b0c2e`
  changes only `packages/browser-verify/src/index.ts`, the wire-sensitivity
  harness, and its transcript; no `apps/web` or shipped platform/UI hunk
  changed. The accepted `recordings/e3-t02-run2-short-final.mp4` was
  independently revalidated as H.264/yuv420p, 1280x720, 30 fps, 9.2 seconds,
  227988 bytes, SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`.
- Replay: N/A (tenant policy denied external upload) + mitigation: the
  accepted local MP4, full Playwright transcript, stream/digest receipts,
  complete named/generated sensitivity corpus, exact E3/E2 gates,
  policy/self-check, and pristine-clone proof stand in. No upload was retried,
  and no recording ID or Replay URL is claimed.

### 2026-07-28 — judge round 11 — VERDICT: refuted

- P1 raw pathname preservation through URL normalization — FAILED. Predicted
  every raw encoded pathname segment would reach `inspectCanonical` before any
  parser normalization could erase it. After rebuilding exact implementation
  `0caa2c88ddbeec208feae5a72f0e6d1a1c1b0c2e`, observed all of
  `http://127.0.0.1/%63ritic/..`,
  `http://127.0.0.1/%2563ritic/..`,
  `http://127.0.0.1/%25%36%33ritic/..`, and relative
  `/a/%63ritic/%2e%2e/b` return green with
  `secretLiterals: ["critic"]`. `new URL(...).pathname` normalizes those
  targets to `/` or `/a/b` before the loop at
  `packages/browser-verify/src/index.ts:1173-1181` inspects segments; the raw
  full-URL check at `:1172` cannot see the percent-decoded secret. Demand:
  derive and inspect raw pathname segments without allowing URL dot-segment
  normalization to remove them, while retaining the parsed view only as an
  additional representation.
- COVERAGE normalized-path removal — INSUFFICIENT. Predicted the permanent
  path property corpus would vary delimiters and normalization behavior as
  well as character encodings. Observed the five named probes at
  `tools/verify/e3_t02_wire_sensitivity.mjs:672-691` and the 4,096-spelling
  matrix at `:755-765` generate a single ordinary path segment only; none puts
  that segment before literal or encoded `..`. This leaves the exact branch
  above unmeasured. Promote direct, nested, and same-depth protected literals
  before both literal `..` and `%2e%2e`, for absolute and relative targets.
- P2 work-queue policy claim — FAILED. Predicted the builder's cited exact
  command would still exit 0 at submission head. Observed
  `node packages/identity/scripts/verify-work-queue-policy.mjs` exit nonzero
  with `recovery commit escaped its exact lifecycle path set` from
  `work-queue-snapshot.mjs:295-314`. The task-global recovery lineage itself
  remains valid: two fresh trusted-commit readers returned byte-identical
  snapshots at submission
  `d6dd6e00027730d83f6d5cb2a71474f12d141143`, recording project
  `building`, gate E3-T02, ceiling 13, and the unchanged ten-verdict /
  three-audit prefix. Demand: reproduce and repair the policy apparatus
  failure without weakening its exact-path checks, then restart the ordered
  candidate gates.
- Surviving scanner checks: the exact rebuilt
  `e3_t02_wire_sensitivity.mjs` run retained all 140 named expected reds, the
  prior query/form/header/Cookie/Set-Cookie matrices, the 4,096-spelling
  twelve-position matrix, and the new 4,096-spelling path matrix. The path
  matrix requires an actual `secret literal` finding, not a generic percent
  error. Independent controls confirmed encoded slash, literal and encoded
  path-parameter delimiters, a UTF-8 prefix, empty/repeated/trailing segments,
  and the run-10 five probes red, while path `%25%41%42` stayed green.
  `tools/verify/self_check.sh` ended `CANOPY_SENSITIVITY_SPINE_OK`. The full
  root/E2/browser gates were not redundantly rerun after the two conclusive
  failures; the builder's exact-head pristine-clone receipt was inspected and
  is internally commit-bound, but its green suite lacks the normalization
  attack above.
- COVERAGE and browser evidence: every executable run-11 hunk is reached by
  the named/generated path verifier, but the missing normalized-away path
  family prevents sufficiency; no skipped/todo test, lint disable, or blessed
  golden appears in the scoped diff. The implementation is verifier-only, so
  browser walkthrough reuse remains honest. Local
  `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this local verified
  MP4, full Playwright/stream receipts, sensitivity corpus, and committed
  cold-clone claim; no upload retry or Replay URL is claimed.
- Lifecycle: failed verification run 11 at exact submission
  `d6dd6e00027730d83f6d5cb2a71474f12d141143`, implementation
  `0caa2c88ddbeec208feae5a72f0e6d1a1c1b0c2e`. E3-T02 returns to
  `in-progress`; the project remains `building`; authorized run 12 may
  proceed. If run 12 is refuted, a separate fresh progress critic must audit
  complete runs 10-12 and durably record `progressing` before run 13.
  SUITE: retain the complete existing red/green corpus and add the raw
  pathname normalization family with the repair.

#### Critic correction — policy command terminal result

- RETRACTION: the judge round 11 bullet titled `P2 work-queue policy claim —
  FAILED` is withdrawn in full. Its cited recovery exception came from an
  expected-red child process and was intermediate output, not the command's
  terminal result.
- Correct terminal evidence: after waiting for the same exact command,
  `node packages/identity/scripts/verify-work-queue-policy.mjs` completed all
  127 scenarios, emitted
  `{"scenarios":127,"status":"WORK_QUEUE_POLICY_OK"}`, and exited 0. The
  builder's work-queue policy claim therefore survives.
- Scope: this correction changes no other run-11 finding or lifecycle fact.
  The normalized-away raw pathname counterexample and its coverage gap remain
  conclusive; judge round 11 remains `refuted`, E3-T02 remains
  `in-progress`, the project remains `building`, and authorized run 12 may
  proceed.

### 2026-07-28 — builder run 12 — CLAIM: implemented

- Candidate: `0fa375d9fbee8c8fbe740a1835e540a3b7a14af3`, directly above
  corrected canonical run-11 head
  `b7c211a9de21d813aca9be1cabbc9225113aee7b`. The scanner now
  extracts the raw request-target pathname before WHATWG parsing: absolute
  and scheme-relative authorities are removed without interpreting the path,
  then query/fragment delimiters bound the exact serialized pathname. Every
  raw segment reaches the existing `inspectCanonical` path before an
  additional normalized pathname representation is inspected. Parsed query
  behavior is unchanged; the provenance grammar remains the sole
  validity/error decision and alternate representations remain
  protected-secret-only inputs.
- Exact run-11 attacks: `/%63ritic/..`, `/%2563ritic/..`,
  `/%25%36%33ritic/..`, and `/a/%63ritic/%2e%2e/b` each produce
  `secret literal` for both relative and absolute request URLs: eight named
  reds. The generated normalization-removal matrix covers five protected
  spellings, three raw/encoded/nested dot spellings, five dot-dot spellings,
  leading/middle/trailing placement, and relative/absolute targets: 450
  required `secret literal` results.
- Safe controls and retained suite: nine safe path families pass for both
  relative and absolute targets, covering same-depth `%25%41%42` before
  dot-dot, legitimate raw/encoded/nested dot navigation, encoded slash, path
  parameters, UTF-8, repeated segments, and trailing segments. All prior 140
  named expected reds, both 4,096-spelling protected-literal matrices, and
  every earlier red/green matrix survive; the eight normalization probes
  bring the named total to 148.
- Ordered gates: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm
  test && pnpm build` passed with 34 files / 413 tests and a production build.
  Exact candidate `make verify-E3-T02` passed all 148 named reds, both
  4,096-spelling matrices, the 450-case normalization matrix, all safe and
  retained matrices, and the complete browser receipt at 39 network
  observations / 611 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`; terminal
  `verify-E3-T02: OK`.
- Regression, policy, and pristine clone: exact `make verify-E2-T04` passed
  its full Auth0/emulator/session browser closure with zero console warnings,
  errors, or uncaught exceptions and ended `verify-E2-T04: OK`. Exact
  `make verify-E2-T12` passed the capstone browser proof and E2-T07 through
  E2-T11 regression/sensitivity closure, ending `verify-E2-T12: OK`.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` was held
  through its expected-red child exception to terminal
  `WORK_QUEUE_POLICY_OK` across 127 scenarios and exit 0.
  `tools/verify/self_check.sh` exited 0 with
  `CANOPY_SENSITIVITY_SPINE_OK`. Exact-head
  `tools/verify/cold_clone.sh verify-E3-T02` cloned
  `0fa375d9fbee8c8fbe740a1835e540a3b7a14af3`, checked out pinned
  emulate `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated under the
  scrubbed environment, and ended
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Coverage and browser evidence reuse: the implementation diff
  `b7c211a9de21d813aca9be1cabbc9225113aee7b..0fa375d9fbee8c8fbe740a1835e540a3b7a14af3`
  changes only `packages/browser-verify/src/index.ts`, the wire-sensitivity
  harness, and its transcript; no `apps/web` or shipped platform/UI hunk
  changed. The accepted `recordings/e3-t02-run2-short-final.mp4` was
  independently revalidated as H.264/yuv420p, 1280x720, 30 fps, 9.2 seconds,
  227988 bytes, SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`.
- Replay: N/A (tenant policy denied external upload) + mitigation: the
  accepted local MP4, full Playwright transcript, stream/digest receipts,
  complete named/generated sensitivity corpus, exact E3/E2 gates, terminal
  policy/self-check, and pristine-clone proof stand in. No upload was retried,
  and no recording ID or Replay URL is claimed.

### 2026-07-28 — judge round 12 — VERDICT: refuted

- P1 encoded authority and userinfo coverage — FAILED. Predicted the raw
  request-target extraction would preserve every serialized URL component long
  enough for the same bounded canonical secret scan, including absolute and
  scheme-relative authorities. Observed
  `http://%63ritic@example.com/clean`,
  `//%63ritic@example.com/clean`,
  `http://example.com@%63ritic.test/clean`, and
  `//%63ritic.test` all return green with
  `secretLiterals: ["critic"]`. The raw full-URL check at
  `packages/browser-verify/src/index.ts:1198` does not percent-decode; then
  `rawUrlPathname` deliberately discards the authority at `:892-903`, and the
  normalized inspection at `:1212-1216` reads only `pathname`. An independent
  property attack crossed all 4,096 protected-literal spellings through
  absolute/scheme-relative userinfo and host forms: only the four all-raw
  `critic` spellings were found, while 16,380 encoded checks escaped. Safe
  authority, IPv6, and `%25%41%42` controls stayed green. Demand: inspect the
  serialized authority/userinfo as a separately bounded canonical component
  before discarding it, without treating safe same-depth authority literals or
  ordinary navigation as errors.
- COVERAGE request-target forms — INSUFFICIENT. Predicted the new property
  corpus would exercise every branch introduced by the absolute and
  scheme-relative extraction. Observed the permanent URL-path constructor at
  `tools/verify/e3_t02_wire_sensitivity.mjs:662-669` accepts only origin-form
  paths beginning with `/`; the 450-case matrix at `:792-825` varies path
  normalization but never places a protected spelling in userinfo or authority.
  Authority-form `%63ritic.example:443`, encoded `?`, `#`, slash and backslash
  within a path, query-bound secrets, IPv6-host paths, UTF-8 prefixes,
  leading/middle/trailing/empty segments, and raw/encoded/nested dot navigation
  were independently checked and behaved as predicted. The missing
  absolute/scheme-relative authority dimension is therefore narrow but
  conclusive. Demand: promote a generated protected-literal authority matrix
  across direct, nested, and same-depth encodings plus safe authority controls.
- Surviving suite and bounds: independent
  `node tools/verify/e3_t02_wire_sensitivity.mjs` passed all 148 named expected
  reds (the retained 140 plus the exact eight run-12 normalization reds), all
  450 normalization-removal cases with an actual `secret literal` finding, all
  18 normalization greens, both 4,096-spelling protected-literal matrices, the
  36-pair same-depth/deeper matrices, and the retained query, form, header,
  Cookie, and Set-Cookie regressions; terminal
  `E3_T02_WIRE_SENSITIVITY_OK mutations=148`. The named overlong,
  recursive, malformed, C0/DEL, and two-pass controls remain in that run.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` was held past
  its expected-red child exception and exited 0 with
  `WORK_QUEUE_POLICY_OK` across 127 scenarios.
  `tools/verify/self_check.sh` ended `CANOPY_SENSITIVITY_SPINE_OK`.
  Full root/E2/browser gates and the cold clone were not redundantly rerun after
  the independent authority property had conclusively refuted correctness; the
  builder's exact-head claims remain internally bound to implementation
  `0fa375d9fbee8c8fbe740a1835e540a3b7a14af3`.
- Recovery lineage and coverage: exact submission
  `7decedee4cf6aa6fb4606cd51f70bc0d05003a33` has candidate
  `0fa375d9fbee8c8fbe740a1835e540a3b7a14af3` as its direct parent, above
  corrected run-11 head
  `b7c211a9de21d813aca9be1cabbc9225113aee7b`; the human recovery bridge,
  authorization, ceiling 13, and unchanged run-10 invalid-loop checkpoint are
  reachable and the project is still `building`. Every executable run-12 hunk
  is reached by the named/generated path suite, but the untested authority
  stripping branch makes sufficiency fail; no skipped/todo test, lint disable,
  or blessed golden appears in the scoped implementation diff.
- Browser evidence: the scoped implementation is verifier-only, with no shipped
  app or platform-runtime hunk, so reuse remains honest. Local
  `recordings/e3-t02-run2-short-final.mp4` independently matches SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p at 1280x720 and 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: this verified local
  MP4, full Playwright/stream receipts, the sensitivity corpus, policy proof,
  and exact-head builder cold-clone claim; no upload retry or Replay URL is
  claimed.
- SUITE and lifecycle: the authority attack remained critic-local because this
  verdict cannot edit implementation. Failed verification run 12 returns
  E3-T02 to `in-progress`; the project remains `building`. No builder run 13
  may begin until a separate fresh progress critic audits the complete runs
  10-12 window and durably records `progressing`. If that audit does not record
  `progressing`, the recovery stops without consuming run 13.

### 2026-07-28 — progress critic — RUNS 10-12: progressing

- Rationale: Runs 10-12 materially converge toward one missing abstraction
  without weakening an earlier validity or safety boundary. Run 10 completed
  the bounded alternate-representation search while retaining the provenance
  grammar as the sole malformed/recursive validity decision and compounded the
  permanent corpus to 135 named reds plus a 49,152-check protected-literal
  matrix; its remaining miss was a raw request-target component the scanner
  never decomposed. Run 11 added path-segment decomposition and a separate
  4,096-spelling path matrix while every earlier red and same-depth green
  survived; its refutation showed that WHATWG normalization can delete raw path
  segments before inspection. Run 12 moved path extraction before WHATWG
  normalization, retained both raw and parsed representations, and added eight
  normalization reds, a 450-case removal matrix, and 18 safe controls while all
  prior matrices survived. Its remaining miss is the serialized authority that
  `rawUrlPathname` explicitly discards. The sequence is therefore converging
  from representation search to complete pre-normalization request-target
  decomposition, not cycling on a regressed boundary. Exactly one final run is
  justified only if it replaces component-specific extraction with a
  principled raw request-target representation and proves every semantic
  component before normalization or removal.
- Evidence (report):
  `.eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-round-10`
  — The encoded-path attack establishes that the completed alternate decoder
  worked in all twelve prior wire positions while path segments were absent
  from decomposition.
- Evidence (diff):
  `16d3d4fcd06ee5dae9d806c2e26e5643600ab6a8..0caa2c88ddbeec208feae5a72f0e6d1a1c1b0c2e`
  — The diff adds encoded path inspection and a separate 4,096-spelling path
  property matrix without removing the 135 named reds or same-depth greens.
- Evidence (report):
  `.eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-round-11`
  — The literal and encoded dot-segment attacks establish that run 11's
  encoded path closure survived, but its parsed-first pathname representation
  could erase the protected segment.
- Evidence (diff):
  `0caa2c88ddbeec208feae5a72f0e6d1a1c1b0c2e..0fa375d9fbee8c8fbe740a1835e540a3b7a14af3`
  — The diff moves raw path inspection ahead of normalization and compounds
  the suite with the 450-case removal matrix and safe navigation controls.
- Evidence (report):
  `.eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/readme.md#judge-round-12`
  — The independent 16,384-check authority property attack confirms the
  raw-path repair and all prior matrices survive, then isolates the
  authority/userinfo explicitly removed at
  `packages/browser-verify/src/index.ts:892-903`.
- Next focus: replace `rawUrlPathname`'s discard-first behavior with
  one bounded raw request-target decomposition that preserves every
  semantically relevant serialized component before WHATWG normalization:
  authority userinfo, host, and port; every path segment; and query names and
  values. It must recognize origin-form, absolute-form, scheme-relative, and
  authority-form targets. Inspect a fragment only when the observed serialized
  browser URL actually contains one; do not fabricate a fragment requirement
  for HTTP request targets that cannot carry it. Parsed/normalized URL fields
  may remain additional representations, never the first or only evidence.
- Next focus: promote the four exact run-12 authority failures,
  then add a generated authority property matrix spanning absolute and
  scheme-relative userinfo and host placement, authority-form host/port,
  direct/nested/same-depth/per-character encodings, and safe same-depth,
  ordinary host, port, IPv6, userinfo, and navigation controls. Exercise all
  parser branches, including absent userinfo, empty/default paths, query
  boundaries, and host/port separation. Retain all 148 named expected reds,
  every prior generated red and green matrix, raw and normalized path
  representations, structured Cookie/Set-Cookie exceptions, C0/DEL,
  malformed/recursive/overlong bounds, and the canonical provenance grammar as
  the sole validity decision. A test that passes on a generic percent error
  instead of the required `secret literal` finding is insufficient.
- Next focus: restart and pass
  `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`,
  `make verify-E3-T02`, `make verify-E2-T04`, `make verify-E2-T12`,
  terminal `WORK_QUEUE_POLICY_OK`, `tools/verify/self_check.sh`,
  `pnpm task-board:check`, and one exact-head pristine
  `tools/verify/cold_clone.sh verify-E3-T02`.
- Next focus: E3-T02 remains `in-progress`; the project remains `building`.
  Builder run 13 is the sole remaining authorized recovery run. Any non-verified
  run-13 verdict must set the project to `invalid_loop`; no run 14 is
  authorized.
- Assessment: progressing

#### Audit structure correction — recognized labels

The audit content above is unchanged in substance. This correction normalizes
its evidence citations and run-13 requirements into the trusted snapshot's
recognized `Evidence` and `Next focus` labels; it does not add a run, audit
window, implementation change, verdict, or authorization beyond run 13.

### 2026-07-28 — builder run 13 — CLAIM: implemented

- Candidate: `a96c82b7c4e7fc44a8f37fb38b82418b0d3e6469`, directly above
  the authorizing runs-10-12 progress audit
  `3b4425f8fb15addac0c95c601d5ee7c9aa004ed3`. The discard-first
  `rawUrlPathname` helper is gone. One bounded pre-WHATWG request-target
  decomposition now recognizes origin-form, absolute-form, scheme-relative
  form, and CONNECT authority-form targets and preserves raw userinfo, host,
  port, path segments, query names/values, and an observed serialized fragment
  before any URL normalization or component removal. Each semantic component
  is independently canonical/alternate-inspected within the existing two-pass
  and 8 KiB component bounds. The established provenance grammar remains the
  sole validity/error decision; alternate representations remain
  protected-secret-only.
- Exact attacks and generated closure: all four run-12 authority escapes now
  produce `secret literal`:
  `http://%63ritic@example.com/clean`,
  `//%63ritic@example.com/clean`,
  `http://example.com@%63ritic.test/clean`, and `//%63ritic.test`.
  A 32,768-case property matrix crosses all 4,096 per-character
  raw/direct/nested/same-depth spellings of `critic` through absolute and
  scheme-relative userinfo/host/port plus CONNECT authority host/port
  placements, requiring an actual `secret literal` finding in every case.
  An actually serialized `#%63ritic` observation proves the fragment branch;
  ordinary HTTP request targets do not fabricate a fragment.
- Safe controls and retained suite: 21 new greens cover ordinary userinfo,
  hosts and ports, bracketed IPv6, CONNECT authority targets, punycode,
  same-depth percent units, encoded `@`, `:`, `/`, `?`, and `#` delimiter data,
  empty/default paths, origin/absolute/scheme-relative query boundaries,
  path-query and userinfo-host cross-boundaries, and a safe observed fragment.
  All prior 148 named reds, both retained 4,096-spelling matrices, the
  450-case normalization-removal matrix, all 18 normalization greens, and
  every earlier query/form/header/Cookie/Set-Cookie, C0/DEL,
  malformed/recursive/overlong, provenance, path, and same-depth control
  survive. The four authority attacks plus observed-fragment probe bring the
  named total to 153.
- Ordered and exact gates: the permissioned ordered root gauntlet
  `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm
  build` passed with 34 files / 413 tests and production builds. Exact
  candidate `make verify-E3-T02` ended `verify-E3-T02: OK`, including Auth0
  61/61, emulate 6/6, the complete sensitivity corpus, and the browser receipt
  at 39 observations / 611 fields with
  `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
- Regression, policy, and board gates: exact candidate
  `make verify-E2-T04` ended `verify-E2-T04: OK` with zero browser console
  warnings/errors or uncaught exceptions. Exact candidate
  `make verify-E2-T12` re-earned the capstone browser proof and E2-T07 through
  E2-T11 regression/sensitivity closure, ending `verify-E2-T12: OK`.
  `node packages/identity/scripts/verify-work-queue-policy.mjs` was held past
  its expected-red child exception to terminal `WORK_QUEUE_POLICY_OK` across
  127 scenarios and exit 0. `tools/verify/self_check.sh` ended
  `CANOPY_SENSITIVITY_SPINE_OK`; `pnpm task-board:check` ended
  `task architecture audit: active tickets use the official substrate`.
- Exact-head pristine clone: `tools/verify/cold_clone.sh verify-E3-T02`
  cloned `a96c82b7c4e7fc44a8f37fb38b82418b0d3e6469`, checked out pinned emulate
  `82eb835947c97fcf6e0596a4377acbb01ca13ede`, hydrated under the scrubbed
  environment, and ended `verify-E3-T02: OK` plus
  `cold_clone: verify-E3-T02 PASSED from a pristine clone`.
- Coverage and browser evidence reuse: the implementation diff
  `3b4425f8fb15addac0c95c601d5ee7c9aa004ed3..a96c82b7c4e7fc44a8f37fb38b82418b0d3e6469`
  changes only the scanner, its permanent sensitivity harness, and committed
  transcript. It exercises every decomposition form and optional branch; no
  `apps/web` or shipped platform/UI hunk changed. The accepted
  `recordings/e3-t02-run2-short-final.mp4` independently revalidates as
  H.264/yuv420p, 1280x720, 30 fps, 9.2 seconds, 227988 bytes, SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`.
- Replay: N/A (tenant policy denied external upload) + mitigation: the accepted
  local MP4, full Playwright/stream receipts, complete named/generated
  sensitivity corpus, exact E3/E2 gates, terminal policy/self-check/board
  audits, and exact-head pristine-clone proof stand in. Per the accepted
  evidence policy, no upload was retried and no recording ID or Replay URL is
  claimed.

### 2026-07-28 — judge round 13 — VERDICT: refuted

- RECOVERY AND AUDIT ATTESTATION — PASSED. Predicted run 13 would be the sole
  remaining authorized recovery run, directly descended from the complete
  runs-10-12 audit, with the later correction changing only recognized
  `Evidence`/`Next focus` labels. Observed candidate
  `a96c82b7c4e7fc44a8f37fb38b82418b0d3e6469`, claim
  `98d4ed38a0d145f98daed7be3350ae508d38c382`, and parser-valid head
  `0f0d5ed14c646f509d9b472f3bb31c870ac66245` preserve that exact lineage,
  ceiling 13, and unchanged recovery authorization. The terminal independent
  policy run completed all 127 scenarios with `WORK_QUEUE_POLICY_OK`; its
  intermediate recovery exception was the expected-red child mutation, not
  the command result.
- P1 ambiguous bracketed-authority preservation — FAILED. Predicted every byte
  in an absolute or scheme-relative serialized authority would reach bounded
  canonical inspection, even when the authority was malformed or ambiguous.
  Observed `http://[::1]x%63ritic/clean`,
  `//[::1]x%63ritic/clean`, and `http://[::1]%63ritic/clean` all return green
  with `secretLiterals: ["critic"]`; nested
  `http://[::1]x%2563ritic/clean` and same-depth
  `http://[::1]x%25%36%33ritic/clean` also escape. The bracket branch computes
  the suffix as `remainder` but returns only the bracket contents and an
  optional colon-prefixed port, silently discarding every other suffix at
  `packages/browser-verify/src/index.ts:909-917`. The later inspector can only
  scan the truncated host/port at `:1277-1299`, while WHATWG parsing rejects
  these targets and the catch at `:1307-1309` trusts the incomplete raw
  decomposition. Demand: preserve and canonically inspect all serialized
  authority bytes, or reject malformed authority through an explicit
  authority-grammar finding without weakening the percent-provenance grammar.
- P2 advertised generated closure — PASSED but insufficient. Predicted all
  4,096 protected spellings across the eight advertised authority channels
  would fail specifically on `secret literal`. An independent generator
  observed all 32,768 do so. The committed sensitivity harness independently
  passed 153 named reds, both 4,096-spelling matrices, the 450-case
  normalization-removal matrix, 36 same-depth green pairs and their nested red
  controls, and all retained query/form/header/Cookie/Set-Cookie/path controls,
  ending `E3_T02_WIRE_SENSITIVITY_OK mutations=153`. Ordinary bracketed IPv6,
  a safe bracket suffix, encoded `@ : / \ ? #` host data, and empty authority
  remained green. Those positive results do not cover suffix bytes discarded
  after a bracketed host; the permanent authority constructors at
  `tools/verify/e3_t02_wire_sensitivity.mjs:845-869` generate only
  well-shaped userinfo, host, and port placements.
- COVERAGE — INSUFFICIENT. Every origin/absolute/scheme-relative/CONNECT
  decomposition branch and every optional userinfo/host/port/path/query/
  observed-fragment inspector is exercised by the named and generated corpus;
  type declarations are waived. The malformed bracket-suffix edge at
  `packages/browser-verify/src/index.ts:912-917` executes but its dropped
  remainder is never asserted, so the changed parser is not sufficiently
  covered. `RawRequestTarget.form` at `:893-895` and its assignments at
  `:945`, `:960`, and `:969` are dead runtime metadata: no consumer reads the
  discriminator. No skipped/todo test, lint suppression, or blessed golden
  appears in the scoped diff. Demand: promote direct, nested, and same-depth
  bracket-suffix reds for absolute and scheme-relative targets, safe malformed
  controls, and either consume the form discriminator or delete it.
- Proportional gates and browser evidence — SURVIVED. The exact scanner build
  and verifier passed before the counterexample. `tools/verify/self_check.sh`
  ended `CANOPY_SENSITIVITY_SPINE_OK`; `pnpm task-board:check` ended
  `task architecture audit: active tickets use the official substrate`.
  Because the fresh counterexample conclusively refutes the scanner, the
  costly root, E3, E2, and cold-clone gates were not redundantly rerun; the
  builder's exact-head receipts remain internally commit-bound but lack this
  attack. Local `recordings/e3-t02-run2-short-final.mp4` independently matches
  SHA-256
  `b083f319be7467c9926bca5548c635e5b86d36ab29a495cf121321e83fb72f40`,
  H.264/yuv420p, 1280x720, 30 fps, 9.2 seconds, 227988 bytes. Replay:
  N/A (tenant policy denied external upload) + mitigation: the verified local
  MP4 and complete Playwright/stream receipts; no upload was retried.
- Lifecycle: final authorized verification run 13 is refuted. E3-T02 returns
  to `in-progress`; the project is `invalid_loop`. No run 14 is authorized.
  SUITE: retain all existing red/green corpora; the bracket-suffix family above
  is the required recovery seed if a human explicitly authorizes another run.

### 2026-07-28 — human resume — RECOVERY 2 RUNS 14-16 authorized

- Authorization: APPROVED
- Task: E3-T02
- Recovery generation: 2
- Stopped after run: 13
- Authorized runs: 14-16
- Scope: control-plane recovery transition and E3-T02 verification only

### 2026-07-28 — builder run 14 — CLAIM: implemented

- Candidate: `35f9ccc`, directly above the runs-14-16 recovery resume pin
  `2735b9c`. Two commits carry the rework: `739392a` (the refutation fix)
  and `35f9ccc` (a fixture-teardown fix disclosed in full below).
- P1 bracket-suffix preservation — ADDRESSED. `decomposeRawAuthority`
  computed the post-bracket `remainder` but returned only the bracket
  contents plus an optional colon-prefixed port, discarding every other
  serialized byte at `packages/browser-verify/src/index.ts:909-917`.
  Decomposition is now lossless: bytes following a bracketed host that do
  not form a `:port` are preserved as `RawAuthority.suffix` and inspected
  through the same bounded canonical grammar as userinfo/host/port. The
  percent-provenance grammar is untouched — no validity decision moved, and
  the fix is preservation, not a new detector. All five run-13
  counterexamples now fail on `secret literal`, each naming
  `url.raw-authority.suffix`: `http://[::1]x%63ritic/clean`,
  `//[::1]x%63ritic/clean`, `http://[::1]%63ritic/clean`, nested
  `http://[::1]x%2563ritic/clean`, and same-depth
  `http://[::1]x%25%36%33ritic/clean`.
- Coverage — ADDRESSED. Four bracket-suffix channels joined the generated
  authority matrix (absolute, scheme-relative, CONNECT authority-form, and
  after-userinfo), taking it from 8 x 4,096 to 12 x 4,096 = 49,152 cases,
  each requiring an actual `secret literal` finding. Eight named reds pin the
  exact counterexamples across absolute, scheme-relative, and authority
  forms at direct, adjacent, nested, and same-depth spellings. Seven new
  greens prove the channel discriminates rather than blanket-rejecting
  bracketed authorities: safe suffix (absolute, scheme-relative, CONNECT),
  encoded-safe suffix, same-depth safe suffix, unterminated bracket, and
  empty suffix. `tools/verify/e3_t02_wire_sensitivity.mjs` ends
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`, up from 153, with every prior
  red and green retained.
- Dead metadata — ADDRESSED. `RawRequestTarget.form` had no consumer and is
  deleted along with its three assignments.
- Apparatus change, disclosed for attack: `35f9ccc` adds
  `server.closeAllConnections()` to the registry fixture's `stop()` in
  `packages/platform/test/registry.helpers.ts`. `server.close()` waits on
  every established connection, so a held-open SSE tail or keep-alive
  long-poll socket pinned teardown open and the `afterEach` hook timed out
  at 120s while the test body itself passed. This predates the rework:
  reproduced at stopped commit `2735b9c` with all E3-T02 changes stashed.
  It runs after every assertion in the test body has already executed, so no
  assertion is weakened, skipped, or silenced; 5/5 clean under the scrubbed
  gate env where the flake previously reproduced about half the time. A
  critic should treat a builder editing shared test infrastructure as
  suspect and verify independently that no assertion was disarmed.
- Gates: `pnpm format:check`, `lint`, `typecheck`, `test` (34 files / 413
  tests), and `build` each exit 0. `tools/verify/self_check.sh` ends
  `CANOPY_SENSITIVITY_SPINE_OK`. `make verify-E3-shell` exits 0 — captured
  as `make`'s own status, not a pipeline's — ending `verify-E3-shell: OK`
  with `partial-triple-sweep regions=1 partial=0`,
  `spa routes home>org>repo>back>forward>404 document-loads=1`,
  `credential-scan ... jwt=0 verifier=0 session-outside-http-only-cookie=0`,
  and `console.error=0 pageerror=0 requestfailed=0 non-loopback=0`.
- Environment note for the critic: two earlier gate runs failed on
  wall-clock budgets (`frame.atMs - dispatchedAt < 2000`) purely under CPU
  contention from concurrent stress runs on this machine; the clean run is
  413/413. Re-run the gate unloaded before treating a latency failure as a
  finding. Separately, this worktree needed `vendor/emulate` hydrated at the
  pinned commit `82eb835947c97fcf6e0596a4377acbb01ca13ede` — the local
  submodule URL override points at another worktree and git refuses
  file-protocol submodule clones.
- Replay (browser layer): `https://app.replay.io/recording/960f8c91-0d1e-46de-94f4-9a4f6c24befe`,
  produced by the new scripted `tools/replay/record-e3-t02.sh` (commit
  `6176cd9`) rather than by hand. The walkthrough returned:
  `triple={stream:__identity__, offset:0000000000000000_0000000000000373,
  digest:28e690d669cd35cffedb6cf7b826ed3b6018b2ebcdd1ea6a7abc253e2c7913d0}`,
  `identity={sub:auth0|ada-replay, email:ada.replay@canopy.test}`,
  `partialTripleElements=0`, `documentLoads={before:1, after:1}`.
- The triple is the stream's truth, checked out-of-band: replaying the
  world's independent identity dump truncated to the DOM's own stated
  offset `_0373` (its first two records) through
  `ef replay --digest --reducer packages/identity/reducer.mjs` yields
  `28e690d669cd35cffedb6cf7b826ed3b6018b2ebcdd1ea6a7abc253e2c7913d0` —
  literal string equality with `data-ef-digest`. The full three-record dump
  yields a *different* digest,
  `36c2b00aa922a2bc220a117f8e3d3daa79c3caebf63b4152fa5da5fe8db0b66e`, so the
  attribute tracks its stated offset rather than always agreeing with head.
- Recording caveat, withdrawn after checking: the walkthrough's
  `requestfailed` hook reported
  `.../assets/index-Cea9xS8w.js.map`, and I first read that as the server
  not serving the sourcemap. The recorded network log refutes my own
  reading — the platform served that exact URL `=> [200] OK` twice, the
  file is present at `apps/web/dist/assets/index-Cea9xS8w.js.map`
  (924,012 bytes, `vite.config` sets `sourcemap: true`), and the session's
  request log contains no 4xx, 5xx, `ERR_`, or aborted entry while the
  console reports `Total messages: 0 (Errors: 0, Warnings: 0)`. The event
  corresponds to a duplicate devtools fetch being cancelled, not to a
  missing asset or a serving-contract gap. No invariant was widened or
  silenced to reach this conclusion.
- Walkthrough field correction: the `origin` value in recording
  `960f8c91`'s returned JSON reads `http://127.0.0.1:56874`, which is the
  *emulator* origin, because the script sampled it during scene 1 while the
  page still sat on the login form; the app origin for that run was
  `http://127.0.0.1:56873`. This affected the reported field only — every
  assertion used pathnames and link clicks, never that value. Corrected in
  the script, and re-recorded as
  `https://app.replay.io/recording/dc1a3f9c-8736-46b0-b832-fd4737ce3fc9`
  (session `e3-t02-run14-final`), which reports the app origin
  `http://127.0.0.1:58489` correctly. **Cite `dc1a3f9c`**; `960f8c91`
  remains valid evidence but carries the mislabelled field.
- Cross-run determinism, unplanned but worth the critic's attention: three
  complete recordings booted independent worlds on different ephemeral
  ports (`56873`, `58489`, `65184`) and produced a byte-identical identity
  triple every time — offset `0000000000000000_0000000000000373` and digest
  `28e690d669cd35cffedb6cf7b826ed3b6018b2ebcdd1ea6a7abc253e2c7913d0`. The
  state is a function of the replayed events, not of the run.
- Self-inflicted green-washing escape, found by this repo's own detector
  and fixed at `84da940`. The first version of
  `tools/replay/record-e3-t02.sh` used `|| true` in three places, so a
  failing probe could not turn the run red. `tools/verify/self_check.sh`
  failed `_v-meta` with `forbidden escape in
  tools/replay/record-e3-t02.sh`. This is disclosed rather than quietly
  amended because it happened *inside the evidence tooling* and would have
  shipped had the gate not been re-run at the tip. The two curl probes are
  now hard assertions — unauthenticated `GET /` must answer exactly `302`
  and `/api/whoami` exactly `401` with an `auth-refused` body, or the
  script exits before recording anything — which proves strictly more than
  the escaped version did. Recording `ba8c4449-4159-49f0-af57-74bcb99c1d27`
  (session `e3-t02-run14-final`) is the artifact of the compliant script
  and prints `pre-record gate: / -> 302, /api/whoami -> 401 auth-refused`.
- Gate re-verified at the committed tip `84da940`, not merely at the
  commit where the rework landed: `make verify-E3-shell` exits 0
  (`MAKE_EXIT=0` captured as make's own status), 413/413 root tests plus
  the 61- and 6-test suites, `E3_T02_WIRE_SENSITIVITY_OK mutations=161`,
  `CANOPY_SENSITIVITY_SPINE_OK`, and `verify self-check OK: ... no
  green-washing escapes`. An earlier run at `ef3cbf6` exited 2 on exactly
  the escape above; that failure and this pass are the same apparatus.
- The withdrawn sourcemap caveat reproduces as clean under the second run
  too: `.../index-Cea9xS8w.js.map => [200] OK` twice, no 4xx/5xx/`ERR_`
  entry, console `Total messages: 0 (Errors: 0, Warnings: 0)`.
- Three earlier recordings this session are empty and must not be cited:
  `7ac19e98-85bb-4857-89f5-cc7f0bb2f405` and
  `e636fc1e-284d-4d59-b6ac-283bd940cb81` captured a login page only,
  because the walkthrough died before executing (expression-wrap
  `SyntaxError`, then `ReferenceError: URL is not defined`). Only
  `960f8c91` contains the walkthrough.

### 2026-07-29 — judge round 14 — VERDICT: refuted

- P1 recorded-walkthrough tripwire — FAILED. Predicted the scripted recorder
  would exit nonzero before close/upload if the recorded page emitted a
  `console.error`, uncaught `pageerror`, or failed request. Observed
  `tools/replay/e3_t02_walkthrough.js:2-9` append all three failure classes to
  `consoleErrors`, while `:87-94` only returns the array; it never throws when
  nonempty. `tools/replay/record-e3-t02.sh:69-75` saves the returned value and
  `playwright-cli console error` output but never asserts either is empty before
  `browser-close.js`. `tools/verify/self_check.sh` still reports no
  green-washing escapes. Demand: make nonempty telemetry fail before
  close/upload, add expected-red recorder sabotages for all three failure
  classes that also prove no evidence is published, then re-record.
- Parser, fixture, and lineage — PASSED. The independent full-wire run ended
  `E3_T02_WIRE_SENSITIVITY_OK mutations=161`; direct, nested, same-depth,
  userinfo, colon-tail, double-close, unterminated-bracket, and CONNECT attacks
  all reached the intended authority component while safe malformed suffixes
  stayed green. `closeAllConnections()` changes only fixture teardown after
  test-body assertions; no expectation, skip, timeout, or assertion was
  weakened. Candidate `0c134fe4186a3935920be750e1c1d2c4855d8aa6`
  descends recovery pin `2735b9ce2df3b3ab819150e6615985f2ce36b98b`;
  the generation-2 ceiling remains 16 with runs 15-16 authorized.
- Replay critic — PASSED for the actual recordings, with attribution
  correction. Both `ba8c4449` and `dc1a3f9c` contain complete, behaviorally
  identical walkthroughs with zero console, runtime, or network failures; the
  builder sentence saying only `960f8c91` contains a walkthrough is stale.
  `ba8c4449` shows the
  [login](https://app.replay.io/recording/ba8c4449-4159-49f0-af57-74bcb99c1d27?point=5516815412211159226280196683333717&time=8422),
  matching
  [shell triple](https://app.replay.io/recording/ba8c4449-4159-49f0-af57-74bcb99c1d27?point=8112963841487878270009126709887178&time=9355.527658559848)
  and
  [`/api/whoami`](https://app.replay.io/recording/ba8c4449-4159-49f0-af57-74bcb99c1d27?point=7139408180506148646762887946174592&time=9066),
  then
  [logout](https://app.replay.io/recording/ba8c4449-4159-49f0-af57-74bcb99c1d27?point=18173039004923199400968732629008865&time=12652)
  and the
  [logged-out authorize page](https://app.replay.io/recording/ba8c4449-4159-49f0-af57-74bcb99c1d27?point=20769187434196065381029202148458509&time=16806.153846153848).
  The clean recording does not rescue the reusable recorder's missing
  sensitivity.
- COVERAGE: the suffix implementation branches and safe controls execute, dead
  `RawRequestTarget.form` metadata is gone, and the fixture teardown does not
  alter assertions. The new recording apparatus is insufficiently covered
  because its collected failure state never controls success. SUITE: promote a
  recorder sensitivity test requiring nonzero/no-upload behavior for
  `console.error`, `pageerror`, and `requestfailed`.
- Lifecycle: verification run 14 is refuted. E3-T02 returns to `in-progress`;
  the project remains `building`; recovery runs 15-16 remain authorized.
