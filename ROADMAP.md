# The Road to the Mirror — electric-forest roadmap

electric-forest is a GitHub clone with the version control ripped out and replaced:
**durable streams instead of git**. A project's main branch is an append-only stream;
branches are streams forked from it; files live on stream-fs; every change to a branch
syncs live to every user of that branch — an AI's edits appear as they happen, not as a
commit afterward. And every project carries a `.eforest/` directory that stores not the
history of file changes but the **future**: the task queue, the builder/critic loop, and
the evidence of what has been proven. Projects are `building`, `complete`, `paused`, or
`invalid_loop` — a repo here is a process, not an archive.

## Prior art (studied, not vendored)

- **ElectricSQL durable-streams** (`replayio/durable-streams`) — the open HTTP protocol
  (PUT create / POST append / GET with `offset` + `live=long-poll|sse`, opaque
  lexicographic offsets, `Stream-Seq` writer fencing, CDN-cacheable reads) and the
  "server-side redux" layer: actions appended as `{type, payload, ts}` events, state =
  `events.reduce(reducer, initialState)`, server-side `/state` `/events` `/dispatch` with
  offset-keyed state caching, build-time reducer extraction, redux-devtools time travel.
  We rebuild this core ourselves in Epic 0, wire dispatch-side validation in (the
  reference leaves it unwired), and freeze protocol compatibility with the v1.0 draft.
- **stream-fs** (electric.ax) — filesystem semantics on streams: a metadata stream plus
  per-file content streams, chokidar-compatible `watch()`, stale-write detection, text
  patches. Epic 1 builds our own with the two things it lacks: branching and snapshots.
- **Nut / react-devtools-as-a-tool** — the live change-feed pattern (registry stream,
  long-poll tailing, streams debugger panel) and the gap we close: its AI edits never
  actually flow into the stream. Ours do — that's the whole point.
- **wasm-vm and the figma-clone** — the doctrine donors: task queue, adversarial
  builder/critic loop, two evidence layers, greenwash-proof verify spine. See `AGENTS.md`.

## The three irreversible architectural bets

1. **One mutation door.** The only way to change stream-backed state is appending an
   event through dispatch. State is `replay(events)` from offset `-1`, always. This makes
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

## Evidence doctrine (cross-cutting)

Every epic's tasks are provable under the two-layer evidence system in `AGENTS.md`:
stream-layer (event logs, state digests, replay determinism, convergence diffs) and
browser-layer (Replay recordings interrogated through the Replay MCP). The verify spine
(`Makefile` verify section, `tools/verify/`, greenwash scanner) lands in Epic 0 and gets
stricter with every verified task.

## The milestone ladder

| Epic | Name | Runnable milestone (capstone demo) |
|---|---|---|
| E0 | the-seed | **two-terminals-one-log** — cold clone; terminal A dispatches actions, terminal B live-tails and replays to an identical state digest |
| E1 | the-trunk | **the-first-repo** — create a repo backed by stream-fs, write files, fork a branch at an offset, watch both branches live |
| E2 | the-gates | **the-locked-gate** — log in with Auth0 (Playwright-emulated), get a session + CLI token; unauthorized stream ops are refused |
| E3 | the-canopy | **the-reading-room** — browse repos, trees, and files in the web app; a second session's edit appears live without reload |
| E4 | the-roots | **two-machines-one-branch** — `ef init` + watcher sync; two working directories converge through the branch stream, live |
| E5 | the-loop | **the-loop-runs** — a hosted project's builder/critic loop executes a task end-to-end; statuses stream live to the project page |
| E6 | the-fireflies | **watch-the-ai-build** — an AI edit session streams keystroke-granular changes to viewers, with time-travel scrubbing |
| E7 | the-mirror | **the-forest-builds-the-forest** — electric-forest hosts its own source; a task on itself reaches `verified` entirely through the platform, no git |

## The scale

### Epic 0 — the-seed (protocol core + verify spine)

The pnpm workspace, the verification spine (Makefile verify section, cold-clone,
self-check, replay preflight), and our own durable-streams implementation: server
(in-memory + file-backed stores, long-poll + SSE live modes, offset semantics per the
v1.0 draft), client + writer (batching, resumable reads), and the server-side redux
engine — reducer registry, `/state` `/events` `/dispatch` with **server-validated
dispatch wired in from day one**, state caching keyed by offset, and the `ef replay` /
`ef bisect` evidence tools (replay a dumped event log to a canonical state digest;
binary-search the first divergent offset). Conformance tests double as the protocol's
frozen contract.

**Capstone — two-terminals-one-log:** from a cold clone, process A creates a stream and
dispatches a scripted action sequence; process B tails live (long-poll) and replays; both
print the same state digest; kill B mid-stream, restart from its saved offset, digests
still match. All from `make verify-E0-*` targets.

### Epic 1 — the-trunk (stream-fs, snapshots, branches)

Filesystem semantics on streams: metadata stream + per-file content streams, directory
ops, `watch()` with chokidar-compatible events, text patches for bandwidth, stale-write
fencing. Then the two capabilities the reference lacks, which make it a VCS: **snapshots**
(offset-anchored compaction points so long-lived repos don't replay from zero; `410 Gone`
retention semantics) and **branch streams** (fork at offset with copy-on-write metadata,
log-aware merge: fast-forward, three-way on patches, conflict surfacing as events).

**Capstone — the-first-repo:** create a repo, write a small source tree through
stream-fs, fork `feature` from `main` at an offset, edit both sides, watch both live from
second clients, merge fast-forward, and digest-verify that `replay(main)` equals the
merged tree.

### Epic 2 — the-gates (platform server, Auth0, tenancy)

The platform: users, orgs, projects, repos as stream namespaces; Auth0 login (web) and
device/token flow (CLI); per-stream authorization (read/write per branch, public/private
repos, `Stream-Seq` fencing scoped per writer identity); the `__registry__` pattern
promoted into a real project index; rate limits and tenant isolation.

**Capstone — the-locked-gate:** Playwright drives an emulated Auth0 login end-to-end,
lands authenticated, mints a CLI token, and performs an authorized append; the same
append without the token is refused with the right status — both shown in one Replay
recording.

### Epic 3 — the-canopy (the web app: browse)

The React app on our own server-side redux hooks (`useServerReducer`-style, hydration
offsets, live tail): repo list, repo home, file tree, file viewer with patch-aware
rendering, branch switcher, project status badge (`building` / `complete` / `paused` /
`invalid_loop`), commit-less history view (the event log, humanized).

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

### Epic 5 — the-loop (.eforest as product)

The `.eforest` directory becomes a platform feature: the task-folder format (readme +
work/ + evidence/) parsed and rendered; project states enforced by the server; the
builder and critic as runnable platform agents operating on branch streams (builder works
a task on a task branch, critic attacks it, verdicts append to the task's stream);
retry-budget and thrash detection flipping projects to `invalid_loop`; the live task
board.

**Capstone — the-loop-runs:** on a hosted sample project, kick the loop: a builder agent
implements a queued task on a branch, records evidence, a critic agent refutes it once
(real finding), the rework passes, the verdict lands `verified` — every status flip
streaming live to the project page while it happens.

### Epic 6 — the-fireflies (the live AI feed + time travel)

The Nut gap, closed: AI/agent edit sessions dispatch fine-grained change events (file
patches, tool invocations, task-folder activity) onto the branch stream as they happen;
viewers see the forest light up — a live session feed, per-file change streaming into
the open viewer, and **time-travel scrubbing**: drag back through any branch's event log
and watch the tree reconstruct at every offset (the redux-devtools move, on the whole
repo).

**Capstone — watch-the-ai-build:** an AI session edits a hosted repo; two independent
browsers watch the same branch and see edits within a second of each other; scrubbing to
any past offset shows the exact tree at that offset, digest-verified against `ef replay`.

### Epic 7 — the-mirror (self-hosting)

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
