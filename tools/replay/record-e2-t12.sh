#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

session="${E2_T12_REPLAY_SESSION:-e2-t12-final}"
video="${E2_T12_REPLAY_VIDEO:-$root/recordings/e2-t12-final.mp4}"
skill_root="$root/.agents/skills/replayio"
work="$root/.eforest/tasks/epic-2-the-gates/E2-T12-the-locked-gate/work/replay"
mkdir -p "$work" "$(dirname "$video")"
export E2_T12_PROOF_SHA="$(git rev-parse HEAD)"

server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null; fi
}
trap cleanup EXIT

node tools/verify/e2_t12_server.mjs >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 100); do
  if curl -fsS http://127.0.0.1:47122/health >/dev/null; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$work/server.log" >&2
    exit 1
  fi
  sleep 0.1
done
curl -fsS http://127.0.0.1:47122/health >/dev/null

node "$skill_root/scripts/browser-open.js" http://127.0.0.1:47122/ \
  --session "$session" --output "$video"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  video-chapter "Auth0 PKCE login and CLI token mint"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  run-code --filename tools/replay/e2_t12_walkthrough.js | tee "$work/walkthrough.txt"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  video-chapter "Final stream offsets, digests, and byte-neutral refusals"
npx --yes --package @playwright/cli playwright-cli -s="$session" console error >"$work/console.txt"
npx --yes --package @playwright/cli playwright-cli -s="$session" requests >"$work/requests.txt"
node "$skill_root/scripts/browser-close.js" --session "$session" --output "$video"
