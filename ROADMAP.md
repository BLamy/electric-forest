# The Road to the Mirror — electric-forest roadmap

electric-forest is a GitHub clone with the version control ripped out and replaced:
**durable streams instead of git**. A project's main branch is an append-only stream;
branches are streams forked from it; files live on stream-fs; every change to a branch
syncs live to every user of that branch — an AI's edits appear as they happen, not as a
commit afterward. Everything GitHub keeps in Postgres — issues, wiki, pull requests,
users, orgs — lives on the same streams as the code, under one unifying model; the only
external service is Auth0, and it only answers "who is this?". And every project carries
a `.eforest/` directory that stores not the history of file changes but the **future**:
the task queue, the builder/critic loop, and the evidence of what has been proven —
including rr traces and Replay browser runs, attached to their entities and visible in
the UI. Projects are `building`, `complete`, `paused`, or `invalid_loop` — a repo here
is a process, not an archive.

## Upstream foundations and doctrine donors

- **ElectricSQL durable-streams** — the runtime substrate, consumed through the
  published `@durable-streams/client` and `@durable-streams/server` packages and Electric
  Cloud. Electric owns PUT/POST/GET semantics, opaque transport offsets, `Stream-Seq`,
  resumable live reads, persistence, and native forks. electric-forest does not fork or
  reimplement that transport. See `ARCHITECTURE.md`.
- **StreamFS design** — metadata streams plus per-file content streams,
  chokidar-compatible `watch()`, stale-write detection, and text patches. No published
  StreamFS package is currently available in the Durable Streams release we consume, so
  `@eforest/streamfs` owns this application layer while storing every item in official
  Durable Streams. Branching, snapshots, merges, and digests remain electric-forest
  domain behavior.
- **Nut / react-devtools-as-a-tool** — the live change-feed pattern (registry stream,
  long-poll tailing, streams debugger panel) and the gap we close: its AI edits never
  actually flow into the stream. Ours do — that's the whole point.
- **wasm-vm and the figma-clone** — the doctrine donors: task queue, adversarial
  builder/critic loop, two evidence layers, greenwash-proof verify spine. See `AGENTS.md`.

## The four irreversible architectural bets

1. **One mutation door.** The only way to change platform state is submitting an event
   through electric-forest's authenticated dispatch service; accepted events are
   appended to Electric Cloud through the official client. Trusted library tests may
   append directly, but no product authorization decision lives in the transport.
   State is `replay(events)` from offset `-1`, always. This makes
   every session a trace, every bug a replayable offset, and time travel a product
   feature rather than a debugger trick.
2. **Branches are forks of the log, not copies of the tree.** A branch stream records
   `(parent, forkOffset)` and copy-on-write metadata. Merge is log-aware (replay both
   sides from the fork point), history is O(events), and "who changed what when" is a
   digest bisect, not archaeology.
3. **`.eforest` is data on the same streams as the code.** The task queue, project
   status, loop definition, and evidence ride the project's own streams, so the build
   process is as observable, forkable, and replayable as the source tree. The loop that
   builds a project is a first-class object users watch live.
4. **No database. The streams are the database.** There is no Postgres, no relational
   store, no side table anywhere in the system. Auth0 is the only external service, and
   it only answers "who is this?" — everything Auth0 doesn't own (users' platform
   records, orgs, projects, permissions, sessions-as-events) lives on streams like
   everything else. Anything that looks like a query index (repo lists, issue boards,
   search) is a **derived stream or reducer-materialized view**, rebuildable from the
   logs by replay; losing every index loses nothing. If a feature seems to need a
   database, the feature is misdesigned.

## One model to hold them all

Every noun on the platform — file, directory, branch, repo, issue, wiki page, pull
request, task, comment, project status, rr trace, Replay browser run — is the **same
thing**: an entity defined by `(stream, reducer)`, whose state is `replay(events)` and
whose history and future are both just offsets. Concretely:

- **Files/dirs** — stream-fs: a metadata stream + per-file content streams.
- **Issues** — an event stream per issue (`opened`, `commented`, `labeled`,
  `state-changed`, `closed`); the issue's workflow state (`open` / `in-progress` /
  `done` / `closed` / `wont-do`) is reduced state, and the issue board is a derived
  stream over the repo's issues.
- **Wiki** — stream-fs pages on a dedicated wiki branch; edits are patches like any file.
- **Pull requests** — a merge proposal is an event stream referencing
  `(sourceBranch, targetBranch, forkOffset)`; review comments, approvals, CI/loop
  verdicts, and the merge itself are events on it. A merged PR is not a row — it is a
  replayable negotiation ending in a merge event on the target stream.
- **Tasks (.eforest)** — an issue with evidence: same state machine plus builder/critic
  events (`claimed`, `refuted`, `verified`) and attachment events.
- **Evidence** — rr traces, Replay browser-run references, event-log dumps, and digests
  are content streams (or external URLs recorded by reference events) attached to the
  entity that earned them; they render in the UI wherever their entity does.
- **Identity** — Auth0 authenticates; the resulting platform user record, org
  memberships, and grants are events on identity streams, reduced to an authorization
  view the servers enforce.

One dispatch door, one replay path, one subscription mechanism, one time-travel story —
for source code and issues and PRs and the build loop alike. The GitHub clone is one
model wearing nine UIs.

## Evidence doctrine (cross-cutting)

Every epic's tasks are provable under the two-layer evidence system in `AGENTS.md`:
stream-layer (event logs, state digests, replay determinism, convergence diffs) and
browser-layer (Replay recordings interrogated through the Replay MCP). The verify spine
(`Makefile` verify section, `tools/verify/`, greenwash scanner) lands in Epic 0 and gets
stricter with every verified task.

## The milestone ladder

| Epic | Name          | Runnable milestone (capstone demo)                                                                                                                 |
| ---- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0   | the-seed      | **two-terminals-one-log** — cold clone; terminal A dispatches actions, terminal B live-tails and replays to an identical state digest              |
| E1   | the-trunk     | **the-first-repo** — create a repo backed by stream-fs, write files, fork a branch at an offset, watch both branches live                          |
| E2   | the-gates     | **the-locked-gate** — log in with Auth0 (Playwright-emulated), get a session + CLI token; unauthorized stream ops are refused                      |
| E3   | the-canopy    | **the-reading-room** — browse repos, trees, and files in the web app; a second session's edit appears live without reload                          |
| E4   | the-roots     | **two-machines-one-branch** — `ef init` + watcher sync; two working directories converge through the branch stream, live                           |
| E5   | the-meadow    | **issue-to-merge** — file an issue, branch, open a PR, merge; the issue flips to done — all live, all events, no database anywhere                 |
| E6   | the-loop      | **the-loop-runs** — a hosted project's builder/critic loop executes a task end-to-end; statuses stream live to the project page                    |
| E7   | the-fireflies | **watch-the-ai-build** — an AI edit session streams keystroke-granular changes to viewers, with time-travel scrubbing                              |
| E8   | the-mirror    | **the-forest-builds-the-forest** — electric-forest hosts its own source; a task on itself reaches `verified` entirely through the platform, no git |

## The scale

### Epic 0 — the-seed (official substrate + verify spine)

The pnpm workspace, verification spine, deterministic application-event envelope,
reducer/digest tools, and official Durable Streams adapters. Local and CI runs use
Electric's published reference server; deployments use Electric Cloud. `ef replay` and
`ef bisect` remain product-owned because they operate on electric-forest application
events and canonical state digests, not on the transport protocol.

**Capstone — two-terminals-one-log:** from a cold clone, process A creates a stream and
dispatches a scripted action sequence; process B tails live (long-poll) and replays; both
print the same state digest; kill B mid-stream, restart from its saved offset, digests
still match. All from `make verify-E0-*` targets.

### Epic 1 — the-trunk (stream-fs, snapshots, branches)

Filesystem semantics on official Durable Streams: metadata stream + per-file content streams, directory
ops, `watch()` with chokidar-compatible events, text patches for bandwidth, stale-write
fencing. Application snapshots are append-only checkpoints; physical retention remains
the transport provider's concern. **Branch streams** use Electric's native head-fork
protocol with copy-on-write metadata and continue one application offset space across
the inherited prefix. Historic forks require the explicit offset-map task described in
`ARCHITECTURE.md`. Log-aware merge remains application behavior: fast-forward,
three-way on patches, and conflict surfacing as events.

**Capstone — the-first-repo:** create a repo, write a small source tree through
stream-fs, fork `feature` from `main` at an offset, edit both sides, watch both live from
second clients, merge fast-forward, and digest-verify that `replay(main)` equals the
merged tree.

### Epic 2 — the-gates (platform server, Auth0, tenancy)

The platform: users, orgs, projects, repos as stream namespaces; Auth0 login (web) and
device/token flow (CLI) — **Auth0 is the sole identity provider and the only external
service; there is no database** (bet 4). Platform records (user profiles keyed by Auth0
subject, orgs, memberships, grants) are events on identity streams reduced to an
authorization view; per-stream authorization (read/write per branch, public/private
repos, `Stream-Seq` fencing scoped per writer identity); the `__registry__` pattern
promoted into a real project index as a derived stream; rate limits and tenant
isolation.

**Capstone — the-locked-gate:** Playwright drives an emulated Auth0 login end-to-end,
lands authenticated, mints a CLI token, and performs an authorized append; the same
append without the token is refused with the right status — both shown in one Replay
recording.

### Epic 3 — the-canopy (the web app: browse)

The React app uses `useStreamReducer` to bootstrap and follow authorized application
events through the platform gateway while the gateway reads Electric through the
official client. Shared reducers run in the browser and in `ef replay`; there is no
server-materialized state endpoint or second transport. The surfaces are repo list,
repo home, file tree, patch-aware file viewer, branch switcher, project status badge
(`building` / `complete` / `paused` / `invalid_loop`), and commit-less history.

**Capstone — the-reading-room:** browse org → repo → tree → file; a second session edits
the file through stream-fs and the open viewer updates live, no reload; DOM exposes the
stream offset it has replayed to and it matches the server's head.

### Epic 4 — the-roots (the CLI + local sync)

`ef` — the git-shaped CLI without git: `ef init` (adopt a local directory, create the
project + main stream), `ef clone`, `ef branch` / `ef checkout` (materialize a branch
stream into the working tree), `ef status`, and the **watcher**: a daemon that syncs
local file changes up to the branch stream and stream changes down to the working tree,
both directions live, with offline catch-up from the saved offset and conflict surfacing
(the stream is the arbiter; local losers are preserved as conflict files).

**Capstone — two-machines-one-branch:** two separate working directories (simulating two
machines) both run watchers on the same branch; edits on either side appear on the other
within seconds; a partitioned (stopped) watcher catches up cleanly on restart; final
trees are byte-identical and match `replay(branch)`.

### Epic 5 — the-meadow (issues, wiki, pull requests — collaboration on the one model)

The GitHub surface area, rebuilt as pure event streams (see "One model to hold them
all"): **issues** as per-issue event streams with a reduced workflow state (`open` /
`in-progress` / `done` / `closed` / `wont-do`), labels, comments, and a derived issue
board; **wiki** as stream-fs pages on a wiki branch with the same live sync as code;
**pull requests** as merge-proposal streams (review comments, approvals, verdicts, merge
event) targeting branch streams, with cross-linking events (a merge event can close an
issue) — and the evidence rule from AGENTS.md ("Pull requests carry evidence") made
mechanical: merging requires an evidence attachment or an explicit waiver event with a
justification, the platform's analog of required checks (E5-T06 merge gate, E5-T10
attachment/reference model); **evidence attachments** — rr traces, Replay browser-run references, event-log
dumps, digests — reported into the durable filesystem as content streams / reference
events on their owning entity, rendered in the UI wherever that entity appears. No task
here may introduce a database (bet 4); every list view names the derived stream or
reducer it reads.

**Capstone — issue-to-merge:** file an issue, flip it to `in-progress`, fork a branch,
fix, open a PR referencing the issue, review + approve, merge — the issue flips to
`done` via the merge's closing event, a second browser watches every step live, and the
whole negotiation replays offset-by-offset with `ef replay`. Postgres count: zero.

### Epic 6 — the-loop (.eforest as product)

The `.eforest` directory becomes a platform feature on the meadow's model — **a task is
an issue with evidence** (same state machine, plus builder/critic events `claimed` /
`refuted` / `verified`): the task-folder format (readme + work/ + evidence/) parsed and
rendered; project states enforced by the server; the builder and critic as runnable
platform agents operating on branch streams (builder works a task on a task branch,
critic attacks it, verdicts append to the task's stream); retry-budget and thrash
detection flipping projects to `invalid_loop`; the live task board; every piece of loop
evidence (rr traces, Replay runs, digests) attached and browsable in the UI.

**Capstone — the-loop-runs:** on a hosted sample project, kick the loop: a builder agent
implements a queued task on a branch, records evidence, a critic agent refutes it once
(real finding), the rework passes, the verdict lands `verified` — every status flip
streaming live to the project page while it happens, evidence links resolving in the UI.

### Epic 7 — the-fireflies (the live AI feed + time travel)

The Nut gap, closed: AI/agent edit sessions dispatch fine-grained change events (file
patches, tool invocations, task-folder activity) onto the branch stream as they happen;
viewers see the forest light up — a live session feed, per-file change streaming into
the open viewer, and **time-travel scrubbing**: drag back through any branch's event log
and watch the tree reconstruct at every offset (the redux-devtools move, on the whole
repo — and since issues/PRs/tasks are the same model, scrubbing rewinds them too).

**Capstone — watch-the-ai-build:** an AI session edits a hosted repo; two independent
browsers watch the same branch and see edits within a second of each other; scrubbing to
any past offset shows the exact tree at that offset, digest-verified against `ef replay`.

### Epic 8 — the-mirror (self-hosting)

The forest builds the forest: import this repository onto the platform (git → stream
importer, then the bridge retires), run its own `.eforest` loop as a hosted project, and
complete a real task on electric-forest through electric-forest — builder on a branch
stream, critic verdict, merge to main — with git nowhere in the path.

**Capstone — the-forest-builds-the-forest:** a production task on this repo reaches
`verified` entirely through the platform; the evidence chain (event logs, digests, Replay
recordings, verdict) is browsable on the platform itself.

## How to read the numbers

Task ids are `E{epic}-T{nn}`; priority = `epic × 100 + task number`; the queue at
`.eforest/tasks/QUEUE.md` is the single source of what's next. One capstone per epic,
last, gated on a cold-start demo. Fractional priorities are reserved for queue-jumping
bug/regression tasks with a stated reason.
