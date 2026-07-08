---
id: E3-T03
epic: 3
title: "useServerReducer hooks: hydrate at an offset from /state, live-tail /events, client replay to digest parity with the server head"
priority: 303
status: pending
depends_on: [E3-T01, E3-T02]
estimate: L
capstone: false
---

## Goal

`packages/web-hooks` (`@eforest/web-hooks`) is the client data layer every Epic 3 view
rides. Its core export, `useServerReducer(streamId, options?)`, hydrates by fetching
`GET /streams/{id}/state` (E0-T10's frozen surface) — taking the canonical-JSON state
body and the exact offset in the `Stream-Offset` response header — then live-tails
`GET /streams/{id}/events?offset=<that offset>&live=sse` (long-poll fallback when SSE
is unavailable, both per E0-T06's frozen contract), applying each received event
**in the browser** through the same reducer the server registers — the identical
`@eforest/protocol` `replay()`/`reduceStep()` functions imported from the shared
package, never a port, never a re-fetch of `/state`. On disconnect it resumes from its
last checkpointed offset (the SSE frame `id:` / `Stream-Next-Offset` value) with no
gap and no duplicate, so the client's accumulated log is byte-for-byte the suffix a
cold catch-up read returns. The hook returns `{ state, offset, digest, status }` where
`digest` is `stateDigest(state)` from `@eforest/protocol` computed client-side (browser
Web Crypto producing byte-identical output to Node), and after any dispatch burst
quiesces, `(offset, digest)` equals the server's head offset and the digest of `GET
/state` at that offset — exactly, as strings. A **stream-inspector page** in the
E3-T02 app shell (`packages/web`, route `/inspect/:streamId`) renders any stream's
live `{offset, digest, event count, status}` through the hook, exposed in the DOM via
the attribute contract E3-T02 froze (E3-T02's readme is the naming authority for the
`data-*` attribute names; this task consumes them verbatim, adding none). The
reusable live-convergence verify target `make verify-E3-live` proves it: a Node
client dispatches the E3-T01 seed corpus while Playwright watches the inspector's DOM
offset march to the server head and its digest land string-equal to the server's
`/state` digest at that offset.

## Context

This is Epic 3's load-bearing task: every later view — repo list (E3-T04), repo home
(E3-T05), file tree (E3-T06), file viewer (E3-T07), branch switcher (E3-T08), history
(E3-T09), and the capstone the-reading-room (E3-T10) — is a `(stream, reducer)` pair
rendered through this hook. If `useServerReducer` can silently drop, duplicate, or
reorder one event, every "appears live" claim above it is theater; that is why this
task's evidence is digest parity with the server head, not "the number went up".

It composes contracts frozen below it and adds no new server surface: E0-T10 froze
`/state` + `Stream-Offset` (hydration) and `/events` (the same read machinery as raw
stream reads); E0-T06 froze the live modes and the resume invariant — *offset in hand
⇒ exact suffix, digest-equal to cold read* — that this hook's reconnect logic leans
on; E0-T10's Context names this exact consumer ("the E3 web app's
`useServerReducer`-style hooks hydrate from `/state` + `Stream-Offset` and tail
`/events` live"). E3-T01 supplies the deterministic browse corpus (scripted seed,
golden per-stream digests) this task's convergence runs dispatch and compare against.
E3-T02 supplies the authenticated shell, the browser-verify harness (Playwright +
Replay wiring), and the frozen DOM offset/digest exposure contract this task renders
into. Prior art: ElectricSQL durable-streams' client-side redux hooks — studied,
rebuilt here.

Contracts frozen here: the `@eforest/web-hooks` public API —
`useServerReducer(streamId, options)` returning `{ state, offset, digest, status }`
with `status ∈ 'hydrating' | 'live' | 'reconnecting' | 'error'`; the transport rule
(hydrate from `/state` once, then events only — the hook never re-fetches `/state` to
catch up while the tail is recoverable); the inspector route `/inspect/:streamId`; and
the `verify-E3-live` target's shape (dispatcher + Playwright DOM watch + exact digest
diff), which E3-T04..T10 re-instantiate per view. Changing the hook's replay semantics
later invalidates every Epic 3 convergence fixture.

Non-goals: no new reducers (views register those in E3-T04+); no stream-fs rendering
(E3-T06/T07); no dispatch-from-the-browser surface beyond what the inspector needs to
prove liveness (writes in this task's tests go through the Node client against
E0-T11's `/dispatch`); no offline persistence of checkpoints across page reloads (a
reload re-hydrates from `/state` — that is the design, not a gap); no styling beyond
a legible inspector.

## Deliverables

- `packages/web-hooks/src/transport.ts` — the tailing transport: SSE via
  `EventSource`-compatible parsing of E0-T06's frames (resume offset from the frame
  `id:` field), automatic long-poll fallback (used when SSE is unavailable or when
  `options.transport === 'long-poll'`, chaining `Stream-Next-Offset` and re-arming on
  `204`), reconnect with backoff from the last checkpointed offset, and an
  instrumentation surface (counters for sse-frames / long-polls / reconnects /
  events-applied, plus the active transport name) that tests and the inspector read —
  so which path ran is proven, never assumed.
- `packages/web-hooks/src/useServerReducer.ts` — hydrate → tail → reduce, applying
  events strictly in offset order via `@eforest/protocol`'s `reduceStep`; recomputes
  `digest` per applied batch via a browser-safe `stateDigest` (Web Crypto SHA-256 over
  the same canonical JSON encoding — if `@eforest/protocol`'s digest is Node-bound,
  making it isomorphic is in scope for this task, with a committed cross-environment
  vector test proving Node and browser digest the same states identically); exposes
  `{ state, offset, digest, status }`; a torn pair is structurally impossible — state,
  offset, and digest update in one atomic commit per applied batch.
- `packages/web-hooks/src/index.ts` + `package.json` — browser-target build, no Node
  builtins on the import path; `@eforest/protocol` as the only state-shaping
  dependency.
- `packages/web/src/pages/inspect.tsx` — the stream-inspector page at
  `/inspect/:streamId` in the E3-T02 shell: renders `{offset, digest, status,
  events-applied, transport}` live through the hook, with offset and digest exposed
  in the DOM under E3-T02's frozen attribute contract.
- `packages/web-hooks/test/reducer-parity.test.ts` — node-side unit/vector tests:
  hydrate-then-apply over the E3-T01 corpus equals full replay from `-1` (digest
  equality at every prefix); cross-environment digest vectors (Node vs browser
  encoding of the same states).
- `packages/web-hooks/test/hooks.pw.ts` — Playwright against the built shell + a real
  stream server: hydration offset equals the `Stream-Offset` the network response
  carried; live convergence (dispatch via Node client → DOM offset reaches head, DOM
  digest string-equals an out-of-band `GET /state` digest at that offset); the
  hydration/tail boundary (an event landing between `/state` and tail-start is applied
  exactly once); kill-and-resume (server connection severed mid-tail via proxy/route
  abort, dispatches continue, reconnect converges to head with the instrumentation
  showing ≥1 reconnect and no re-hydration `/state` request); long-poll fallback
  (SSE blocked, counters prove long-poll ran, same convergence); zero console errors
  across all of it.
- `tools/verify/live_convergence.sh` — the reusable driver: fresh server, seed the
  E3-T01 corpus, start the built shell, run a Node dispatcher while the Playwright
  watch above asserts DOM/head/digest triple equality, then diff the client-side
  event trail (dumped from the page via the instrumentation hook) against the server
  dump with `ef replay --digest` — nonzero exit naming the first divergent offset
  (`ef bisect`).
- `Makefile`: `verify-E3-live` (the reusable target, parameterized by stream so
  E3-T04+ can point it at their views' streams) and `verify-E3-T03` (standard gates +
  both test files + `live_convergence.sh`), both joining `verify-all`, clean under
  `tools/verify/self_check.sh`.
- `evidence/`: the seed-corpus server dump + client-trail dump + digest file from the
  final run (`e3-t03-server.events.jsonl`, `e3-t03-client-trail.jsonl`,
  `e3-t03-digests.txt` — one identical digest, plus the DOM-sampled
  (offset, digest) pairs each re-derived via truncated replay), the kill-and-resume
  transcript (`e3-t03-kill-resume.txt`, incl. reconnect counters and the absence of a
  second `/state` fetch), and the sensitivity transcript (`e3-t03-sensitivity.md`,
  angle 7). The Replay recording of the inspector converging live
  (`tools/replay/record-run.sh -o e3-t03-final`) is cited by URL in the Verification
  log — never committed.

## Acceptance criteria

- [ ] `make verify-E3-T03` and `make verify-E3-live` exit 0 from a cold clone via
      `tools/verify/cold_clone.sh` with scrubbed env — no warm server, no prebuilt
      shell, no cached corpus.
- [ ] Digest parity at head, exactly: after the scripted dispatch run quiesces, the
      inspector DOM's offset attribute string-equals the server head (fetched
      independently over HTTP) and its digest attribute string-equals both (a) the
      digest of `GET /state` at that offset and (b) `ef replay --digest` over the
      dumped `/events` log — all four values printed by `live_convergence.sh` and
      committed in `evidence/e3-t03-digests.txt`.
- [ ] Client replay, not re-hydration: after the initial hydration, the entire
      convergence run performs **zero** further `GET /state` requests — asserted from
      the Playwright network log in `hooks.pw.ts`; every state transition is a
      client-side `reduceStep` application, counted by the instrumentation and equal
      to the number of events the server dump holds past the hydration offset.
- [ ] Hydration boundary exactness: a test dispatches an event in the window between
      the `/state` response and the tail's first frame; the client applies events
      starting at exactly hydration-offset + 1 — no duplicate of the hydrated
      prefix's last event, no gap — proven by digest equality of the client trail
      against the server dump truncated at each checkpoint (asserted in
      `hooks.pw.ts`).
- [ ] Kill-and-resume converges: with dispatches in flight, the tail connection is
      hard-severed mid-run; the hook reconnects from its checkpointed offset (≥1
      reconnect on the counters, still zero `/state` re-fetches), and final DOM
      offset/digest equal the server head per the parity criterion — transcript in
      `evidence/e3-t03-kill-resume.txt`.
- [ ] Long-poll fallback is real and equivalent: with SSE blocked (route interception
      returning failure for `live=sse`), the run completes over long-poll —
      instrumentation shows sse-frames = 0 and long-polls > 0 — and converges to the
      identical head digest. A run where the counters can't distinguish the paths
      fails this criterion.
- [ ] No torn (offset, digest) pair, ever: `hooks.pw.ts` samples the DOM pair ≥10
      times mid-burst; each sampled digest equals `ef replay --digest` over the
      server dump truncated at that sample's own offset (inclusive). Pairs committed
      in `evidence/e3-t03-digests.txt`.
- [ ] Cross-environment digest identity: the committed vector test digests the same
      canonical states in Node and in the browser (Playwright-evaluated) and asserts
      byte-identical hex — a divergence in canonical encoding or hashing fails it.
- [ ] Zero console errors and zero uncaught exceptions across every Playwright run,
      including the kill-and-resume and fallback runs (transient transport retries
      surface through `status: 'reconnecting'`, not the console).
- [ ] Replay (browser layer): a Replay recording of the inspector page with the DOM
      offset marching to head as Node-client dispatches land — including the
      mid-run disconnect and recovery — cited by URL in the Verification log; if
      `tools/replay/preflight.sh` fails on the machine, declared per AGENTS.md
      (`Replay: N/A (<reason>) + mitigation`) with the Playwright transcript +
      network/console interrogation standing in.
- [ ] All root gates pass (`pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0); `make verify-E3-T01`, `verify-E3-T02`,
      `verify-E0-T06`, and `verify-E0-T10` re-run green on this tree; `make _v-meta`
      stays green after the Makefile edits.

## Adversarial verification

The claim under attack: "the browser holds a true replica — hydrated once from
`/state`, advanced only by client-side replay of `/events`, resumable across any
disconnect, and its DOM-exposed `(offset, digest)` is at all times a truthful,
independently re-derivable statement about the server's log." Use your own streams,
your own dispatch sequences, your own kill schedules — never the builder's. Invent at
least one more angle.

1. **Your corpus, your offsets.** Ignore the seed script's sequence. Create your own
   typed stream, dispatch your own actions (unicode payloads, deep nesting, key
   orders chosen to catch non-canonical encoding), open `/inspect/<your stream>`,
   and compare the DOM pair against your own `ef replay --digest` of your own dump —
   at head and, via the sampled-pairs discipline, at interior offsets. Any mismatch
   at any offset refutes the core claim. Then prove the apparatus can fail: dispatch
   one more event and the DOM digest must change.
2. **The re-hydration cheat.** The cheapest fake convergence is quietly re-fetching
   `/state` at the end and painting the server's answer into the DOM. Watch the
   network yourself (Playwright network log or the Replay recording's network
   timeline): any `GET /state` after the initial hydration during a recoverable tail
   refutes the client-replay claim even if every digest matches. Then force the
   issue: block `/state` entirely after first load and run your dispatch sequence —
   convergence must still happen; a hook that stalls or errors without `/state`
   was never replaying.
3. **Boundary off-by-one sweep, your schedule.** For every i in a K-event run:
   arrange hydration to land at offset i (pre-seed i events, mount, then dispatch the
   rest), and separately sever the connection after the client applies i events, then
   resume. Any duplicate of the boundary event or skipped first suffix event shows up
   as a digest divergence — pin it with `ef bisect` between the client trail and the
   server dump. One divergent offset refutes resume exactness.
4. **Race the hydration window.** Hammer dispatches concurrently with mount so events
   land between the `/state` response and tail-start, and mid-reconnect. Repeat ≥20
   trials. Any trial whose final client digest diverges from the server head refutes;
   so does any trial where events-applied ≠ (server events past hydration offset).
5. **Second-fold hunt (sentinel sabotage).** In a scratch worktree, mutate
   `@eforest/protocol`'s `reduceStep` to inject a sentinel field. Every client-side
   digest — hydrated-then-tailed, post-reconnect, long-poll path — must change (and
   parity with the equally-mutated server must *hold*). A client digest unchanged
   under the mutated core proves the hook folds state through a second
   implementation (a port, a memo, a shortcut) and refutes the single-replay-path
   inheritance. Separately grep `packages/web-hooks` for any event-folding loop that
   isn't a call into the protocol core.
6. **Fallback honesty.** Read the diff: does the long-poll path share the offset
   checkpointing with SSE, or is it a second resume implementation? Then attack
   dynamically: block SSE mid-run (not just at start) and confirm the hook degrades
   to long-poll and still converges; flip back; kill during a parked long-poll. Any
   gap/duplicate across a transport switch — digest bisect to the offset — refutes.
   Counters claiming a path ran must match the network log; a counter the network
   contradicts refutes the instrumentation.
7. **Sensitivity of the measuring apparatus.** In a scratch worktree, sabotage the
   transport to (a) drop exactly one event, (b) apply one event twice, (c) apply two
   events out of order, and (d) hardcode the DOM digest attribute. `make
   verify-E3-live` (and the Playwright suite) MUST go red under each — compare
   against `evidence/e3-t03-sensitivity.md`. Any sabotage that stays green refutes
   the apparatus, which is this task's entire product: every later Epic 3 view
   inherits this target.
8. **Torn-state hunt.** While a writer hammers dispatches, sample the DOM pair as
   fast as Playwright allows (and via the Replay MCP, evaluate at arbitrary points in
   the recording). Every sampled digest must equal truncated replay at that sample's
   own offset. One pair where the digest belongs to a different offset — state ahead
   of its label or behind it — refutes the atomic-commit claim.
9. **Malformed-frame fuzz.** Interpose a proxy that mangles the tail: truncated SSE
   frames, a frame with a bogus/regressing `id:`, an event whose envelope fails
   canonical parsing, an event for the wrong stream. The hook must surface
   `status: 'error'` (or reconnect-and-recover where the protocol allows) without
   ever committing a state whose digest diverges from some true prefix of the server
   log, and without console exceptions. A silently-diverged green DOM after garbage
   in refutes.
10. **Cold clone + residue hunt.** Everything through `tools/verify/cold_clone.sh`,
    scrubbed env, network observed (loopback only). Hunt for evidence residue: a
    digest computed once and echoed into the DOM, expectations encoding the
    builder's exact dispatch timing, tests talking to a dev server on a fixed port,
    an inspector that reads offset/digest from anywhere but the hook's return value.
    Confirm the cited Replay recording actually contains the disconnect scene — a
    recording missing a claimed scene fails sufficiency.

Refutation currency: a client trail + the first divergent offset (`ef bisect`), a
network log showing a post-hydration `/state` fetch, a sampled DOM pair whose digest
matches no truncation of the server dump, a sabotage run that stayed green, or a
Replay point link where the DOM contradicts the stream. "The inspector felt live" is
not a finding.

## Verification log
