#!/usr/bin/env bash
# Start WebM screencast capture after a browser open command, then close/transcode/upload after a browser close command.
# Reads Claude Code hook event JSON from stdin when available.

set -euo pipefail

input="$(cat || true)"
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '
    .tool_input.command //
    .tool_input.args.command //
    .command //
    .shell_command //
    .args.command //
    empty
  ' 2>/dev/null || true)"
else
  cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_path="$(pwd)/.replay/browser-session.json"

start_video_after_raw_open() {
  [ -f "$state_path" ] && return 0
  command -v npx >/dev/null 2>&1 || return 0

  stamp="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
  video_path="${REPLAYIO_MP4_PATH:-$(pwd)/tmp/recordings/replayio/${stamp}/browser-run.mp4}"
  case "$video_path" in
    *.mp4) ;;
    *) echo "[replayio hook] REPLAYIO_MP4_PATH must end in .mp4, skipping video capture: $video_path" >&2; return 0 ;;
  esac
  webm_path="${REPLAYIO_WEBM_PATH:-${video_path%.mp4}.capture.webm}"
  case "$webm_path" in
    *.webm) ;;
    *) echo "[replayio hook] REPLAYIO_WEBM_PATH must end in .webm, skipping video capture: $webm_path" >&2; return 0 ;;
  esac

  mkdir -p "$(dirname "$video_path")" "$(dirname "$webm_path")" "$(dirname "$state_path")"
  echo "[replayio hook] Browser open detected; starting WebM capture for MP4 output: $video_path" >&2
  if npx --yes --package @playwright/cli playwright-cli video-start "$webm_path" --size "${REPLAYIO_MP4_SIZE:-1280x720}" >/dev/null 2>&1; then
    npx --yes --package @playwright/cli playwright-cli video-show-actions --duration 750 --position top-right >/dev/null 2>&1 || true
    node -e 'const fs=require("fs"); const [statePath, videoPath, webmPath]=process.argv.slice(1); fs.writeFileSync(statePath, JSON.stringify({video_path: videoPath, mp4_path: videoPath, webm_path: webmPath, capture_format: "webm", encoder: "ffmpeg", started_at: new Date().toISOString(), source: "post_tool_use_hook"}, null, 2) + "\n");' "$state_path" "$video_path" "$webm_path"
  else
    echo "[replayio hook] Could not start WebM capture after browser open." >&2
  fi
}

stop_after_raw_close() {
  if [ -x "$plugin_root/scripts/browser-close.js" ]; then
    node "$plugin_root/scripts/browser-close.js" >/dev/null 2>&1 || true
  elif [ -x "$plugin_root/scripts/close_browsers_and_upload.sh" ]; then
    "$plugin_root/scripts/close_browsers_and_upload.sh" >/dev/null 2>&1 || true
  fi
}

case "$cmd" in
  *browser-open.js*)
    # First-class scripts already start WebM capture for MP4 output.
    exit 0
    ;;
  *playwright-cli*open*|*pwcli*open*|*PWCLI*open*)
    start_video_after_raw_open
    ;;
  *browser-close.js*)
    # First-class scripts already stop capture, transcode, and upload.
    exit 0
    ;;
  *playwright-cli*close*|*pwcli*close*|*PWCLI*close*)
    stop_after_raw_close
    ;;
esac

exit 0
