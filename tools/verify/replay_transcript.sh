#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    if kill "$server_pid" 2>/dev/null; then :; fi
    if wait "$server_pid" 2>/dev/null; then :; fi
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

node packages/server/dist/src/bin.js --port 0 >"$tmp/server.log" 2>"$tmp/server.err" &
server_pid=$!
for _ in $(seq 1 100); do
  if rg -q '^LISTENING ' "$tmp/server.log"; then break; fi
  sleep 0.01
done
if ! rg -q '^LISTENING ' "$tmp/server.log"; then
  cat "$tmp/server.err" >&2
  echo "replay_transcript: server did not start" >&2
  exit 1
fi
url="$(sed -n 's/^LISTENING //p' "$tmp/server.log" | head -n 1)"
EFOREST_SERVER_URL="$url" node tools/verify/replay_transcript.mjs
