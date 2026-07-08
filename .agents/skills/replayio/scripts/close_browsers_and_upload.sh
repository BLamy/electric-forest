#!/usr/bin/env bash
# Stop capture, transcode MP4 output, close lingering Playwright CLI sessions, and upload pending Replay recordings.

set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -x "$plugin_root/scripts/browser-close.js" ]; then
  node "$plugin_root/scripts/browser-close.js" >/dev/null 2>&1 || true
fi

if command -v npx >/dev/null 2>&1; then
  npx --yes --package @playwright/cli playwright-cli video-stop >/dev/null 2>&1 || true
  npx --yes --package @playwright/cli playwright-cli close >/dev/null 2>&1 || true
fi

if command -v replayio >/dev/null 2>&1; then
  replayio upload >/dev/null 2>&1 || true
fi

exit 0
