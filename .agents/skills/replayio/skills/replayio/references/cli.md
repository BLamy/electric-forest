# Agent Browser Reference

Configure the browser executable before opening the host agent browser:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Use the packaged browser lifecycle scripts for Replay-first browser work. `browser-open.js` opens the browser with Replay recording flags and starts WebM screencast capture; `browser-close.js` stops capture, closes the browser, transcodes WebM to MP4 with ffmpeg, verifies MP4 output, and uploads pending Replay recordings.

## Basics

The exact API is host-specific. In Browser-plugin hosts, use the selected `iab` browser:

```js
await browser.nameSession("replay run");
if (typeof tab === "undefined") {
  globalThis.tab = await browser.tabs.new();
}
await tab.goto("https://example.com");
console.log(await tab.playwright.domSnapshot());
await nodeRepl.emitImage(await tab.screenshot({ fullPage: false }));
await tab.close();
```

When the browser work is done, close through the lifecycle script:

```bash
node "$SCRIPT_DIR/browser-close.js"
```

## MP4 Recording With Screencast And ffmpeg

Open the browser before meaningful interaction:

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
node "$SCRIPT_DIR/browser-open.js" "$URL" --output "$VIDEO_PATH"
```

Close, stop capture, synchronously transcode to MP4, verify video, and upload Replay recordings before reporting:

```bash
PLAYWRIGHT_SESSION="<playwright_session from browser-open.js output>"
npx --yes --package @playwright/cli playwright-cli -s="$PLAYWRIGHT_SESSION" snapshot
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH"
```

Always embed generated MP4 files in the final response with Markdown image syntax:

```markdown
![video](/absolute/path/to/recording.mp4)
```

Do not use Playwright BrowserContext `recordVideo` for requested MP4 evidence. It can produce WebM. The lifecycle scripts intentionally capture WebM internally in a named Playwright CLI session, then `browser-close.js` waits for capture stop and ffmpeg to finish before returning a verified MP4. Use `playwright-cli -s="$PLAYWRIGHT_SESSION"` for every command in the run; otherwise you may attach to a stale default session. Do not embed a WebM or rename WebM to `.mp4`.

Do expect WebM bytes before the close/transcode step. `playwright-cli video-start` can write WebM bytes to a path ending in `.mp4`; that path is only the capture source until ffmpeg finishes. If a raw flow already wrote WebM to `$VIDEO_PATH`, do not move the source and do not pass `--webm-path`; run:

```bash
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH"
```

`browser-close.js` automatically handles WebM bytes at the output path. It also auto-detects adjacent `*.capture.webm`, `*.source.webm`, and `*.webm` files with the same basename if an older run already moved the source aside.

Replay upload is optional for local MP4 validity. If close output includes a verified `video` object but upload failed, embed the local MP4 and report the upload failure separately.

`browser-close.js` removes stale frames by default with ffmpeg `mpdecimate,setpts=(3*N)/(30*TB),fps=30` so idle waits do not dominate the MP4 while UI state changes remain readable. The default `--stale-time-scale 3` makes the compressed result about 3x longer than the most aggressive duplicate-removal cadence. Disable only when real-time duration matters:

```bash
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH" --compress-stale false
```

Tune the cadence when needed:

```bash
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH" --stale-time-scale 2
```

If ffmpeg is missing, install it and rerun:

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# Windows
winget install Gyan.FFmpeg
# or: choco install ffmpeg

ffmpeg -version
```

The raw-frame screencast route with `onFrame` can feed frames into ffmpeg for custom streaming encoders, but the final video is still only safe to embed after the ffmpeg process exits successfully.

## Worker/Critic Prompt Templates

The Pro bundle includes reusable prompt templates for a Replay proof loop:

```bash
WORKER_PROMPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/agents/replay-worker.md"
CRITIC_PROMPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/agents/replay-critic.md"
```

Use the worker prompt for the implementation subagent that edits code and records the final session. Use the critic prompt for the read-only subagent that inspects the uploaded Replay recording against the requirements and diff. The critic should use Replay MCP only; it should not run shell commands, edit files, or open a fresh browser.

## Multi-Session And Side-By-Side Output

For two browser sessions, name each session and pass that name to every command:

```bash
node "$SCRIPT_DIR/browser-open.js" "$URL" --session "$RUN_ID-ada" --output "$(pwd)/recordings/$RUN_ID-ada.mp4"
node "$SCRIPT_DIR/browser-open.js" "$URL" --session "$RUN_ID-linus" --output "$(pwd)/recordings/$RUN_ID-linus.mp4"
npx --yes --package @playwright/cli playwright-cli -s="$RUN_ID-ada" snapshot
npx --yes --package @playwright/cli playwright-cli -s="$RUN_ID-linus" snapshot
node "$SCRIPT_DIR/browser-close.js" --session "$RUN_ID-ada"
node "$SCRIPT_DIR/browser-close.js" --session "$RUN_ID-linus"
```

`browser-open.js` writes per-session state. `browser-close.js --session "$RUN_ID-ada"` reads that state, so the Ada and Linus outputs do not overwrite each other.

Use `stitch-videos.js` to render a combined MP4:

```bash
node "$SCRIPT_DIR/stitch-videos.js" --output "$(pwd)/recordings/$RUN_ID.mp4" "$LEFT_VIDEO" "$RIGHT_VIDEO"
```

## `jq` Filtering For Uploads

If `jq` is missing, install it first:

```bash
brew install jq
# or: sudo apt update && sudo apt install jq
# or: winget install jqlang.jq
```

Use `jq` to upload only finished recordings from the current run:

```bash
mapfile -t replay_ids < <(
  replayio list --json | jq -r --arg started "$STARTED_AT" --arg room "$ROOM" '
    .[]
    | select(.date >= $started)
    | select((.metadata.uri // "" | contains($room)) or (.metadata.title // "" | contains($room)))
    | select(.recordingStatus == "finished")
    | select((.uploadStatus // "not_uploaded") != "uploaded")
    | .id
  '
)

[ "${#replay_ids[@]}" -gt 0 ] && replayio upload "${replay_ids[@]}"
```

Before testing auth/backend-dependent local app behavior, choose with the user whether to run as-is or with emulation. Recommend emulation when login, checkout, email, database, OAuth, or API behavior depends on services that are absent in the local run. If the user chooses as-is, label missing login/chat redirects as local as-run behavior rather than production-auth bugs.

## Inspection

Use direct agent-browser inspection before reaching for Replay analysis tools:

- DOM snapshots for locator ground truth.
- Console and developer logs from the browser API.
- Screenshots for visual state.
- Read-only page evaluation for state such as title, URL, local storage, and session storage.
- Host-provided network and cookie tools when available.

Use Replay analysis tools only after the recording has uploaded and direct browser output is not enough to explain the issue.
