---
description: Run the Replay worker/critic proof loop for a UI change
argument-hint: "[requirements or recording id]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

Run the Replay build-and-falsify loop:

1. Read `${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/agents/replay-worker.md`.
2. Read `${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/agents/replay-critic.md`.
3. Use the worker role to implement or re-record the proof session.
4. Use the critic role as a separate read-only review of the uploaded Replay recording against the requirements and diff.
5. Iterate until the critic returns `VERDICT: satisfied`, or report the blocker.

Use `$ARGUMENTS` as the requirements, recording id, or critic input.
