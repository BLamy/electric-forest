---
name: "replayio"
description: "Use when you need Replay.io Pro in Claude Code: record or inspect a Replay browser run, capture verified MP4 evidence, test a local app with Replay Chromium, or use Replay MCP for deeper debugging."
allowed-tools: Bash(node *), Bash(npx *), Bash(replayio *), Bash(ffmpeg *), Bash(file *), Bash(test *), Bash(command *)
---

# Replay.io Pro For Claude Code

Use this skill for direct Replay.io dev tools. Replay QA project, bug, journey, and exploration workflows belong to the separate `replay-qa` / `claude-code` package.

## Paths

Resolve the plugin root from this loaded skill:

```bash
SKILL_DIR="${CLAUDE_SKILL_DIR:-.claude/skills/replayio/skills/replayio}"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
SCRIPT_DIR="$PLUGIN_ROOT/scripts"
AGENT_DIR="$PLUGIN_ROOT/agents"
```

Available scripts:

| Script | Purpose |
| --- | --- |
| `browser-open.js` | Open a URL with Replay recording flags enabled and start WebM capture for a final MP4 artifact. |
| `browser-close.js` | Stop capture, close the browser, transcode WebM to MP4 with ffmpeg, verify the MP4, and upload pending Replay recordings. |
| `stitch-videos.js` | Stitch exactly two browser videos into one verified side-by-side MP4. |
| `replayio_browser_lifecycle_hook.sh` | Claude Code post-tool hook that starts capture after raw `playwright-cli open` and cleans up after raw close commands. |
| `close_browsers_and_upload.sh` | Claude Code stop hook that closes lingering sessions and uploads pending Replay recordings. |

Available subagents:

| Subagent | Purpose |
| --- | --- |
| `replay-worker` | Implementation worker that builds, self-validates in the browser, and records the final proof session. |
| `replay-critic` | Read-only adversarial critic that inspects the Replay recording against requirements and diff evidence. |

Run the setup check first when setup is unknown:

```bash
node "$SKILL_DIR/scripts/context.js"
```

## Build-And-Falsify Loop

Use `replay-worker` and `replay-critic` when the user asks for Replay-backed proof, adversarial verification, "agents that prove their work", or a UI/code change whose browser behavior should be validated by runtime evidence.

The worker and critic must be separate roles:

1. Worker: edits code, runs normal checks, drives the app, and records the final walkthrough under Replay Chromium.
2. Critic: receives requirements, the worker claim, uploaded recording IDs/URLs, and the PR diff as static input. It reviews only the evidence through Replay MCP and the supplied diff. It must not edit files, run shell commands, or drive a fresh browser.

Loop on the critic verdict:

- `needs_revision`: send the finding back to the worker, change the implementation, record a new proof session, and re-run the critic.
- `needs_evidence`: keep the implementation, record a better session that exercises the missing path, and re-run the critic.
- `satisfied`: report the proof artifacts and any suite promotion recommendation.

The recording is the unit of evidence. Screenshots, DOM snapshots, local MP4s, and passing self-checks are supporting context; the critic should treat the uploaded Replay timeline as the source of truth for runtime state, network requests, source execution, exceptions, and mock-data audit.

## MP4 Video Contract

When the task needs shareable browser video, open and close the browser through the lifecycle scripts. Use an absolute `.mp4` path when you need a predictable artifact location:

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
node "$SCRIPT_DIR/browser-open.js" "$URL" --output "$VIDEO_PATH"
```

Interact through `playwright-cli` commands or the host's attached CLI session. Always pass the returned `playwright_session`:

```bash
PLAYWRIGHT_SESSION="<playwright_session from browser-open.js output>"
npx --yes --package @playwright/cli playwright-cli -s="$PLAYWRIGHT_SESSION" snapshot
node "$SCRIPT_DIR/browser-close.js" --session "$PLAYWRIGHT_SESSION" --output "$VIDEO_PATH"
```

Do not embed WebM or rename WebM to `.mp4`. `browser-close.js` waits for capture stop, runs ffmpeg synchronously, verifies the MP4, and uploads pending finished Replay recordings. If upload fails but the local MP4 verifies, the MP4 is still valid evidence; report the upload failure separately.

## Purpose-Built `record:replay` Scripts

When a local app needs repeatable full-stack recording, add a project-specific `record:replay` script instead of driving ad hoc sessions. This is the right pattern for local emulators, seeded auth, a database/API service, multiple browser sessions, or side-by-side proof video.

The script should start required services, wait for health, run a dedicated Replay Playwright config, poll `replayio list --json` until new recordings are `finished`, upload only finished IDs, stitch videos with `stitch-videos.js`, write `recordings/latest.json`, and stop every spawned process in `finally`.

## References

- `references/cli.md` covers the lifecycle scripts, MP4 encoding, multi-session recording, and `jq` filtering.
- `references/workflows.md` covers the standard browser workflow and worker/critic loop.
