---
description: Record a Replay Chromium browser session with verified MP4 evidence
argument-hint: "[url] [proof instructions]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

Use Replay.io Pro to record browser evidence for this project.

1. Load the `replayio` skill from `${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/skills/replayio`.
2. Resolve `SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/scripts"`.
3. Start the app, open the requested URL with `browser-open.js`, interact through the returned Playwright session, and close with `browser-close.js`.
4. Report the verified MP4 path and any uploaded Replay recording URLs.

Use `$ARGUMENTS` as the URL and proof instructions.
