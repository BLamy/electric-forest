---
id: E3-T10
epic: 3
title: "Capstone: the-reading-room — cold-start browse org to repo to tree to file; a second session's stream-fs edit appears live, DOM offset equals the server head"
priority: 310
status: pending
depends_on: [E3-T04, E3-T08, E3-T09]
estimate: L
capstone: true
---

## Goal

ROADMAP's Epic-3 demo — **the-reading-room** — runs mechanically, from a cold start,
under `make verify-E3-T10` (also exposed as `verify-E3-capstone`, an alias to the same
recipe, joined to `verify-all`). From a pristine clone (`tools/verify/cold_clone.sh`,
scrubbed env per the E0-T02 contract), with a **fresh stream-server data dir and platform
state created by the run itself** and a **fresh Playwright browser profile** (no cookies,
no localStorage, no credentials), the orchestrator cold-starts the E2-T02 emulator and
the platform server, seeds the E3-T01 corpus (`make seed-canopy`, the committed fixture —
nothing invented at run time by the code under test), then Playwright — under Replay
Chromium via `tools/replay/record-run.sh -o e3-t10-final` — logs in through the
`@eforest/browser-verify` harness (`loginAs`, the login interaction visibly executing in
the recording) and walks **every canopy surface in one recorded browser session**: the
repo list at `/` (E3-T04), org browse (E3-T04), a repo home with its live project status
badge (E3-T05), the branch switcher re-anchoring to a non-main branch (E3-T08), the file
tree (E3-T06), an open file in the viewer (E3-T07), and the commit-less history view
(E3-T09). Mid-session, a **scripted second session** — a plain Node process using the E0
writer and the E0-T11 dispatch door with an E2-T05 token, never the browser — dispatches
a stream-fs text patch (E1-T03) against the exact file the viewer has open, and the open
viewer renders the patched content **live, with zero page reloads and zero
re-navigations** (navigation count asserted); the E3-T09 history view, revisited in the
same session, shows the patch event's row citing its offset and actor. The verdict is
the ROADMAP milestone claim made mechanical: at every asserted stop of the walkthrough,
`collectEfRegions(page)` (E3-T02's frozen apparatus) returns every rendered region's
`data-ef-stream` / `data-ef-offset` / `data-ef-digest` triple, and for **every** region
the `data-ef-offset` equals that stream's head fetched independently out-of-band (never
from the page) and the `data-ef-digest` is byte-equal to `ef replay --digest` over an
independent dump of that stream taken at that offset — "DOM exposes the stream offset it
has replayed to and it matches the server's head", for all regions, not one. Zero
console errors and zero uncaught exceptions across the entire recording. Epic 3 is done
when this target cannot be distinguished from the ROADMAP capstone paragraph by any
observable.

## Context

This is the Epic-3 capstone (ROADMAP "Epic 3 — the-canopy", capstone paragraph: "browse
org → repo → tree → file; a second session edits the file through stream-fs and the open
viewer updates live, no reload; DOM exposes the stream offset it has replayed to and it
matches the server's head"). Per `.eforest/tasks/README.md`, a capstone additionally
requires its demo end-to-end **from a cold start** — fresh clone, fresh browser profile,
fresh stream-server data dir, no state left over from development. This task is
**composition and proof only**: it adds zero product surface, zero routes, zero hooks,
zero server endpoints. Anything the demo needs that a dependency failed to deliver is a
finding against that dependency, not a workaround absorbed here — a capstone that
patches around its epic refutes the epic.

`depends_on` is the minimal cover: E3-T08's transitive closure carries E3-T05/T06/T07
(and through E3-T03/T02/T01, the hook, the shell, and the corpus), E3-T09 carries the
history view, E3-T04 carries the list/org surfaces. The epic-gate criterion below
independently demands E3-T01…E3-T09 verified.

- **E3-T01** supplies the deterministic corpus the whole walkthrough browses and the
  golden per-stream digests this task's parity checks are anchored to. The demo browses
  exactly this corpus; the only in-run mutation is the second session's patch.
- **E3-T02** supplies the authenticated shell, the frozen DOM exposure contract
  (`data-ef-stream` / `data-ef-offset` / `data-ef-digest`), and the
  `@eforest/browser-verify` harness (`bootWorld`, `loginAs`, `collectEfRegions`, the
  default-on console-error tripwire) this task consumes as-is.
- **E3-T03** supplies `useServerReducer` — every live behavior in the demo is that hook
  following its stream; a dropped or duplicated frame here is a finding against E3-T03.
- **E3-T04/T05/T06/T07/T08/T09** supply the six surfaces the walkthrough visits; their
  own verify targets re-run green against this tree as part of the epic gate.
- **E1-T03** (via the closure) defines the stream-fs patch event the second session
  dispatches; **E2-T05** supplies its token; **E0-T11** supplies the dispatch door.

This task is browser-impacting by definition: the Replay recording is not optional
evidence, it **is** the demo (`Replay: N/A` is not an acceptable claim on a machine
where `tools/replay/preflight.sh` passes; if preflight cannot pass, the task blocks
rather than downgrades).

## Deliverables

- `tools/verify/e3-capstone/` — the demo as code, runnable by anyone:
  - `scenario.json` — committed fixture: the login subject (referencing the E3-T01
    corpus's named subjects by `sub`), the org/repo/branch walked, the exact file path
    opened in the viewer, and the exact E1-T03 patch payload the second session
    dispatches (so the post-patch content and digests are frozen artifacts).
  - `run.sh` — the orchestrator: creates a scratch workspace (paths printed); boots the
    emulator and platform server on ephemeral ports with fresh data dirs **inside the
    scratch space**; runs `make seed-canopy` against them and asserts the seeded
    per-stream digests equal the committed E3-T01 goldens **before** any browsing;
    launches the walkthrough under `tools/replay/record-run.sh -o e3-t10-final` with a
    fresh browser profile (dir created in scratch, echoed); runs the verdict phase —
    for every region triple collected during the run: an independent head fetch, an
    independent dump, `ef replay --digest` compared byte-for-byte; nonzero exit naming
    the failing region/stream/offset on any mismatch. A standalone re-check mode —
    `run.sh --check <stream-dump> <digest-file>` — recomputes a dump's digest via
    `ef replay` and compares, so the apparatus can be exercised against tampered
    copies without a live run. The live-edit budget `run.sh` enforces defaults to
    E2-T08's frozen 2000 ms constant; any override (as in the sensitivity drills) is
    an explicit deviation from that committed value, printed in the transcript.
  - `walkthrough.spec.ts` — the Playwright script: logged-out `/`; `loginAs` through
    the emulator (the login form interaction inside the recording); then, at each stop
    — repo list, `/orgs/:org`, repo home (asserting the E3-T05 status badge's rendered
    state equals the project state reduced from an out-of-band dump), branch switcher
    to the corpus's forked branch (fork offset visible per E3-T08), file tree, open
    file, history view — calls `collectEfRegions(page)` and hands every triple to the
    out-of-band verdict apparatus. Mid-session, with the viewer open, it spawns
    `second-session.ts` and asserts the patched content renders within E2-T08's frozen
    2000 ms live budget of dispatch-accept, with navigation count unchanged and no
    request matching the E3-T03 hydration endpoint (`GET /streams/{id}/state`, E0-T10's
    frozen surface, any query) for the open file's content stream in the captured
    network log between dispatch-accept and viewer-update (the update attributable to a
    tail frame, quoted with its offset); then revisits history and asserts the patch
    row's offset and actor.
  - `second-session.ts` — the Node-side second session: authenticates via an E2-T05
    token, dispatches the committed E1-T03 patch through the dispatch door, prints the
    dispatch-accept timestamp and the resulting content-stream and fs-metadata offsets
    for the transcript. It never touches the browser or the page context.
- `Makefile`: `verify-E3-T10` per the E0-T02 target contract, `verify-E3-capstone` as
  its alias, both joined to `verify-all`, visible in `make verify-list`; `.PHONY`
  updated; `tools/verify/self_check.sh` still green.
- Committed evidence in
  `.eforest/tasks/epic-3-the-canopy/E3-T10-the-reading-room/evidence/`:
  - `regions.txt` — every `collectEfRegions` triple from every asserted stop, each
    paired with the exact out-of-band head-fetch command + result and the exact
    `ef replay --digest` command + result that matched it.
  - `file-log.jsonl` + `file-log.digest` — the opened file's content-stream dump at
    demo end (containing the second session's patch event at a cited offset) and its
    replay digest; likewise `fs-meta-log.jsonl` + `.digest` for the branch's metadata
    stream.
  - `live-edit.txt` — dispatch-accept timestamp, viewer-update timestamp, the tail
    frame and its offset, the navigation-count assertion, and the no-refetch grep of
    the captured network log for the update window.
  - `seed-parity.txt` — the pre-browse comparison of the run's seeded per-stream
    digests against the committed E3-T01 goldens.
  - `sensitivity.md` — the sabotage transcripts (see acceptance criteria).
  - `cold-clone-capstone.txt` — the `tools/verify/cold_clone.sh verify-E3-T10`
    transcript plus a `verify-all` transcript at the same SHA (every `verify-E0-*`,
    `verify-E1-*`, `verify-E2-*`, `verify-E3-*` target's OK line present).
- Verification log entry (builder claim): commit hash, every command and exit code,
  digest values and offsets, evidence paths, and the **Replay recording URL** with
  point/time anchors at (a) the login submission, (b) each walkthrough stop's asserted
  region state, (c) the second session's tail frame arriving, (d) the viewer showing
  the patched content, (e) the history row for the patch.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E3-T10` exits 0 from pristine committed HEAD
      in a scratch dir with scrubbed env, zero `SKIPPED:` lines; the transcript
      (`evidence/cold-clone-capstone.txt`) shows the stream-server data dir, platform
      state, and Playwright browser profile all created inside the run's scratch space
      (paths printed) — none reused from the working tree, `/tmp`, or a dev server —
      and the corpus seeded in-run with `evidence/seed-parity.txt` matching the
      committed E3-T01 goldens before any page loads.
- [ ] One recording, whole demo: a single Replay recording URL, produced by
      `tools/replay/record-run.sh -o e3-t10-final` during the verify run, contains —
      as interrogable DOM/network state at cited points — the login executing, all
      seven surfaces (repo list, org browse, repo home + status badge, branch
      switcher, tree, open file, history) being visited, the second session's patch
      arriving as a tail frame, and the viewer rendering the patched content; zero
      console errors and zero uncaught exceptions anywhere in the recording. URL and
      anchors in the Verification log.
- [ ] The milestone equation, every region: for every triple `collectEfRegions`
      returned at every asserted stop, `evidence/regions.txt` shows `data-ef-offset`
      equal to that stream's head fetched out-of-band at assert time, and
      `data-ef-digest` byte-equal to `ef replay --digest` over an independent dump of
      that stream at that offset. Zero regions exempted; a stop whose page renders a
      stream-derived region missing the contract attributes fails this criterion.
- [ ] Live edit, no reload: the second session's dispatch-accept-to-viewer-update
      interval is within E2-T08's frozen 2000 ms live budget; the Playwright
      navigation count over the update window is zero; the captured network log for
      the window contains no request matching the E3-T03 hydration endpoint
      (`GET /streams/{id}/state`, E0-T10's frozen surface, any query) for the open
      file's content stream after hydration — the update is attributable to a quoted
      tail frame at a quoted offset (`evidence/live-edit.txt`). Post-update, the
      viewer's region offset equals the content stream's new head and its digest
      equals the dump digest at that head — the committed
      `evidence/file-log.jsonl` contains the exact `scenario.json` patch payload at
      that offset and replays to `evidence/file-log.digest`.
- [ ] History tells it: after the patch, the E3-T09 history view for the branch shows
      a row for the patch event citing the same offset the dump carries and the second
      session's actor identity, appended live (asserted in the same session, cited in
      the recording).
- [ ] Sensitivity (mandatory, inside `make verify-E3-T10` against scratch builds):
      (a) make one region publish a stale `data-ef-offset` (head−1) — the
      offset-equality verdict goes red naming that region; (b) make the viewer's tail
      silently drop patch frames — the live-edit criterion goes red; (c) hardcode one
      region's `data-ef-digest` to a plausible hash — the byte-equality against the
      independent replay goes red; (d) `run.sh --check` against a one-byte-mutated
      copy of `evidence/file-log.jsonl` exits nonzero and `ef bisect` names the
      tampered offset. Any sabotage the suite stays green on fails this criterion;
      transcripts in `evidence/sensitivity.md`; working tree clean of plants after.
- [ ] Zero product surface added: the task's diff touches only
      `tools/verify/e3-capstone/`, the Makefile targets, evidence, and this readme —
      no `packages/*` or app-source change without a documented finding filed against
      the owning dependency.
- [ ] Epic gate: every Epic-3 task E3-T01…E3-T09 is `verified` in frontmatter (or
      carries a documented optional/stretch exemption stated in both its Context and
      this readme — none is currently declared); after
      `python3 tools/build_queue.py`, `git diff --exit-code .eforest/tasks/QUEUE.md`
      passes, and QUEUE.md lists no Epic-3 task as pending/in-progress/implemented
      except E3-T10 itself.
- [ ] `make verify-all` exits 0 at the claimed commit **inside the same cold clone**
      (transcript in `evidence/cold-clone-capstone.txt`), running every `verify-E0-*`
      through `verify-E3-*` target — the expected set pinned from task readmes (every
      implemented/verified task names a target in `make verify-list` and its OK line
      appears), not from the Makefile. All five workspace gates
      (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`)
      exit 0, each command and exit code recorded in the Verification log.

## Adversarial verification

The claim under attack: "from nothing, one recorded session browses the whole canopy,
a second session's stream-fs edit lands live in the open viewer, and every rendered
region's offset and digest equal the server's independently-measured truth." Attack the
*from nothing*, the *one recording*, the *live*, and the *every region* separately.
Use your own subjects, file paths, patch payloads, and tamper offsets — never the
builder's. Any single success refutes. Invent at least one more angle.

1. **Cold-start sabotage.** Run `tools/verify/cold_clone.sh verify-E3-T10` yourself,
   then again with a poisoned caller env (`NODE_OPTIONS`, `NODE_ENV=production`,
   `EF_HOME` at a dir with valid dev credentials, `npm_config_registry` at a dead
   port), a warm dev emulator + platform server left on likely ports with the corpus
   already seeded, and a planted logged-in browser profile. The run must build its own
   world (scratch paths printed) and the recording must show the login interaction
   executing — a session that opens authenticated, or a corpus the run did not seed
   itself (check `seed-parity.txt`'s timestamps against server boot), refutes the
   fresh-start claim. Grep `tools/verify/e3-capstone/` for fixed ports, absolute
   paths, `~/.`-anything, or reads outside the scratch space.
2. **One-recording honesty, via the Replay MCP.** All seven surfaces, the tail frame,
   and the live update must be interrogable inside the single cited recording: (a) a
   walkthrough stitched from multiple recordings, or a surface "visited" only in the
   transcript, refutes; (b) at each cited anchor, evaluate the region attributes in
   the recorded DOM and check them against `evidence/regions.txt` — a mismatch is a
   currency lie; (c) find the patch's tail frame as a network event and confirm the
   viewer's content change follows it with no navigation and no snapshot request in
   between — an update that coincides with a refetch or reload refutes "live, no
   reload"; (d) sweep the whole recording for console errors and uncaught exceptions —
   one hit refutes.
3. **Every-region audit, crueler than the builder's.** Re-run with your own scenario
   (different subject, different file, your own patch bytes). At each stop, collect
   the triples yourself and recompute everything out-of-band — never trust the page's
   numbers or the builder's transcript: fetch each stream's head independently, dump
   it independently, `ef replay --digest` it yourself. Then race it: fire N rapid
   patches from your own node client while the viewer and history are open, let it
   settle, and demand every region's offset equal the true head (not head minus
   stragglers) and every digest recompute green. One region trailing after settle, or
   one page that renders stream-derived state with no contract attributes for
   `collectEfRegions` to find (an invisible region is an unaudited region), refutes.
4. **Second-session authenticity.** The editor must be a genuinely separate session:
   confirm in the recording and the network capture that the patch was **not**
   dispatched from the page context (no dispatch request originating from the
   browser), and that `second-session.ts` authenticated with its own E2-T05 token.
   Then substitute your own second session and payload — including a patch that
   renames the open file and one that patches a *different* file in the same tree —
   and confirm the viewer, tree, and history each react per their own tasks'
   contracts (tree re-renders the rename, viewer follows its stream, no cross-wired
   update). A demo that only works with the committed payload refutes
   determinism-by-design.
5. **Apparatus sabotage, your own.** Re-run the committed sensitivity drills, then add:
   (a) point the verdict phase's "independent" head fetch at a value read from the
   page (self-licking) — the run must fail its own self-check or the drill must prove
   it cannot be so pointed (trace where the comparison values come from in `run.sh`);
   (b) shrink the live budget from its committed 2000 ms default (E2-T08's frozen
   constant) to 1 ms — the live-edit assertion must go red (proves it's a real timing
   gate, not decoration); (c) tamper a copy of each committed dump
   at your own offsets — delete one event, duplicate one, swap two adjacent —
   `run.sh --check` must go red and `ef bisect` must name the first divergent offset
   each time. Any green under sabotage refutes the measuring apparatus and every
   transcript cited here.
6. **Composition, not patchwork.** Diff this task's commits: any hunk in `packages/*`
   or the app source refutes "zero product surface" unless the readme documents a
   filed finding against the owning dependency. Any edit to `tools/verify/*.sh`, an
   earlier task's Makefile recipe, or a dependency's suite needs a stated reason — a
   capstone that loosened a dependency's gate to pass is refuted outright. Then
   re-run `verify-E3-T01` through `verify-E3-T09` against this tree yourself; a
   dependency target that no longer passes voids the epic gate.
7. **Evidence authenticity + epic-gate audit.** Re-earn every committed artifact:
   `ef replay` over the committed dumps must print the committed digests; the offsets
   in `regions.txt` and `live-edit.txt` must exist in the dumps with the claimed
   payloads; the patch event in `file-log.jsonl` must byte-match `scenario.json`. A
   committed artifact you cannot reproduce from committed code is fabricated evidence
   and refutes outright. Then audit the gate: E3-T01…E3-T09 all `verified` with
   Verification-log entries to match, queue regenerated and clean, `verify-all` at the
   claimed SHA green with every E0–E3 OK line counted.

Refutation currency: a Replay point link where the recording contradicts the claim, a
region triple whose recomputed head or digest disagrees, a viewer update that rode a
refetch, a dispatch request originating from the page context, a tamper that stays
green, a grep hit outside the scratch space, or an undocumented diff hunk in product
code. "The walkthrough felt smooth" is a caption, not a finding.

## Verification log

(appended over time by builders and critics)
