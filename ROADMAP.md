# Electric Forest — hosting first

## Execution order — human reprioritization, 2026-10-16

The next product milestone is a **public, multi-user Electric Forest deployment** in
the existing [Railway project](https://railway.com/project/e0864588-a320-4ba3-96df-95ad0a07ee81?environmentId=c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448).
Hosting the current app comes before replacing its storage or agent runtime. The first
release includes real login, onboarding, tenant isolation, live collaboration, bounded
public traffic, and demonstrated recovery. A private demo does not satisfy this scope.

| Order | Epic / priority | Outcome |
| --- | --- | --- |
| Existing checkpoint | E5-T15 and inherited E6-T12 | Reconcile the existing verification/lifecycle gates without rewriting their history |
| 1 | E12 — first-light / 521–529 | Run and launch the current web app and gateway on Railway with a qualified production stream provider |
| 2 | E13 — the-design / 531–533 | Audit the hosted journeys, decide navigation and terminology, and improve the core shell |
| 3 | E15 — durable-agents / 541–543 | Test Electric Sync and Electric Agents in isolation; independently decide adopt, decline, or conditional |
| 4 | E14 — the-changesets / 551–556 | Publish immutable full file versions through changesets; derive review diffs on demand |
| 5 | E6 → E7 | Build the durable builder/critic loop and live agent feed over the chosen contracts |
| 6 | E8 | Move this project's source and build process onto the hosted product |
| 7 | E9 → E10 → E11 | Expand into app tooling, isolated app history, and incident recovery |

Epic IDs are stable identities, not execution order. Explicit integer priorities and
dependencies encode this human-authorized reorder. The existing E9–E11 proposal remains
in the backlog; its general application platform is later work. E11's future deployment
provenance feature is distinct from deploying Electric Forest now in E12.

The 2026-10-16 inventory found E5-T15 `implemented` and E6-T12 `in-progress`, although
E6-T12's prerequisites remain pending. That violates the one-task-at-a-time invariant.
This planning edit preserves both records, their findings, run counters, and all
verified/cancelled task bytes. Before any builder runs, the existing lifecycle must
reconcile those gates and obtain the required independent committed readbacks. This
plan grants no new verification runs and does not resolve either task by declaration.

Detailed topology, architectural recommendations, migration rules, and source references:
[hosting and changesets plan](docs/plans/hosting-and-changesets.md). The generated
[queue](.eforest/tasks/QUEUE.md) remains the executable task inventory.

## Product direction

electric-forest starts as a GitHub clone with the version control ripped out and replaced:
**durable streams instead of git**. It is growing into a platform for building and
operating replayable applications, with the GitHub-style code host as its first app. A
project's main branch is an append-only stream;
branches are streams forked from it; files live on stream-fs; every change to a branch
syncs live to every user of that branch — an AI's edits appear as they happen, not as a
commit afterward. In the code-host app, the records GitHub keeps in Postgres — issues,
wiki, pull requests, users, orgs — live on the same streams as the code, under one
unifying model. Auth0 authenticates the platform identity; other apps may declare
separate providers and capabilities without changing the platform's own stream authority.
And every project carries a `.eforest/` directory that stores not the history of file
changes but the **future**:
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

## Current architectural boundaries

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
4. **Current authority: streams.** There is no Postgres, no relational
   store, no side table anywhere in the system. Auth0 is the only external service, and
   it only answers "who is this?" — everything Auth0 doesn't own (users' platform
   records, orgs, projects, permissions, sessions-as-events) lives on streams like
   everything else. Anything that looks like a query index (repo lists, issue boards,
   search) is a **derived stream or reducer-materialized view**, rebuildable from the
   logs by replay; losing every index loses nothing. If a feature seems to need a
   database, it needs an explicit architecture decision before adoption. The existing
   Railway starter services are infrastructure already present, not new authorities for
   Electric Forest. E15 may evaluate Postgres-backed Electric components in an isolated
   fixture; a successful experiment does not authorize a production migration or amend
   the standing no-database core contract.

The prospective source model after E14 is **changesets plus immutable full file
versions**. Each accepted changeset names its parents, changed file identities/paths,
complete content hashes, and run/task/evidence provenance. New bytes receive a new
content address; identical bytes reuse their address. Renames and mode changes update
version metadata. Textual comparisons are computed from the referenced versions and
discarded; redacted agent tool logs may retain patch text. New branch, content, review,
and changeset records do not store patch bodies. Legacy patches and verified evidence
remain readable and unchanged through an explicit append-only migration boundary.

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
- **Wiki** — stream-fs pages on a dedicated wiki branch; current legacy edits use patches,
  and E14 moves new edits to complete immutable versions linked to changesets.
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
| E5   | the-meadow    | **the-polished-meadow** — complete issue-to-merge inside the finished code host: Docstream markdown, Pierre diffs, Trees browsing, all live        |
| E12  | first-light   | **public-forest** — the existing app runs publicly on Railway; independent tenants collaborate live and survive redeploy/restore |
| E13  | the-design    | **a-legible-forest** — accessible, responsive navigation through the real hosted workflows |
| E15  | durable-agents | **an-evidence-backed-choice** — pinned Electric Sync/Agents pilots earn an independent adopt, decline, or conditional decision |
| E14  | the-changesets | **versions-without-patches** — migrate a legacy repo, publish full content-addressed versions, review and merge changesets, and recover exactly |
| E6   | the-loop      | **the-loop-runs** — a hosted project's builder/critic loop executes a task end-to-end; statuses stream live to the project page                    |
| E7   | the-fireflies | **watch-the-ai-build** — live agent activity and bounded saved file versions, with exact historical scrubbing |
| E8   | the-mirror    | **the-forest-builds-the-forest** — electric-forest hosts its own source; a task on itself reaches `verified` entirely through the platform, no git |
| E9   | the-toolbox   | **the-first-platform-app** — a starter app uses the shared app contract, TanStack DB collections, a Durable Streams provider, and optional runtime entrypoints |
| E10  | the-time-machine | **ticket-to-verified-app** — a ticket creates an isolated application fork, a recorded acceptance run is independently judged, and its evidence gates a PR |
| E11  | the-wildwood  | **incident-to-replay** — restore and compare application forks, promote verified builds, and turn a production incident into a replayable task |

## Building apps on electric-forest

Every hosted app has a versioned app manifest that names its source branch and offset,
build, runtime profile, state schema, allowed capabilities, and UI entrypoints. Apps use
small core imports plus explicit subpath imports for optional features: for example,
`@brett_lamy/ui` stays a small browser-safe entrypoint while modules such as
`@brett_lamy/ui/ffmpeg`, `@brett_lamy/ui/docstream`, and the Electron surface are loaded
only by apps that opt in. Docstream runtime/core stays headless. Docstream visual
components may depend on a leaf UI primitives entrypoint, while the aggregate
`@brett_lamy/ui/docstream` entrypoint may compose those components; neither the primitives
entrypoint nor Docstream core may import back through that aggregate entrypoint. This
keeps the module graph acyclic and lets bundlers exclude unused runtimes and integrations.
The `@brett_lamy/ui` source package remains owned by its own repository; electric-forest
owns the app contract and consumer conformance fixtures rather than vendoring a second UI
library.

TanStack DB is the preferred client-side collection and live-query model for app data and
component state. It is a client materialization/query layer, not the authority for hosted
application state. For electric-forest apps, accepted writes still pass through the
authenticated dispatch service and become application events on Durable Streams. The
platform should expose collections over those reducers and use the published
`@durable-streams/state/db` / StreamDB integration where its State protocol fits. A
separate ElectricSQL collection adapter may serve apps whose chosen source of truth is
Postgres; it must keep writes behind that app's validated server API. This opt-in does not
move electric-forest's own code-host, issue, task, identity, or audit state out of streams.
Electric Ax/Streams
integrations are provider options to qualify against their published contracts, never a
reason to fork the Durable Streams transport or bypass authorization. TanStack DB is
currently documented as beta, so provider packages and APIs must be pinned and checked
at implementation time.

Runtime and capability entrypoints cover browser apps, Electron apps, and Almostnode
services. Optional integrations such as Docstream, FFmpeg, Tailscale, and the passkey
vault remain separate capabilities behind explicit imports. A component binds to typed
collections and app actions; it does not assume a particular server, transport, or
runtime. Initial reference links: [TanStack DB](https://tanstack.com/db/latest/docs/overview),
[Durable Streams StreamDB](https://durablestreams.com/stream-db),
[TanStack Electric collection](https://tanstack.com/db/latest/docs/collections/electric-collection),
and [Electric Streams](https://electric.ax/docs/streams/).

## Forkable application history

The whitepaper extends the same stream-and-evidence model from source code to the app
while it runs. An application fork is a manifest-backed, isolated execution environment
that binds a source branch and build to authoritative backend stream offsets, a state
schema/version, browser session state, and declared external capabilities. A fork must be
reproducible enough to compare runs and safe enough to keep sibling runs isolated.

Browser recordings such as rrweb are interaction evidence, not the source of truth.
Acceptance evidence binds the recording to the fork manifest, test/build identity,
authoritative event offsets, and reduced-state digests. The first end-to-end milestone is
`ticket → isolated application fork → recorded acceptance run → independent verdict → PR
check`. Follow-up work restores forks, proves sibling isolation, compares runs across
build epochs, and carries provenance into deployment monitoring and incident replay.
Any use of these records as model-training data remains a separate, speculative research
decision with privacy, consent, and data-minimization gates; it is not a platform success
criterion.

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

**Capstone — the-polished-meadow:** retain the full issue-to-merge negotiation — file an
issue, fork, fix, open/review/approve/merge a PR, and flip the issue to `done` live —
inside the finished product shell. All Markdown surfaces use Docstream, all change views
use Pierre Diffs, all repository trees use Pierre Trees, and the supplied visual
references define the final hierarchy and finish. A second browser watches every step
live and the whole negotiation replays offset-by-offset with `ef replay`. Postgres count:
zero.

### Epic 12 — first-light (public multi-user Railway launch)

Deploy the existing web app and authenticated gateway into the existing Railway
project. Qualify the production Durable Streams provider, package an immutable release,
fix canonical HTTPS origins and secure sessions, and put a working candidate online
early. Complete public onboarding, tenant isolation, bounded concurrent traffic,
backup/restore, runtime health and release identity before launch. The starter's
Postgres/shape services remain separate from Forest's authority.

**Capstone — public-forest:** independent users sign up, create organizations and
repositories, invite a collaborator, edit live, review/merge with evidence, and prove
private data is inaccessible to outsiders. Redeploy and restore into an isolated
destination within frozen objectives. Bind real deployed-origin proof and Replay QA
journeys/exploration to the exact tested build and independently replayed stream state.

### Epic 13 — the-design (make the hosted product legible)

Audit real public journeys with screenshots before redesigning. Specify a small
navigation/state contract, using the existing UI system and distinguishing changesets,
reviews, tasks, agent runs and evidence. Implement the core shell; E14 owns the new
changeset-specific screens when their backend exists.

**Capstone — a-legible-forest:** complete the hosted public workflows on desktop and a
narrow screen with keyboard controls, visible loading/error/reconnect states, zero
console errors, and exact DOM/replay parity through branch/account changes.

### Epic 15 — durable-agents (qualify Electric before building another runtime)

Pin current Electric Sync, Streams, StreamDB and Agents contracts. Compare no migration,
a rebuildable read projection, a runtime-only agent adapter, and full server adoption.
Run an isolated read-projection/agent durability pilot with duplicate wakeups, process
loss, revoked credentials and ambiguous external-effect acknowledgement. Inspect
Postgres/control-plane requirements and preserve the current stream authority.

**Capstone — an-evidence-backed-choice:** a fresh reviewer independently records adopt,
decline or conditional for each candidate, with reproducible evidence and exact
integration boundaries/follow-on tasks. An adopt result does not silently amend the
no-database rule or grant production migration authority.

### Epic 14 — the-changesets (immutable full versions, derived comparisons)

Freeze changeset/file-version/content-object schemas; store full byte-exact objects at
authorized immutable hash addresses; publish verified object references through one
fenced branch event. Update StreamFS, CLI sync, forks, merges, conflicts and reviews.
Agent logs may retain redacted edit deltas; source authority and reconstruction use
full versions. New durable artifacts do not persist textual diffs outside those logs.

**Capstone — versions-without-patches:** migrate forward from a frozen legacy tree,
preserve every old log/evidence byte, publish and review new multi-file/binary changesets,
merge, restart and restore. Both clients and independent replay agree on content and
tree digests with agent transcripts absent. Rebuilding indexes preserves all identities.

### Epic 6 — the-loop (.eforest as product)

After public hosting and the E13/E15/E14 contracts, the `.eforest` directory becomes a platform feature on the meadow's model — **a task is
an issue with evidence** (same state machine, plus builder/critic events `claimed` /
`refuted` / `verified`): the task-folder format (readme + work/ + evidence/) parsed and
rendered; project states enforced by the server; the builder and critic as runnable
platform agents operating on branch streams (builder works a task on a task branch,
critic attacks it, verdicts append to the task's stream); retry-budget and thrash
detection flipping projects to `invalid_loop`; the live task board; every piece of loop
evidence (rr traces, Replay runs, digests) attached and browsable in the UI. Claims and
verdicts reference changeset/version manifests and tested heads; critic comparisons are
computed from those versions. E15's chosen adapter boundary prevents a redundant runtime
rewrite and preserves fresh builder/critic sessions.

**Capstone — the-loop-runs:** on a hosted sample project, kick the loop: a builder agent
implements a queued task on a branch, records evidence, a critic agent refutes it once
(real finding), the rework passes, the verdict lands `verified` — every status flip
streaming live to the project page while it happens, evidence links resolving in the UI.

### Epic 7 — the-fireflies (the live AI feed + time travel)

The Nut gap, closed: AI/agent edit sessions record fine-grained tool/edit activity in
their run logs and publish complete immutable file versions in changesets at bounded
logical-save/checkpoint intervals;
viewers see the forest light up — a live session feed, per-file change streaming into
the open viewer, and **time-travel scrubbing**: drag back through any branch's event log
and watch the tree reconstruct at every offset (the redux-devtools move, on the whole
repo — and since issues/PRs/tasks are the same model, scrubbing rewinds them too).
The UI derives transient highlights between versions; agent deltas are not a second
source-history authority. Frozen latency and coalescing limits replace patch-per-token
requirements.

**Capstone — watch-the-ai-build:** an AI session edits a hosted repo; two independent
browsers watch the same branch and see edits within a second of each other; scrubbing to
any past offset shows the exact tree at that offset, digest-verified against `ef replay`.

### Epic 8 — the-mirror (self-hosting)

The forest builds the forest: import this repository as full content objects and a
baseline changeset onto the platform (git → stream importer, then the bridge retires), run its own `.eforest` loop as a hosted project, and
complete a real task on electric-forest through electric-forest — builder on a branch
stream, critic verdict, merge to main — with git nowhere in the path.

**Capstone — the-forest-builds-the-forest:** a production task on this repo reaches
`verified` entirely through the platform; the evidence chain (event logs, digests, Replay
recordings, verdict) is browsable on the platform itself.

### Epic 9 — the-toolbox (the application platform)

Make electric-forest usable as the foundation for apps beyond the code host. Define a
versioned app manifest and acyclic package/runtime contract; keep the common UI and state
entrypoints small, with optional Docstream, FFmpeg, Electron, Almostnode, Tailscale, and
passkey-vault capabilities loaded explicitly. Components use TanStack DB collections
and live queries. Electric-forest collections adapt its application reducers and route
mutations through its authenticated dispatch door; separate, optional adapters cover
Durable State/StreamDB and ElectricSQL where their contracts fit. The app template and
provider matrix make those boundaries executable and version-pinned. Provider tasks
reuse E15's pinned evidence and decision; they do not require migrating Forest's own
authority to Postgres. Source/build manifests include the E14 changeset identity.

**Capstone — the-first-platform-app:** from a cold clone, scaffold a sample web app, load
one stream-backed collection into TanStack DB, render and mutate it through a shared UI
component, and observe the accepted event and matching state digest from a second client.
The browser-safe root import excludes FFmpeg/Electron and other unused optional runtime
dependencies; a separately imported capability resolves only when selected.

### Epic 10 — the-time-machine (forkable application history)

Make code changes testable against isolated application state. A fork manifest binds the
source changeset/content manifest, branch/offset and built artifact to app schema, authoritative backend stream
offsets, browser-session evidence, and allowed external capabilities. Fork creation
isolates code and data, while explicit adapters control time, randomness, network calls,
and other side effects. A ticket can launch an acceptance journey; rrweb records what the
browser did, while Durable Streams offsets and reducer digests prove what the app state
became. A separate critic verifies the run against the fork manifest and the changed
code, and the verdict becomes a required PR check.

This epic delivers the whitepaper's first vertical slice; restoration, run comparisons,
deployment, and incident handling follow in Epic 11.

**Capstone — ticket-to-verified-app:** from a cold start, create a ticket-scoped app fork,
run an acceptance journey, bind its browser recording to the fork/build and authoritative
event evidence, have an independent critic issue a verdict, and prove that the PR check
blocks when evidence is stale, mismatched, or refuted and passes only for the verified
run.

### Epic 11 — the-wildwood (application operations and recovery)

Carry the verified fork forward through the app lifecycle. Cold restoration must recover
the exact code artifact and state offsets from its manifest; sibling forks must remain
isolated. Reviewers can compare outcomes across forks and build epochs, and a build's
verification evidence is refreshed when its source changeset/content manifest, code, schema, runtime, or capability set
changes. Deployment records preserve the verified artifact and provenance. Production
monitoring can link a regression to its observed event offsets, create an incident task,
and fork a replay environment with captured inputs for diagnosis and repair.

**Capstone — incident-to-replay:** promote a verified app build to a deployment record,
observe a seeded failure, create an incident task from its evidence, restore the matching
application fork, and reproduce the failure from the captured stream offsets. The repair
is verified on a sibling fork and its provenance is linked to the new deployment candidate.
Any later use of platform evidence as model-training data remains speculative research
requiring a separate privacy/consent review; it is outside this capstone and is not
required for the platform roadmap.

## How to read the numbers

Task ids are stable `E{epic}-T{nn}` identities. Priority defaults to `epic × 100 + task
number`, with the explicit human-authorized E12/E13/E15/E14 integer ranges above taking
precedence. The older formula-only wording in planning/audit workflow prompts must be
read subject to this decision; do not renumber tasks or change verified history to
restore numerical epic order. The generated `.eforest/tasks/QUEUE.md` is the source of
what is eligible next, subject to all current lifecycle gates. One capstone per epic,
last, is gated on a cold-start demo. Fractional priorities remain reserved for
queue-jumping bug/regression tasks with a stated reason.
