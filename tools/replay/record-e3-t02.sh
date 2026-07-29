#!/usr/bin/env bash
# Scripted E3-T02 browser evidence: boot the replay world, drive the
# login-to-shell walkthrough non-interactively, and capture the session.
#
# The generic tools/replay/record-run.sh drives `replayio record <url>` by
# hand and depends on a `web-build` make target that does not exist. This is
# the E2-T12 pattern applied to E3-T02: browser-open/close around a
# playwright-cli run-code walkthrough, so the evidence is reproducible rather
# than dependent on a human driving a browser.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

session="${E3_T02_REPLAY_SESSION:-e3-t02-run14}"
video="${E3_T02_REPLAY_VIDEO:-$root/recordings/e3-t02-run14.mp4}"
skill_root="$root/.agents/skills/replayio"
work="$root/.eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/work/replay"
mkdir -p "$work" "$(dirname "$video")"

world_pid=""
cleanup() {
  if [ -n "$world_pid" ]; then kill "$world_pid" 2>/dev/null; fi
}
trap cleanup EXIT

node tools/replay/e3_t02_world.mjs >"$work/world.log" 2>&1 &
world_pid=$!
url=""
for _ in $(seq 1 200); do
  url=""
  if [ -s "$work/world.log" ]; then
    url="$(head -1 "$work/world.log")"
  fi
  case "$url" in
    http://127.0.0.1:*) break ;;
    *) url="" ;;
  esac
  if ! kill -0 "$world_pid" 2>/dev/null; then
    cat "$work/world.log" >&2
    exit 1
  fi
  sleep 0.5
done
[ -n "$url" ] || { echo "world did not publish a platform URL" >&2; cat "$work/world.log" >&2; exit 1; }
echo "world: $url"

# The gate is auth, not obscurity — assert it before recording so the
# recording is of a world that already refuses anonymous callers. These are
# hard assertions: a world that does not refuse anonymous callers must not be
# recorded and presented as evidence.
root_status="$(curl -s -o /dev/null -w '%{http_code}' "$url/")"
if [ "$root_status" != "302" ]; then
  echo "unauthenticated GET / answered ${root_status}, expected 302 into /auth/login" >&2
  exit 1
fi
whoami_status="$(curl -s -o "$work/unauth-whoami.json" -w '%{http_code}' "$url/api/whoami")"
if [ "$whoami_status" != "401" ]; then
  echo "unauthenticated GET /api/whoami answered ${whoami_status}, expected 401" >&2
  exit 1
fi
grep -q '"auth-refused"' "$work/unauth-whoami.json"
echo "pre-record gate: / -> ${root_status}, /api/whoami -> ${whoami_status} auth-refused"

node "$skill_root/scripts/browser-open.js" "$url/" \
  --session "$session" --output "$video"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  video-chapter "Emulator login to authenticated shell"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  run-code --filename tools/replay/e3_t02_walkthrough.js | tee "$work/walkthrough.txt"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  video-chapter "Identity triple, SPA routing, and logout"
npx --yes --package @playwright/cli playwright-cli -s="$session" console error >"$work/console.txt"
npx --yes --package @playwright/cli playwright-cli -s="$session" requests >"$work/requests.txt"
node "$skill_root/scripts/browser-close.js" --session "$session" --output "$video"

echo "---"
echo "video:      $video"
echo "walkthrough: $work/walkthrough.txt"
echo "world state: $work/world.log"
