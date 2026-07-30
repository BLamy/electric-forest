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

session="${E3_T02_REPLAY_SESSION:-e3-t02b-final}"
video="${E3_T02_REPLAY_VIDEO:-$root/recordings/e3-t02b-final.mp4}"
skill_root="$root/.agents/skills/replayio"
work="$root/.eforest/tasks/epic-3-the-canopy/E3-T02b-browser-evidence-hardening/work/replay"
mkdir -p "$work" "$(dirname "$video")"
walkthrough_expression="$work/walkthrough-expression.js"
final_telemetry_expression="$work/final-telemetry-expression.js"
export E3_T02_REPLAY_SESSION="$session"
export E3_T02_TELEMETRY_JOURNAL="$work/terminal-telemetry.jsonl"
recordings_before="$work/recordings-before.json"
receipt="$work/publication-receipt.json"
rm -f "$E3_T02_TELEMETRY_JOURNAL" "$receipt"

# Prettier correctly terminates the source expression with a semicolon, while
# playwright-cli run-code expects the file to contain the bare expression.
# Compile and normalize it before opening the browser so formatter output can
# never turn a final capture into an empty recording.
node tools/verify/e3_t02_playwright_expression.mjs \
  tools/replay/e3_t02_walkthrough.js "$walkthrough_expression"
node tools/verify/e3_t02_playwright_expression.mjs \
  tools/replay/e3_t02_final_telemetry.js "$final_telemetry_expression"

world_pid=""
browser_opened=0
published=0
cleanup() {
  status=$?
  trap - EXIT
  if [ "$browser_opened" -eq 1 ] && [ "$published" -eq 0 ]; then
    if npx --yes --package @playwright/cli playwright-cli -s="$session" close \
      >"$work/failed-browser-close.txt" 2>&1; then
      echo "failed run: closed browser without browser-close/upload" >&2
    else
      echo "failed run: browser cleanup also failed; browser-close/upload was not invoked" >&2
    fi
  fi
  if [ -n "$world_pid" ]; then
    if ! kill "$world_pid" 2>/dev/null; then
      echo "world process had already stopped" >&2
    fi
  fi
  exit "$status"
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

node tools/replay/e3_t02_recording_id.mjs --snapshot "$recordings_before"
node "$skill_root/scripts/browser-open.js" "$url/" \
  --session "$session" --output "$video"
browser_opened=1
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  video-chapter "Emulator login to authenticated shell"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  run-code --filename "$walkthrough_expression" | tee "$work/walkthrough.txt"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  video-chapter "Identity triple, SPA routing, and logout"
npx --yes --package @playwright/cli playwright-cli -s="$session" console error >"$work/console.txt"
npx --yes --package @playwright/cli playwright-cli -s="$session" requests >"$work/requests.txt"
npx --yes --package @playwright/cli playwright-cli -s="$session" \
  run-code --filename "$final_telemetry_expression" | tee "$work/final-telemetry.txt"
recording_id="$(
  node tools/replay/e3_t02_recording_id.mjs \
    --new "$recordings_before" "$work/walkthrough.txt"
)"
node tools/replay/e3_t02_recorder_lifecycle.mjs \
  --session "$session" \
  --recording-id "$recording_id" \
  --journal-path "$E3_T02_TELEMETRY_JOURNAL" \
  --walkthrough-path "$work/walkthrough.txt" \
  --final-telemetry-path "$work/final-telemetry.txt" \
  --console-path "$work/console.txt" \
  --requests-path "$work/requests.txt" \
  --video-path "$video" \
  --receipt-path "$receipt" \
  --browser-close-path "$skill_root/scripts/browser-close.js"
published=1

echo "---"
echo "video:      $video"
echo "walkthrough: $work/walkthrough.txt"
echo "final telemetry: $work/final-telemetry.txt"
echo "publication receipt: $receipt"
echo "world state: $work/world.log"
