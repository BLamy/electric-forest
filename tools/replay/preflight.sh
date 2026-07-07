#!/usr/bin/env bash
# Gate the browser evidence layer: pass only when this machine can actually record,
# upload, and interrogate Replay recordings. The analog of wasm-vm's tools/rr/preflight.sh
# (which gates on Linux+PMU); Replay's constraint is tooling+auth, not OS — macOS works.
#
# Usage: tools/replay/preflight.sh [--full]
#   default : static checks (CLI, auth, runtime, MCP server starts)
#   --full  : additionally require a real record -> upload round-trip (interactive:
#             a Replay Chromium window opens; load the page, then close the browser)
#
# Contract: any missing capability prints the failure AND exits nonzero. No silent green.
# E0-T23 hardens this script until --full is the default and fully non-interactive.

set -u

FULL=0
[ "${1:-}" = "--full" ] && FULL=1

fail=0
say() { printf '%s\n' "$*"; }
ok()  { say "  ok: $*"; }
bad() { say "  FAIL: $*"; fail=1; }

say "replay preflight — browser evidence layer"

# 1. CLI
if command -v replayio >/dev/null 2>&1; then
  ok "replayio CLI: $(command -v replayio)"
else
  bad "replayio CLI not found (brew install replayio | npm i -g replayio)"
fi

# 2. Auth (interactive login or API key — CI uses the key). Positive-signal match only:
# the logged-out CLI prints "You are not authenticated", and grep -qiv is a liar (any
# spinner line without the pattern satisfies it) — never invert here.
if [ -n "${REPLAY_API_KEY:-}" ]; then
  ok "REPLAY_API_KEY set"
elif command -v replayio >/dev/null 2>&1 && replayio whoami 2>/dev/null | grep -qiE 'signed in as|authenticated as'; then
  ok "replayio whoami: authenticated"
else
  bad "not authenticated (replayio login, or export REPLAY_API_KEY)"
fi

# 3. Replay Chromium runtime — an actual executable, not merely a runtimes directory.
RUNTIME="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
RUNTIME_ANY=$(find "$HOME/.replay/runtimes" -maxdepth 4 -type f \( -name 'Chromium*' -o -name 'chrome*' \) -perm -u+x 2>/dev/null | head -1)
if [ -x "$RUNTIME" ] || [ -n "$RUNTIME_ANY" ]; then
  ok "Replay Chromium runtime present (${RUNTIME_ANY:-$RUNTIME})"
else
  bad "Replay Chromium runtime missing (replayio update)"
fi

# 4. Replay MCP server starts (stdio; a valid initialize handshake must come back).
# `timeout` is not a stock macOS binary — degrade to gtimeout, then to no wrapper.
if command -v timeout >/dev/null 2>&1; then TO="timeout 30"
elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 30"
else TO=""; fi
if command -v npx >/dev/null 2>&1; then
  MCP_ERR=$(mktemp -t preflight-mcp-XXXX)
  MCP_OUT=$(printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"preflight","version":"0"}}}' \
    | $TO npx -y replayio mcp 2>"$MCP_ERR" | head -1)
  if printf '%s' "$MCP_OUT" | grep -q '"result"'; then
    ok "Replay MCP server answers initialize (npx -y replayio mcp)"
  else
    bad "Replay MCP server did not answer initialize (npx -y replayio mcp); stderr: $(tail -2 "$MCP_ERR" | tr '\n' ' ')"
  fi
  rm -f "$MCP_ERR"
else
  bad "npx not found (node toolchain missing)"
fi

# 5. Full round-trip: record something real, upload it, see it in the list.
if [ "$FULL" = 1 ] && [ "$fail" = 0 ]; then
  say "  --full: recording a throwaway page; CLOSE THE BROWSER when it has loaded."
  TMP_HTML=$(mktemp -t preflight-XXXX.html)
  printf '<!doctype html><title>replay preflight</title><h1>replay preflight %s</h1>' "$$" > "$TMP_HTML"
  BEFORE=$(replayio list 2>/dev/null | wc -l)
  replayio record "file://$TMP_HTML" >/dev/null 2>&1
  AFTER=$(replayio list 2>/dev/null | wc -l)
  if [ "$AFTER" -gt "$BEFORE" ]; then
    ok "recording created"
    if replayio upload --all >/dev/null 2>&1; then
      ok "upload succeeded — round-trip complete"
    else
      bad "upload failed (network/auth?)"
    fi
  else
    bad "no new recording appeared after record"
  fi
  rm -f "$TMP_HTML"
fi

if [ "$fail" = 0 ]; then
  say "preflight: PASS${FULL:+ (mode: $([ "$FULL" = 1 ] && echo full || echo static))}"
  exit 0
else
  say "preflight: FAIL — browser evidence unavailable on this machine."
  say "Until this passes: Playwright + console/network interrogation, and every claim"
  say "carries 'Replay: N/A (<reason>) + mitigation'. SKIPPED is loud, never silent."
  exit 1
fi
