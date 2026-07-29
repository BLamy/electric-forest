# AGENTS.md — how agents drive this repo

Operating manual for any agent (or human) working on electric-forest. `ROADMAP.md` says
where we're going. `.eforest/tasks/QUEUE.md` says what's next. `.eforest/loop.md` defines
the loop this file operationalizes. This file says how work gets done — and, more
importantly, how work gets **proven**.

## The one rule

A builder being satisfied is a **claim**. A deterministic recording of the run that
satisfied them is **evidence**. No task reaches `verified` on claims: a separate,
adversarial critic session must interrogate the evidence, hold it against the diff, and
fail to refute it. Every other rule in this file serves that one.

The pattern is the worker/critic proof loop from Replay-style web verification (via
wasm-vm and the figma-clone, this repo's doctrine donors). Here it comes full circle: the
product we are building — durable streams that store every mutation as an appendable,
replayable event — **is** the core evidence layer. The critic interrogates an actual
**Replay browser recording** of the app session (time-travel through console, network,
exceptions, and source execution, via the Replay MCP) and/or the **deterministic event
log** a durable stream produces about itself. Same doctrine either way: _not "trust me, I
checked" — here is the session where it worked, in full; interrogate it._

## Roles

**Builder** — implements exactly one task from the top of the queue. Self-validates as
much as it likes (ephemeral runs, no limit — all of it inside the task's own `work/`
folder), then submits three things: the diff, a claim, and recorded evidence of the final
happy run.

**Critic** — a **fresh session**, never the one that implemented. It does not fix code and
does not take the builder at its word. It attacks the claim from two directions:

1. **Falsification** — find one point in the evidence where the program contradicts the
   claim or the task's acceptance criteria.
2. **Sufficiency** — find changed code the evidence never exercised. Unexecuted diff is
   either unproven (demand a run that exercises it) or dead (demand deletion).

A builder can therefore fail two ways: the evidence contradicts the claim, or the evidence
doesn't cover the claim.

**Progress critic** — another fresh, read-only session, distinct from every builder and
critic whose reports it reviews. After every third failed verification run for the same
task, it receives the complete reports for the latest three runs and decides whether the
loop is making genuine progress or death-spiraling. Progress requires cited closure or
meaningful narrowing of earlier findings through general invariants, a compounding
permanent suite/evidence corpus, deeper or more compositional new counterexamples, and no
regression or gate weakening. Renamed findings, narrow exceptions, repeated
counterexamples, or loss of previously surviving behavior are a death spiral. Uncertain
means stop. A `progressing` verdict earns only the next window, and no task may exceed ten
verification runs without a later, explicit human recovery authorization. A completed
checkpoint is inherited byte-for-byte, including a genuine `progressing` assessment when
the authorized ceiling alone caused the stop. A human may override a recorded failed
checkpoint but never relabel it as progress or erase it.

A bounded recovery ceiling can be lower than the default autonomous ceiling when the
recorded stop occurred at an earlier checkpoint. That lower ceiling is not a shortcut:
it still requires the full commit-attested human-resume lifecycle and grants at most three
additional runs.

Verification-run accounting is durable and task-global. Before any builder call, the
queue workflow requires two fresh readers to return byte-identical output from the
committed deterministic snapshot command. That command reads project state, generated
queue, canonical task path/frontmatter, complete numbered judge history, and progress
checkpoints from `git show HEAD:<path>` and binds them to the full commit OID plus SHA-256
digests. A restart after run 6 must still submit reports 4-6 before run 7; stale resumes
after 3/6/9 fail closed, and no process restart or human resume resets the counter or
ceiling. Project state, history, identity/path, lifecycle, run limits, and structured
progress citations all fail closed. Writer booleans are never persistence evidence: a
fresh reader pair must observe a different promised commit OID and the exact status,
ledger, audit/verdict entry, and queue delta before implementation continues.

When a human-authorized control bridge must recognize historical verdict prose, the
compatibility is valid only when every migrated entry is pinned by its full committed
digest. Broad legacy-heading acceptance or stopped-task rewriting weakens the gate and is
forbidden.

The same agent may play these roles on _different_ tasks — never more than one role on the
same task or progress-audit window. The roles also exist as installable subagents
(`.claude/agents/replay-worker.md`, `.claude/agents/replay-critic.md`, from Replay's
official plugin bundle) and as runnable orchestrations
(`.claude/workflows/implement-task.js`, `verify-task.js` — see Workflows below).

## Task lifecycle

```
pending → in-progress → implemented → verified   (terminal; only the critic sets this)
                              ↘ refuted → in-progress (builder reworks, re-records)
```

Statuses live in each task's `readme.md` frontmatter
(`.eforest/tasks/epic-*/E*-T*/readme.md`). After any status change:
`python3 tools/build_queue.py` regenerates `.eforest/tasks/QUEUE.md`, then commit. One
task in-flight at a time; a task's `depends_on` must all be `verified` before starting it.

The **project** has a state too, in `.eforest/project.json`: `building` while the loop has
eligible work, `complete` when every task including the final capstone is verified,
`paused` when a human halts it, `invalid_loop` when the loop can no longer make progress
honestly (a three-run progress audit finds a death spiral or cannot establish progress,
the tenth verification run fails, gates cannot be fixed without being weakened, or a
roadmap-audit finding the board lies). Flipping to `invalid_loop` is a
loud stop for a human — never route around it. `.eforest/loop.md` is the contract.

## Builder protocol

1. **Pick work.** Top entry of "Next up" in `.eforest/tasks/QUEUE.md`. Read the whole task
   readme — the Adversarial verification section tells you how you'll be attacked; build
   for it.
2. Set `status: in-progress`, rebuild queue, commit.
3. **Implement.** Gates in ascending cost, any failure returns to the top:
   `pnpm format:check && pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`.
   (If the workspace predates a gate — e.g. no package.json yet because THIS task creates
   it — the gate applies from the moment it can.)
   3a. **Browser-impacting work ⇒ prove it in the browser, and show it on the app.** If a
   change touches anything a user can reach through the web app (repo browsing, file
   views, live sync indicators, the task board, auth), you MUST:
   (a) **Update the web app to surface the new capability** so it keeps proving the whole
   machine works — live stream offsets/digests visible in the DOM where applicable,
   the new interaction reachable. The app is the at-a-glance monitor — it must never
   silently fall behind what's landed.
   (b) **Drive it headlessly**: Playwright loads the built app, asserts **zero console
   errors**, asserts DOM-exposed state digests/offsets match committed expectations,
   and exercises the new interaction through real pointer/keyboard events.
   (c) **Record the final walkthrough under Replay Chromium** and upload it (see Evidence
   below). The walkthrough must exercise every changed browser-reaching behavior,
   including error/removal paths. Cite the recording URL in your claim.
   (d) **One recorded session produces BOTH artifacts — the MP4 video and the Replay
   recording.** The replayio skill's lifecycle scripts are the door:
   `browser-open.js <url> --output recordings/<claim>.mp4` opens Replay Chromium
   with recording flags enabled AND starts WebM capture; you drive the walkthrough
   through the agent browser (`playwright-cli -s=<session>` commands using the
   returned `playwright_session`); `browser-close.js --session <s> --output <path>`
   stops capture, ffmpeg-transcodes to a **verified** MP4, and **uploads the
   finished Replay recordings via the replayio CLI** — never rename WebM to .mp4,
   never record the video and the Replay session as two separate runs (they must be
   the same session or the video proves nothing about the recording). MP4s land
   under `recordings/` (gitignored — the **Replay URL is the durable citation**);
   multi-client runs stitch into ONE side-by-side MP4 via `stitch-videos.js` (two
   clients converging on one branch is our signature demo); slack-clone's
   `record-two-replays.mjs` + `recordings/latest.json` is the scripted-scenario
   shape. **Embed the video with markdown in the message that reports the work** —
   `![e3-t04-final](recordings/e3-t04-final.mp4)` — and name the mp4 path + Replay
   URL in the Verification log entry. If upload fails but the MP4 verifies, the MP4
   is still evidence — report the upload failure separately, never silently. No
   video produced = the run failed loudly.
   Non-browser work (protocol core, CLI, server internals, tooling, docs) skips this gate
   but still records stream-layer evidence.
4. **Self-validate freely.** Drive the code however you want — ad-hoc runs, scratch
   scripts, throwaway browser sessions. This inner loop is yours; nothing here is
   evidence. All of it lives in the task folder's `work/` (gitignored) — a task folder is
   the task's whole workshop, not just its spec.
5. **Record the final happy run.** When satisfied, run the _same_ validation one more time
   under recording (see Evidence below). Make the recorded run count: every behavior your
   diff changes should actually execute during it, because the critic will hold the
   recording against the diff. Changed code the recording never ran is either unproven or
   dead, and the critic gets to decide which. Durable artifacts (event-log dumps, digest
   files, Playwright traces) go in the task folder's `evidence/` (committed).
6. **Write the claim** as a Verification log entry in the task readme: commit hash, exact
   commands run, evidence (event-log paths, state digests, stream offsets, Replay
   recording IDs/URLs), and one paragraph stating what the recording demonstrates. **Name
   the evidence layer for every claim; declare absence explicitly** —
   `Replay: N/A (<reason>) + mitigation` — silence is forbidden.
7. Set `status: implemented`, rebuild queue, commit.

Know that the critic inspects the full runtime of your recording — console, network,
exceptions, source execution, DOM state over time — not just what your test printed. It is
looking for any point where behavior contradicts the task, and for any changed line your
run never executed.

## Pull requests carry evidence

**Publication routing is fixed:** never use the GitHub CLI (`gh`) in this repository.
Use local `git` for commits and `git push`; use the connected GitHub app to create pull
requests and read or update PR metadata.

Every PR opened on this repo states its browser-layer evidence in the PR body, one of
exactly two ways (`.github/pull_request_template.md` enforces the section):

1. **Replay recording link(s)** — the `https://app.replay.io/recording/<id>` URL(s) of
   the session(s) that validated the change. The link in the PR is the proof that
   Replay was actually used to validate; a reviewer (or the replay-critic) opens it and
   interrogates the session.
2. **A justification** — the literal form `Replay: N/A (<reason>) + mitigation`, where
   the reason explains why no browser session can validate this PR (pure protocol/CLI/
   server change, docs, planning) and the mitigation names the stream-layer evidence
   that stands in (event-log dump, digest comparison, conformance run, test output).

This is distinct from the MP4 video convention above: the video is an inline visual for
report messages and threads; the **Replay link is the validation proof**, and it is the
link that the PR requires. A PR with neither a recording link nor a justification is
not reviewable — silence about evidence is the one thing the doctrine forbids
everywhere. Reviewers refuse it the way the dispatch door refuses a malformed event.
The platform itself mirrors this rule once Epic 5 lands: merging a hosted PR requires
an evidence attachment or an explicit waiver event (E5-T06 gate + E5-T10
attachment/reference model — Replay links are `evidence.linked` reference events).

## Evidence: two layers of time travel

| Layer                              | Records                                                                                                                                                                                                                                                                                           | Tooling                                                                                                                                                                                            | Runs where                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Stream** (the event machine)     | every dispatched action (append-only, offset-addressed, canonical JSON events), state digests (SHA-256 over canonically-encoded reduced state), replay determinism (same log replayed twice → identical digest), branch-divergence bisect (first offset where two streams' state digests diverge) | the durable-stream server + `ef replay <dump> --digest` + `ef bisect` (land in Epic 0; until then, deterministic test output captured to `evidence/`)                                              | everywhere — node, CI, this Mac                                                            |
| **Browser** (the app in the world) | the entire browser session: user events, console, network, exceptions, source execution — time-travel debuggable                                                                                                                                                                                  | Replay Chromium + `replayio` CLI + the **Replay MCP** (`.mcp.json` server `replay` = `npx -y replayio mcp`); lifecycle scripts in `.claude/skills/replayio/scripts/`; see `tools/replay/README.md` | anywhere Replay Chromium runs (macOS included) — needs `replayio login` / `REPLAY_API_KEY` |

- The stream layer answers _"did the event machine do the right thing?"_ Every mutation
  flows through the dispatch door onto a durable stream, so every session is a replayable
  trace, `replay(log)` from offset `-1` is ground truth, and equality claims are digest
  comparisons (exact, not eyeballs). The product being its own Replay browser is the
  founding bet of this repo, and stream-layer evidence is mandatory for every task once
  the trace infra lands (Epic 0 onward).
- The browser layer answers _"why did the app do what it did?"_ — and gives the critic the
  killer moves: jump to any point in the recording, evaluate expressions there, read the
  console and network activity around it, and confirm the claimed behavior actually
  happened in the claimed session. Mandatory for every browser-impacting task.
- The citation currency: a Replay **point link**
  (`https://app.replay.io/recording/<id>?point=<p>&time=<ms>`). For stream-layer findings:
  event-log file + offset + digest. A finding without a citation anyone can jump to is not
  a finding.
- The stream-layer `whowrote`: **digest bisect** — replay the event log, compare state
  digests against a known-good reference, and binary-search the first divergence. "Which
  event corrupted the state" gets an exact offset, the way `reverse-continue` gets an
  exact line.
- Record with `tools/replay/record-run.sh -o <claim-name>` (builds the web app first so
  the recording holds the app, not the compiler; uploads; prints the recording URL). Name
  recordings for claims: `-o e0-t20-final`. Recordings live in the Replay cloud and are
  cited by URL — never committed.
- **Videos ride along — same session, both artifacts**: every recorded browser run goes
  through the replayio skill's lifecycle scripts (`browser-open.js` → drive via
  `playwright-cli` → `browser-close.js`), which capture a verified MP4 of the very
  session Replay Chromium is recording and upload the recording via the replayio CLI on
  close. MP4s live under `recordings/` (gitignored; a `latest.json` summary carries run
  metadata — Replay URLs, mp4Path, source videos), multi-client sessions stitch into one
  side-by-side MP4, and the builder/critic **embeds the video with markdown in its
  report message** (`![<claim>](recordings/<claim>.mp4)`) so every browser claim is
  watchable inline. The Verification log cites the Replay URL (durable) plus the mp4
  filename; a run that produces no video fails loudly.
- **Validation leans on the Replay MCP.** The worker's inner loop may use direct
  agent-browser inspection freely (DOM snapshots for locator ground truth, console and
  developer logs, screenshots, read-only page evaluation) — that is self-validation, not
  evidence. **Validation is interrogation of the uploaded recording through the Replay
  MCP**: timeline shape, console/network/exceptions at points, expression evaluation and
  logpoints at the claimed moments, source-execution coverage against the diff. The
  uploaded Replay timeline is the source of truth for runtime state; screenshots, DOM
  snapshots, local MP4s, and passing self-checks are supporting context only. A claim
  no one has held against the recording through the MCP is unvalidated.
- Until `tools/replay/preflight.sh` passes on a machine (Replay Chromium installed,
  authenticated, MCP reachable), browser evidence falls back **loudly** to Playwright plus
  console/network interrogation, and every claim carries `Replay: N/A (<reason>) +
mitigation`.

## Critic charter

You receive: the task readme (claims, acceptance criteria, attack list), the diff
(`git diff` scoped to the task's commits), and the evidence from the Verification log.
Your goal is to refute. You do not edit implementation code; your writes are limited to
the Verification log, promoted tests, and the status field.

**Your primary instrument for browser claims is the Replay MCP** (server `replay` in
`.mcp.json`; load its tools via ToolSearch "replay"). You do not re-drive the app to
check a browser claim — you interrogate the session the builder recorded. Every
capability the MCP gives you — jump to a point, evaluate expressions there, add
logpoints post-hoc, read console/network/exceptions around a moment, audit source
execution — exists so a verdict can rest on what actually happened, not on a rerun that
might behave differently.

**ORIENT.** Read the task readme and the diff before touching evidence. For Replay
recordings: open via the Replay MCP, get the shape of the session (timeline, interactions,
network, console). For event logs: replay the cited dump and check the digest matches the
claimed one — a builder citing a stale log fails immediately. Cheap sweeps first: uncaught
exceptions anywhere in the recording, any test `.skip`ped or `.todo`d in the diff, any
lint rule disabled inline, any golden "blessed" without a stated reason?

**PREDICT, THEN VERIFY.** For each acceptance criterion, write a falsifiable prediction
about concrete program state at a specific point **before** inspecting that state. A
prediction made after looking is a caption, not a check. Then verify with the narrowest
tool that can falsify it, routing by layer:

- Claim about stream/state behavior → replay the cited event log yourself, compare state
  digests, digest-bisect any divergence to the exact offset.
- Claim about sync convergence → drive two independent clients yourself, diff their
  reduced state canonically (exact), never eyeball two UIs.
- Claim about browser behavior → the Replay recording: evaluate at points, read console
  and network around the claimed moment, confirm the claimed offsets/digests exist **in**
  the recording, pull fetched bundles from network events and match hashes against the
  claim.
- Claim about performance → the benchmark harness's numbers against the task's stated
  budget and the committed baseline. Never eyeballs.

**Every finding cites a point.** Replay point link, event-log offset + digest, golden
path, or diff hunk. "The sync is flaky" is an opinion; "client B's state digest diverges
at offset 0000000000000000_0000000000004821, bisect log attached, point link into the
session" is evidence anyone can jump to.

**COVERAGE.** Hold the recording against the diff. For each changed hunk: did it execute
during the recorded run? Classify every unexecuted hunk: **needs-evidence** (behavior the
task mentions — name the exact run the builder must record), **dead** (demand deletion),
or **waived** (types, config, logging — one line of reasoning each). The diff isn't proven
until every changed line is executed, waived, or gone.

**MOCK & ENV HUNT.** Find every fixture the recorded run depended on: golden values
computed by the code under test at test time (self-licking test — goldens must be frozen
committed artifacts), magic constants, seeded RNG defaults, `NODE_ENV`-conditional
behavior leaking semantics, environment the run inherited, a stream server left warm from
development. Cold-clone rule: acceptance commands must pass from a pristine clone in a
scratch dir with scrubbed env (`NODE_OPTIONS`, `NODE_ENV`, `npm_config_*` unset) —
`tools/verify/cold_clone.sh` does this. "Works on the builder's machine" is a refutation,
not an excuse.

**RUN THE TASK'S OWN ATTACKS.** Execute every angle in the task's Adversarial verification
section — with your own seeds and inputs, never the builder's — and invent at least one
attack the section doesn't list. Fuzz where the task touches parsing, offsets, or merge
logic: malformed events, out-of-order appends, concurrent writers, truncated streams.
Sabotage-check the tests once per task: break the implementation in a scratch worktree and
confirm the builder's tests actually go red. A sensitivity proof is non-negotiable
wherever a measuring apparatus is claimed: mutate one byte of the input and the apparatus
must go red, or the apparatus itself is refuted.

**SUITE (only if correctness + coverage hold).** Judge what survives as a permanent
artifact — this is the duty that compounds:

- **Deterministic test** — exact assertions on stable behavior → committed unit/
  integration test asserting what _you_ verified, not what the builder printed.
- **Golden artifact** — the verified event log, state digest, or fixture checked in as a
  regression fixture (in the task's `evidence/` or the shared corpus).
- **Fuzz corpus entry** — inputs that reached interesting states → committed seeds.
- **Verify target** — recurring acceptance commands → a `make verify-*` recipe.
- Or **discard**, with one line of why.

**NO-FIRE LIST.** Do not raise: style nits, performance without a stated budget,
pre-existing warnings, requirements the task doesn't state, or anything you can't anchor
to a point link, a digest, a log offset, or a diff line. Re-check every finding once
before raising it.

**VERDICT.** First line: `VERDICT: verified | refuted | needs-evidence`. Then one bullet
per finding: prediction, observed value, citation, one-sentence demand. Append the entry
to the task's Verification log, flip `status` (`verified`, or back to `in-progress` with
the report as the builder's new context), rebuild the queue, commit.

Example log entry:

```
### 2026-07-10 — critic — VERDICT: refuted
- P2 branch-fork state parity — FAILED. Predicted fork digest 4f21… equal to main
  digest at fork offset; observed a01c… — digest bisect pins divergence at offset
  …0000512 (fork copies metadata but drops the pending patch event). Event log
  evidence/e1-t04-final.jsonl:512; recording
  https://app.replay.io/recording/9f2e…?point=8241…&time=41250. Fix, re-record.
- COVERAGE conflict-path — INSUFFICIENT. packages/streamfs/src/merge.ts:88-104
  (this diff) never executed in the recorded run. Record a run merging a branch with
  a conflicting write, or delete.
- SUITE: n/a until refutations clear.
Commands: ef replay evidence/e1-t04-final.jsonl --digest; pnpm test --filter streamfs merge
```

## Workflows

The doctrine above is runnable. `.claude/workflows/` ships:

- **implement-task** — the builder protocol end-to-end: pick from the queue, implement
  through the gates, independent fresh-session gate audits, record evidence, write the
  claim. `args {task: "E0-T03"}` targets a specific task; `{rework: true}` after a
  refutation.
- **verify-task** — the critic charter as a multi-agent attack: orient, then parallel
  critics (falsification per criterion, coverage, mock/env hunt, sabotage in a disposable
  worktree, the task's own attack list, Replay interrogation via `replay-critic`), each
  finding cross-examined by a skeptic before a judge issues the verdict and promotes suite
  artifacts.
- **work-queue** — the full gauntlet looped: implement → verify → rework until verified,
  advancing the queue. After failed runs 3, 6, and 9 it gives the complete latest
  three-run window to a fresh progress critic; only a cited `progressing` assessment
  earns another window, and run 10 is the absolute autonomous ceiling. After the
  committed `invalid_loop` stop, only an explicit human approval may durably raise a
  task's `verification_run_ceiling` to at most three runs beyond the recorded stop without
  resetting history. A completed checkpoint is preserved exactly; a ceiling-exhaustion
  stop does not fabricate a second or contradictory audit for the same three-run window.
  If the measuring apparatus itself prevents that lifecycle write, an
  explicitly authorized control-only bridge may change only the frozen recovery-control
  path set while project/task/ledger state remains stopped; the following lifecycle commit
  must be its direct child. The next divisible-by-three checkpoint still requires a fresh
  progress critic, and exhausting that ceiling stops again before another builder call.
  The two ledger readers run
  the attester and parser from the trusted pre-write commit, not the warm worktree or the
  commit under inspection; every writer transition must preserve the complete prior
  verdict/audit digest chain and control-source digest, satisfy its exact role-specific
  changed-path policy, and use the same visible Markdown token stream for headings,
  verdict evidence, all audit fields, catalog extraction, and readback. The control root
  includes both charters, child workflows, queue builder, attester/parser, and permanent
  sensor. Progress evidence must be selected from the attested commit's catalog with a
  concrete verifier and committed target; command text and free-floating digest syntax
  are not resolved evidence. This IS `.eforest/loop.md` running; it must honor the project
  states (halt and independently attest `invalid_loop` rather than push a task through
  dishonestly).
- **plan-epic** — decompose a roadmap epic into task folders (proposals → judge → authors
  → hostile spec review). `args {epic: 3}`.
- **replay-triage** — production feedback: interrogate production/dogfood Replay
  recordings, cluster defects, file evidence-backed bug tasks into the queue.
- **golden-sweep** — re-earn every standing verification (goldens, replay determinism,
  convergence fixtures, promoted tests, fuzz smoke, cold-clone) with independent
  reproduction of any failure.
- **roadmap-audit** — catch the board lying: queue vs task readmes, statuses vs
  Verification logs, the app vs verified reality, doctrine references vs the actual tree.

## The gauntlet

```
builder edits code
      │
      ▼
format + lint                seconds  · deterministic
      │
      ▼
typecheck                    seconds  · deterministic
      │
      ▼
tests                        minutes  · deterministic
      │
      ▼
build                        minutes  · deterministic
      │
      ▼
self-validation              minutes  · builder drives its own runs until satisfied
      │                                 (all of it inside the task folder's work/)
      ▼
recorded final run           minutes  · event log + state digests (always)
      │                                 + Replay recording (browser-impacting)
      ▼
adversarial verification     minutes  · fresh session falsifies the recording,
      │                                 audits the diff, promotes tests
      ▼
verified → build_queue.py → commit → next task
```

A failure at ANY stage returns the builder to the top, with the failure report as new
context. Failure means starting over, not patching in place — a fix applied mid-pipeline
never re-earned the earlier gates. And every verified task deposits promoted tests, golden
artifacts, and fuzz seeds into the cheap gates at the front, so the pipeline gets stricter
every time it runs. That's the compounding the whole system is built for.

## Production is the same loop

Production sessions are recorded with the same Replay tooling, so a production bug arrives
as — or is reproduced into — a recording whose ID enters the same citation pipeline.
`replay-triage` turns recordings into bug tasks whose repro is the extracted event log
replayed to a digest; the fix is done only when a hostile fresh session fails to refute
the claim against a **new** recording of the same steps, and the replayed log joins the
regression corpus. And once Epic 6 lands, this whole loop is a **product feature**: any
project hosted on electric-forest runs the same builder/critic gauntlet out of its own
`.eforest/` directory, statuses streaming live to everyone watching the branch.

## Platform quick-reference

- **Replay records on macOS** — this Mac can produce full two-layer evidence. Run
  `tools/replay/preflight.sh` once per machine: it gates on static capability checks
  (CLI, auth, runtime, MCP handshake), and `--full` adds a real record → upload
  round-trip. Details in `tools/replay/README.md`.
- Stream-layer evidence (event logs, digests, convergence fixtures) runs everywhere,
  including CI, and is the fallback currency wherever Replay tooling is absent — declared
  loudly: `SKIPPED: <reason>` and a nonzero exit unless `VERIFY_ALLOW_SKIP=1`.
- Runtime boundary: ElectricSQL's published `@durable-streams/client` and
  `@durable-streams/server` packages define transport behavior locally; Electric Cloud
  defines it in deployment. `@eforest/streamfs`, reducers, validation, digests, and
  merge semantics are application layers above that boundary. This repository never
  implements another Durable Streams transport. If `blamy/emulate` adds Durable Streams
  support, it wraps the published reference server without a fork. Full rationale and
  current limits are in `ARCHITECTURE.md`.
