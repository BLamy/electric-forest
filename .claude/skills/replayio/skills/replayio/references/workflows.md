# Agent Browser Workflows

Use the packaged browser lifecycle scripts for Replay-first work. `browser-open.js` opens the browser with Replay recording flags and starts WebM screencast capture; `browser-close.js` stops capture, closes the browser, transcodes WebM to MP4 with ffmpeg, verifies MP4 output, and uploads pending Replay recordings.

## Standard Interaction Loop

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Then drive the browser through the host browser API:

1. Open the target URL with `browser-open.js` and keep the returned `playwright_session`.
2. Take a DOM snapshot or screenshot.
3. Interact with stable locators or visible UI, passing `-s="$PLAYWRIGHT_SESSION"` to each `playwright-cli` command.
4. Re-snapshot after DOM changes or navigation.
5. Close with `browser-close.js` when done; it must finish successfully before embedding video because it waits for ffmpeg to write the MP4.
6. Use the Claude Code stop hook only as a cleanup safety net.

## Debugging And Inspection

Capture console messages and visual state after reproducing an issue. In Browser-plugin hosts:

```js
console.log(await tab.playwright.domSnapshot());
console.log(await tab.dev.logs({ levels: ["error", "warn"], limit: 100 }));
await nodeRepl.emitImage(await tab.screenshot({ fullPage: false }));
console.log(await tab.playwright.evaluate(() => ({
  href: location.href,
  title: document.title,
  localStorage: { ...localStorage },
  sessionStorage: { ...sessionStorage },
})));
```

Use Replay analysis tools only after the recording has uploaded and direct browser output is not enough to explain the issue.

## Worker/Critic Proof Loop

For implementation tasks where Replay should prove the work, use the subagent prompt templates installed under `skills/replayio/subagents/`:

- `replay-worker.md`: builds or fixes the feature, self-validates with the browser, and records the final proof session under Replay Chromium.
- `replay-critic.md`: performs read-only adversarial review of the uploaded Replay recording against the requirements and supplied diff.

The critic must be a separate role from the worker whenever the host supports subagents. Give the critic only the requirements, worker claim, recording IDs/URLs, and diff. Do not give it file-write, shell, or live-browser authority. Its job is predict-then-verify runtime facts through Replay MCP, audit changed-code coverage, find mocks/fixtures that made the proof pass, and return `satisfied`, `needs_evidence`, or `needs_revision`.

Treat `needs_revision` as an implementation failure and send it back to the worker. Treat `needs_evidence` as a proof-session failure and re-record the missing behavior without unnecessary code churn. Only report completion after the critic is satisfied or after clearly explaining the remaining blocker.

## Screencast MP4 Loop

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
node "$SCRIPT_DIR/browser-open.js" "$URL" --output "$VIDEO_PATH"
PLAYWRIGHT_SESSION="<playwright_session from browser-open.js output>"
```

Use `playwright-cli` interaction, inspection, and chapter commands during the run:

```bash
npx --yes --package @playwright/cli playwright-cli -s="$PLAYWRIGHT_SESSION" video-chapter "Checkout flow"
npx --yes --package @playwright/cli playwright-cli -s="$PLAYWRIGHT_SESSION" snapshot
```

Before responding:

```bash
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH"
```

Embed the video directly in the response:

```markdown
![video](/absolute/path/to/browser-run.mp4)
```

Internally, capture is WebM. The MP4 exists only after `browser-close.js` stops capture and ffmpeg exits successfully. `playwright-cli video-start` can write WebM bytes even when the path ends in `.mp4`; treat that as the source capture, not the final artifact. If the WebM source is already at `$VIDEO_PATH`, do not move it or pass a separate source flag; run `browser-close.js --output "$VIDEO_PATH"` so it can transcode in place. If an older run already moved the source aside, `browser-close.js` auto-detects matching adjacent `*.capture.webm`, `*.source.webm`, and `*.webm` files.

If ffmpeg is missing, install it and rerun:

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# Windows
winget install Gyan.FFmpeg
# or: choco install ffmpeg
```

Use the raw-frame `onFrame` screencast path only when a task specifically needs live custom encoding. Even then, close the encoder stream and wait for the ffmpeg process to exit before reporting the final MP4.

`browser-close.js` compresses stale frames by default with a `--stale-time-scale 3` cadence, so long idle waits are removed while the remaining state changes play about 3x longer than the most aggressive duplicate-removal output. Use `--compress-stale false` only when the user needs real-time duration.

Replay upload failure does not invalidate a verified local MP4. If the close output includes a valid `video` object and an upload error, embed the MP4 and report the upload problem separately.

Before recording auth/backend-dependent app behavior, elicit whether to test the app as-is or with emulation/mocks. Recommend emulation when missing local services would otherwise make login, checkout, email, database, OAuth, or API flows look broken for reasons unrelated to the UI under test.

## Purpose-Built `record:replay` Project Scripts

When the app needs emulators, seeded users, two browser sessions, or repeatable proof artifacts, add a project-local `record:replay` script instead of doing a one-off manual browser run. The script should start the emulator and app on explicit ports, wait for health, run a dedicated Replay Playwright config, poll `replayio list --json` until the new recordings are `finished`, upload only finished IDs, stitch the two Playwright videos into a side-by-side MP4, write `recordings/latest.json`, and stop every spawned process in `finally`.

Do not upload local IDs that still have `recordingStatus: "recording"`. Poll with a timeout and report stuck IDs separately. This avoids runs where one browser video is valid but the second Replay URL is missing because the recording was uploaded too early.

Use the plugin stitch helper for the final proof video:

```bash
node "$SCRIPT_DIR/stitch-videos.js" \
  --output "$(pwd)/recordings/$RUN_ID.mp4" \
  "$ADA_VIDEO" \
  "$LINUS_VIDEO"
```

For lifecycle-script multi-browser runs, give each browser a stable session name and always pass the matching session to every `playwright-cli` and `browser-close.js` command. `browser-open.js` writes per-session state files so `browser-close.js --session "$SESSION"` can close the intended browser and output.

## `jq` For Replay Lists

Install `jq` if it is missing:

```bash
if ! command -v jq >/dev/null 2>&1; then
  brew install jq
  # or: sudo apt update && sudo apt install jq
  # or: winget install jqlang.jq
fi
```

Filter `replayio list --json` before upload:

```bash
replayio list --json | jq -r --arg started "$STARTED_AT" --arg room "$ROOM" '
  .[]
  | select(.date >= $started)
  | select((.metadata.uri // "" | contains($room)) or (.metadata.title // "" | contains($room)))
  | [.id, .recordingStatus, (.uploadStatus // "not_uploaded"), (.metadata.title // "")]
  | @tsv
'
```
