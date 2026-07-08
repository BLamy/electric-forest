---
id: E2-T12
epic: 2
title: "Capstone: the-locked-gate — Playwright-driven emulated Auth0 login, CLI token mint, authorized append lands, tokenless append refused, one Replay recording, cold start"
priority: 212
status: pending
depends_on: [E2-T11]
estimate: L
capstone: true
---

## Goal

ROADMAP's Epic-2 demo — **the-locked-gate** — runs mechanically, from a cold start,
under `make verify-E2-T12` (also exposed as `verify-E2-capstone`, an alias to the same
recipe). From a pristine clone (`tools/verify/cold_clone.sh`, scrubbed env per the
E0-T02 contract), with a **fresh stream-server data dir and a fresh platform-server
state created by the run itself** and a **fresh Playwright browser profile** (no cookies,
no localStorage, no credentials file), the orchestrator boots the E2-T02 emulator
(seeded subjects fixture, pinned `--now` clock) and the platform server
(`EF_OIDC_ISSUER` pointed at the emulator), then Playwright — running under Replay
Chromium via `tools/replay/record-run.sh -o e2-t12-final` — drives the whole gate in
**one recorded browser session**: load `/` logged-out; complete the emulated Auth0
authorization-code+PKCE login through the E2-T02 login page
(`data-testid="login-submit"`); land authenticated on `/` with the E2-T04
`data-identity-offset` equal to the server's identity-stream head; mint a CLI token on
`/settings/cli-tokens` (E2-T05, one-time secret, `grant/cli-token-issued` event at a
recorded offset); perform an **authorized append** through an E2-T03 door with that
token — the event lands at a cited offset in a repo stream namespaced per E2-T06/E2-T08
— then perform the **byte-identical append with no `Authorization` header**, refused
with E2-T03's frozen status: HTTP **401**, `WWW-Authenticate: Bearer`,
`error.reason: missing-token`, and the target stream's head offset and
`ef replay --digest` digest byte-identical before and after. Both the 2xx landing and
the 401 refusal exist as network events **inside the same Replay recording**, cited by
URL and interrogable at both moments. In parallel the same authorized/refused pair is
executed via the `ef` CLI (credentials from the E2-T05 device flow) for the
stream-layer transcript. The verdict is digest arithmetic: the dumped identity stream
and target stream replay via `ef replay --digest` to the digests committed in
`evidence/`, the E2-T10 authorization matrix runs green against the live servers, and
every composed `verify-E2-*` target passes from the cold clone. Epic 2 is done when
this target cannot be distinguished from the ROADMAP capstone paragraph by any
observable.

## Context

This is the Epic-2 capstone: the gate the epic ladders toward (ROADMAP "Epic 2 —
the-gates", capstone paragraph: "Playwright drives an emulated Auth0 login end-to-end,
lands authenticated, mints a CLI token, and performs an authorized append; the same
append without the token is refused with the right status — both shown in one Replay
recording"). Per `.eforest/tasks/README.md`, a capstone additionally requires its demo
end-to-end **from a cold start** — fresh clone, fresh browser profile, fresh
stream-server data dir, no state left over from development. Nothing new is designed
here; this task is pure composition and proof. (`depends_on` is the minimal cover:
E2-T11's transitive closure contains every other Epic-2 task, and the Epic-gate
criterion below independently demands E2-T01…E2-T11 verified — the per-task bullets
here describe what each dependency contributes, not the dependency edge set.)

- **E2-T02** (via the dependency closure) supplies the deterministic Auth0 stand-in the
  login is recorded against — seeded subjects, pinned clock, Playwright-driveable pages.
- **E2-T03** supplies the door and the frozen refusal taxonomy this demo's headline
  refusal (`401` / `missing-token` / log-neutral) is pinned to.
- **E2-T04** supplies the web login, idempotent provisioning, sessions-as-events, and
  the DOM-exposed `data-identity-offset` the recording is interrogated against.
- **E2-T05** supplies both credential paths: the web mint the recording shows, and the
  `ef login` device flow the CLI transcript authenticates with — both as
  `grant/cli-token-issued` events at citable offsets.
- **E2-T06/E2-T08** supply the namespace the authorized append targets and the
  `__registry__`-derived project index the demo's repo appears in (the demo creates its
  org/project/repo through dispatch during the run — nothing pre-seeded).
- **E2-T07/E2-T09** (via the closure) supply per-stream authorization and
  writer-scoped fencing; the demo's authorized append passes them, and E2-T10's matrix
  re-proves the whole decision surface.
- **E2-T10** supplies the standing authorization conformance matrix; running it green
  against the capstone's live servers is part of this task's evidence, not a re-build.
- **E2-T11** supplies rate limits and tenant isolation; the capstone runs inside those
  limits (and the transcript proves the demo's traffic was not exempted from them).

Anything the demo needs that a dependency failed to deliver is a finding against that
dependency, not a workaround absorbed here — a capstone that patches around its epic
refutes the epic. The scripted scenario (subject fixture, org/project/repo names, the
append payload, the token name/scopes) is a **committed fixture**, not generated at run
time by the code under test, so the committed digests are frozen artifacts and any
drift is a real regression.

This task is browser-impacting by definition: the Replay recording is not optional
evidence here, it **is** the demo (`Replay: N/A` is not an acceptable claim for this
task on a machine where `tools/replay/preflight.sh` passes; if preflight cannot pass,
the task blocks rather than downgrades — the capstone's headline artifact is the
recording).

## Deliverables

- `tools/verify/e2-capstone/` — the demo as code, runnable by anyone:
  - `scenario/` — committed fixtures: the subject used for login (referencing
    E2-T02's `fixtures/subjects.json` entry by `sub`), `append-payload.json` (the exact
    event body appended twice — once authorized, once tokenless), the org/project/repo
    names, and the CLI token `{name, scopes}` for the mint.
  - `run.sh` — the orchestrator: creates a scratch workspace (path printed); boots the
    emulator (seeded, pinned clock) and the platform server on ephemeral ports with
    fresh data dirs **inside the scratch space**; launches the Playwright walkthrough
    under `tools/replay/record-run.sh -o e2-t12-final` with a fresh browser profile
    (profile dir created in scratch, echoed); runs the CLI leg (`ef login
    --no-browser` device flow with `EF_HOME` in scratch, authorized append exits 0,
    tokenless append exits nonzero with the 401 body captured); dumps the identity
    stream, the target repo stream, and the namespace stream carrying the run's
    `ns.*` creation events (`ns:root` plus the per-org stream, per E2-T06); runs the
    verdict phase: `ef replay --digest`
    over all dumps compared to the committed digests, before/after digest equality
    around the refusal, the E2-T10 matrix invoked against the still-running servers,
    a registry-resolution check — query the E2-T08 index door at demo end and assert
    an entry for the fixture org/project/repo at a stated `__registry__` asOf offset
    (transcript captured as `evidence/registry-resolves.txt`) —
    and the refusal-transcript assertions (status 401, `WWW-Authenticate: Bearer`,
    `error.reason: missing-token`, head offset unchanged). Any mismatch exits nonzero
    naming the failing comparison. A standalone re-check mode — `run.sh --check
    <stream-dump> <expected-digest>` — recomputes a dump's digest via `ef replay` and
    compares, so the apparatus can be exercised against tampered copies without a live
    run.
  - `walkthrough.spec.ts` — the Playwright script: logged-out `/` (asserts the
    logged-out state and **zero console errors** throughout), login via the emulator
    page, authenticated landing (asserts `data-identity-offset` equals the server's
    identity-stream head fetched out-of-band), mint on `/settings/cli-tokens`
    (one-time secret captured from the response, never logged), then the authorized
    append and the byte-identical tokenless append both issued **from the page
    context** (so both requests and their 200/2xx and 401 responses are network events
    inside the recording), asserting status, refusal body, and the DOM-exposed target
    stream head advancing exactly once (after the authorized append) and never again
    (after the refusal).
- `Makefile`: `verify-E2-T12` composed per the E0-T02 contract (standard `_v-*` gates
  plus `run.sh`), `verify-E2-capstone` as its alias, both joined to `verify-all`,
  visible in `make verify-list`; `.PHONY` updated; `tools/verify/self_check.sh` still
  green.
- Committed evidence in
  `.eforest/tasks/epic-2-the-gates/E2-T12-the-locked-gate/evidence/`:
  - `identity-log.jsonl` + `identity-log.digest` — the identity stream dump at demo
    end (login provisioning, `session-started`, both `grant/cli-token-issued` events)
    and its `ef replay --digest` value.
  - `target-log.jsonl` + `target-log.digest` — the appended-to repo stream dump and
    digest; the authorized append's offset recorded in `digests.txt`.
  - `ns-root-log.jsonl` + `ns-root-log.digest` — the namespace stream dump(s)
    (`ns:root` plus the per-org stream, per E2-T06) containing the run's `ns.*`
    org/project/repo creation events at citable offsets, and their
    `ef replay --digest` values.
  - `registry-resolves.txt` — the demo-end registry-resolution transcript: run.sh's
    query of the E2-T08 index door asserting an entry for the fixture
    org/project/repo at a stated `__registry__` asOf offset.
  - `digests.txt` — every digest with the exact command that produced it, plus the
    login/session/mint/append offsets.
  - `refusal.txt` — the tokenless append's full request/response (browser leg **and**
    CLI leg): status 401, `WWW-Authenticate: Bearer`, the literal `error` body with
    `reason: missing-token`, and the target stream's head offset + digest immediately
    before and immediately after, byte-identical.
  - `matrix-green.txt` — the E2-T10 authorization matrix transcript run against the
    capstone's live servers during the demo (exit 0, decision counts quoted, and the
    base URLs/ephemeral ports the matrix targeted recorded verbatim — these must
    byte-match the scratch-space server ports printed by run.sh in the same run's
    `cold-clone-capstone.txt` transcript).
  - `secret-hygiene.txt` — grep transcript: the minted secret and the device-flow
    bearer appear in zero events across every dumped stream, zero times in the
    recording's console, and zero times in every file committed under `evidence/`
    (including `cold-clone-capstone.txt`, `digests.txt`, and `refusal.txt`) — per
    E2-T05's hygiene contract.
  - `sensitivity-tamper.txt` — the tamper drill: one byte of one event mutated in a
    **copy** of `target-log.jsonl`, `run.sh --check` going red, `ef bisect` naming the
    tampered offset; plant applied to a copy, never committed.
  - `cold-clone-capstone.txt` — `tools/verify/cold_clone.sh verify-E2-T12` transcript
    plus a `verify-all` transcript at the same SHA (every `verify-E0-*`,
    `verify-E1-*`, `verify-E2-*` target's OK line present).
- Verification log entry (builder claim): commit hash, every command and exit code,
  digest values and offsets, evidence paths, and the **Replay recording URL** with
  point links (or `?time=` anchors) at (a) the emulator login submission (the
  `/oauth/token` network event), (b) the authenticated landing, (c) the mint,
  (d) the authorized append's network event, (e) the refused append's 401 network
  event.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E2-T12` exits 0 from pristine committed HEAD
      in a scratch dir with scrubbed env, zero `SKIPPED:` lines; the transcript
      (`evidence/cold-clone-capstone.txt`) shows the stream-server data dir, platform
      state, `EF_HOME`, and the Playwright browser profile all created inside the
      run's scratch space (paths printed) — none reused from the working tree, `/tmp`,
      `~/.eforest`, or a dev server.
- [ ] One recording, both outcomes: a single Replay recording URL, produced by
      `tools/replay/record-run.sh -o e2-t12-final` during the verify run, contains —
      as interrogable network/DOM state at cited points — the emulated Auth0 login
      completing, the authenticated `/` with `data-identity-offset` equal to the
      identity-stream head, the CLI-token mint on `/settings/cli-tokens`, the
      authorized append's 2xx response, and the tokenless append's 401 response with
      `error.reason: missing-token`; zero console errors and zero uncaught exceptions
      anywhere in the recording. The URL and five point/time anchors — including one
      at the emulator login submission (the `/oauth/token` network event) — are in
      the Verification log.
- [ ] Authorized append lands at a cited offset: `evidence/digests.txt` names the
      offset; `evidence/target-log.jsonl` contains the exact committed
      `scenario/append-payload.json` body at that offset; and
      `ef replay evidence/target-log.jsonl --digest` prints exactly the digest
      committed in `evidence/target-log.digest`.
- [ ] Tokenless refusal is frozen-status and log-neutral: `evidence/refusal.txt` shows,
      for both the browser leg and the CLI leg, status **401**,
      `WWW-Authenticate: Bearer`, `error.reason: missing-token` (E2-T03's frozen row),
      and the target stream's head offset and `ef replay --digest` digest
      byte-identical before and after each refused attempt; the refused attempts
      happened **after** the authorized append in the same run (offsets/timestamps in
      the transcript prove ordering).
- [ ] Identity leg replays: `ef replay evidence/identity-log.jsonl --digest` prints
      exactly `evidence/identity-log.digest`, and the dump contains, at recorded
      offsets, exactly one `user-created` for the demo subject, the `session-started`,
      and two `grant/cli-token-issued` events (`tokenKind: 'web-mint'` and
      `'device'`) — with the raw secrets appearing in zero events across every
      dumped stream, zero times in the recording's console, and zero times in any
      file committed under `evidence/` (`evidence/secret-hygiene.txt`).
- [ ] Matrix green live: the E2-T10 authorization conformance matrix runs green against
      the capstone's live emulator + platform server during the demo
      (`evidence/matrix-green.txt`, exit 0), not against a separate dev environment —
      decidable because `matrix-green.txt` records the base URLs/ephemeral ports the
      matrix targeted, and those byte-match the scratch-space server ports printed by
      run.sh in the same run's transcript (`evidence/cold-clone-capstone.txt`).
- [ ] Namespace born in-run: the org/project/repo the append targets are created
      through dispatch during the recorded run — their `ns.*` creation events present
      at cited offsets in the committed namespace-stream dump
      (`evidence/ns-root-log.jsonl`, replaying to `evidence/ns-root-log.digest`) —
      and the repo is resolvable through the E2-T08 registry index at demo end:
      run.sh queries the index door and asserts an entry for the fixture
      org/project/repo at a stated `__registry__` asOf offset, transcript committed
      as `evidence/registry-resolves.txt` — no pre-seeded namespace.
- [ ] Sensitivity (mandatory): with one byte of one event mutated in a **copy** of
      `evidence/target-log.jsonl`, `run.sh --check <mutated-copy>
      evidence/target-log.digest` exits nonzero AND `ef bisect` names exactly the
      tampered event's offset — transcript in `evidence/sensitivity-tamper.txt`;
      working tree clean of the plant afterward.
- [ ] Epic gate: every Epic-2 task E2-T01…E2-T11 is `verified` in frontmatter (or
      carries a documented optional/stretch exemption stated in both its Context and
      this readme — none is currently declared); after `python3
      tools/build_queue.py`, `git diff --exit-code .eforest/tasks/QUEUE.md` passes,
      and `QUEUE.md` lists no Epic-2 task as pending/in-progress/implemented except
      E2-T12 itself.
- [ ] `make verify-all` exits 0 at the claimed commit **when run inside the same cold
      clone produced by `tools/verify/cold_clone.sh`** (the transcript, bundled in
      `evidence/cold-clone-capstone.txt`, shows the clone path prefix on the
      invocation), running every `verify-E0-*`, `verify-E1-*`, and `verify-E2-*`
      target. The expected set is pinned from the task readmes, not the Makefile:
      for every E0/E1/E2 task whose frontmatter `status` is `implemented` or
      `verified`, `make verify-list` names a `verify-E*-T*` target and the
      verify-all transcript contains that target's OK line; any such task lacking a
      target fails this criterion unless its readme documents an exemption. All five
      workspace gates (`pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build`) exit 0, each command and exit code recorded in the
      Verification log.

## Adversarial verification

This is a capstone: the claim is "the epic's gate works end-to-end from nothing, and
one recording proves both sides of it." Attack the *from nothing*, the *one recording*,
and the *both sides* separately, with your own subjects, payloads, and tamper offsets —
never the builder's. Any single success refutes. Invent at least one more angle.

1. **Cold-start sabotage.** Run `tools/verify/cold_clone.sh verify-E2-T12` yourself,
   then again with a poisoned caller env (`NODE_OPTIONS`, `NODE_ENV=production`,
   `EF_HOME` pointed at a directory containing valid dev credentials,
   `npm_config_registry` at a dead port) and a warm emulator + platform server
   deliberately left running on likely ports from a prior dev session with a
   logged-in profile. The capstone must not care — and above all must not silently
   authenticate with the planted credentials or cookies: if the recorded session
   reaches the logged-in state without the login interaction visibly executing in the
   recording, the fresh-profile claim is refuted. Grep `tools/verify/e2-capstone/`
   for fixed ports, absolute paths, `~/.`-anything, or reads outside the scratch
   space.
2. **One-recording honesty.** The headline artifact is a single recording holding both
   outcomes. Interrogate it via the Replay MCP: (a) the login flow's requests to the
   emulator's `/authorize` and `/oauth/token` must exist as network events *inside*
   the recording — a recording that opens on an already-authenticated page refutes;
   (b) the authorized append's 2xx and the tokenless append's 401 must both be
   network events in this same recording, with the 401's response body carrying
   `error.reason: missing-token` — two separate recordings stitched by narrative, or
   a refusal demonstrated only in the CLI transcript, refutes the "one Replay
   recording" claim; (c) evaluate `data-identity-offset` and the target-stream head
   in the DOM at the cited points and check them against the committed offsets — a
   mismatch is a digest-currency lie; (d) sweep the whole recording for console
   errors, uncaught exceptions, and the minted secret appearing in console or in any
   URL — one hit refutes hygiene.
3. **Refusal authenticity and byte-identity.** Re-run the demo, capture both append
   requests from the recording's network events, and diff their bodies: they must be
   byte-identical except for the absent `Authorization` header — a tokenless attempt
   with a *different* (e.g., trivially malformed) body is a strawman refusal and
   refutes. Then go beyond the missing header with your own near-misses at the same
   door: the minted token with one flipped byte, an expired emulator token (advance
   the pinned clock), a token whose grant you revoke mid-run via
   `DELETE /api/cli-tokens/:grantId`, another subject's valid token against a stream
   it has no grant for (E2-T07). Each must return its own frozen taxonomy row, and
   each must be log-neutral by before/after `ef replay --digest` of the target
   stream. Any acceptance, any wrong `error.reason`, or any refusal that appends so
   much as a marker event refutes.
4. **Composition, not patchwork.** Diff this task's commits: any change to
   `packages/*` beyond wiring the walkthrough surface, or any edit to
   `tools/verify/*.sh`, an earlier task's Makefile recipe, the E2-T10 matrix, or the
   E2-T11 limits needs a stated reason — an undocumented change is a finding against
   that dependency's verification, and a capstone that loosened a gate to pass
   (e.g., a rate-limit carve-out for the demo's origin, a matrix case skipped) is
   refuted outright. Verify E2-T11 specifically: hammer the door during your re-run
   past the documented window and confirm the demo's own traffic is subject to the
   same typed 429s.
5. **Tamper drill, your offsets.** Repeat the sensitivity proof with your own
   mutations against copies of both dumps: flip a byte in the `grant/cli-token-issued`
   event, in the authorized append's event, and in the first event; delete one event;
   duplicate one; swap two adjacent ones. Each must turn `run.sh --check` red with
   `ef bisect` naming the exact first-divergent offset. Any tamper that stays green
   refutes the measuring apparatus and voids the epic's evidence.
6. **Determinism sweep.** Re-run the capstone with a different E2-T02 subject from the
   committed fixture and a different pinned clock: grant ids, `jti`s, and offsets may
   differ, but the same event *sequence*, the same door behavior (2xx then 401
   `missing-token`, log-neutral), and green digest self-consistency (`run.sh`
   re-derives and asserts against the produced dumps) must hold. A demo that only
   passes under the builder's exact subject, clock, or port assignment refutes
   determinism-by-design.
7. **Evidence authenticity + epic-gate audit.** Re-earn every committed artifact:
   `ef replay` over both committed dumps must print the committed digests; the
   offsets in `digests.txt` must exist in the dumps with the claimed payloads; the
   matrix transcript's decision counts must match E2-T10's committed matrix
   dimensions. A committed artifact you cannot reproduce from committed code is
   fabricated evidence and refutes outright. Then audit the gate: E2-T01…E2-T11 all
   `verified` with Verification-log entries to match, `verify-all` at the claimed SHA
   runs every E0/E1/E2 target green (count the OK lines), queue regenerated and
   clean.

Refutation currency: a Replay point link where the recording contradicts the claim, an
event-log offset where a refused mutation landed, a digest pair that should match and
doesn't (or should differ and doesn't), an HTTP transcript with the wrong
status/reason, a grep hit of a secret, or an undocumented diff hunk in a dependency's
territory. "The login felt real" is a caption, not a finding.

## Verification log

(appended over time by builders and critics)
