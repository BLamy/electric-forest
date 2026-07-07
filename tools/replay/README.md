# tools/replay — browser-layer evidence (the rr analog)

wasm-vm records the Rust process with rr and hands the critic a packed trace. This repo
records the **browser session** with Replay and hands the critic a recording URL. Same
doctrine: the recording of the final happy run *is* the evidence; the critic interrogates
it, they don't trust the summary. (The lineage runs the other way here — rr traces were
wasm-vm's stand-in for exactly this: a Replay recording of the app.)

| wasm-vm concept | electric-forest equivalent |
|---|---|
| packed rr trace in `rr-traces/` | uploaded Replay recording, cited by URL (never committed) |
| `rr replay -g <event>` citation | **point link**: `https://app.replay.io/recording/<id>?point=<p>&time=<ms>` |
| `whowrote <lvalue>` (watchpoint + reverse-continue) | browser layer: logpoints/evaluation at points via Replay MCP · stream layer: **digest bisect** over the event log (`ef bisect <log> --against <ref>`, lands in Epic 0's evidence tooling; until then script it over `ef replay --digest`) |
| `dprintf` retroactive logging | logpoints added post-hoc to the recording via the Replay MCP |
| chaos mode (`rr record --chaos`) | seeded input-timing jitter in scenario runs + stream-side event fuzzing (malformed events, out-of-order appends, concurrent writers — any failure becomes a permanent recording) |
| `tools/rr/preflight.sh` (Linux+PMU gate) | `tools/replay/preflight.sh` (CLI + auth + runtime + MCP gate — **macOS works**) |

## Setup (once per machine)

```sh
brew install replayio            # or: npm i -g replayio
replayio login                   # or export REPLAY_API_KEY (CI)
replayio update                  # installs/updates Replay Chromium
tools/replay/preflight.sh        # gates everything below
```

The Replay MCP server is project-wired in `.mcp.json`:

```json
{ "mcpServers": { "replay": { "type": "stdio", "command": "npx", "args": ["-y", "replayio", "mcp"] } } }
```

Also installed (from Replay's official `replayio/plugins` claude-pro bundle):

- `.claude/agents/replay-worker.md` / `.claude/agents/replay-critic.md` — the worker/critic
  proof-loop roles. The critic is **read-only**: it inspects recordings through the Replay
  MCP and the supplied diff; it never edits files or drives a fresh browser.
- `.claude/skills/replayio/` — the `replayio` skill: `scripts/browser-open.js` /
  `scripts/browser-close.js` lifecycle scripts (Replay recording flags + WebM→MP4 capture +
  upload), `stitch-videos.js`, and reference docs.

## Recording a claim

```sh
tools/replay/record-run.sh -o e3-t02-final            # serve apps/web, record, upload, print URL
tools/replay/record-run.sh -o e2-t06-final --url http://localhost:5173
```

Name the recording for the claim (`-o <task>-final`), exactly like wasm-vm's
`record-test.sh -o e0-t07-final`. The script builds/serves the web app first so the
recording holds the app, not the build; on close it uploads and prints the recording URL —
paste that URL into the task's Verification log entry.

The recorded walkthrough must exercise **every changed browser-reaching behavior** —
the critic holds the recording against the diff, and an unexecuted hunk is unproven or
dead.

## Interrogating a recording (critic cheatsheet)

Open the Replay MCP tools (ToolSearch "replay" in an agent session; the tool surface is
provided by `npx -y replayio mcp`). Then:

1. **Orient**: timeline shape — user events, console messages, network requests, uncaught
   exceptions.
2. **Cheap sweeps first**: any console error from our bundles? any failed request? any
   long-poll loop that never advances its offset? does the claimed offset/digest exist
   *in* the recording at all?
3. **Predict, then verify**: for each browser-layer claim, write the falsifiable prediction
   at a specific timeline point *before* inspecting; then evaluate expressions / add
   logpoints at that point.
4. **Artifact identity**: pull the fetched app bundles from network events and hash-match
   them against the claim's commit — the recording must be of the code under review.
5. **Cite or it didn't happen**: every finding carries a point link.

If the MCP tools are unavailable, the verdict is `needs-evidence` naming the missing
capability — never "probably fine".

## The loud fallback

Until `preflight.sh` passes on a machine, browser evidence falls back to Playwright +
console/network interrogation of the real app, and every claim carries
`Replay: N/A (<reason>) + mitigation`. The fallback is legitimate; silence about it is not.
`SKIPPED: <reason>` + nonzero exit is the contract everywhere (`VERIFY_ALLOW_SKIP=1` to
override in degraded environments).

## Production

Production rides the same rails (see `AGENTS.md` § Production is the same loop): in-app
session capture (lands with the platform epics) produces recordings whose IDs enter this
same citation pipeline; `.claude/workflows/replay-triage.js` turns them into
evidence-backed bug tasks. Replay's `replay-qa` bundle
(`npx shadcn@latest add replayio/plugins/claude-code`) layers full production QA runs
(journeys, explorations, bug reports) on top once the hosted app exists (Epics 5–7).
