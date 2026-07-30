#!/usr/bin/env bash
# Validate the persisted browser telemetry before invoking the one command that
# closes the Replay lifecycle and uploads its finished recording.
set -euo pipefail

if [ "$#" -lt 7 ] || [ "$5" != "--" ]; then
  echo "usage: e3_t02_publish_guard.sh WALKTHROUGH FINAL_TELEMETRY CONSOLE REQUESTS -- COMMAND [ARGS...]" >&2
  exit 2
fi

walkthrough="$1"
final_telemetry="$2"
console_transcript="$3"
requests_transcript="$4"
shift 5

node tools/verify/e3_t02_recorder_guard.mjs \
  "$walkthrough" "$final_telemetry" "$console_transcript" "$requests_transcript"
exec "$@"
