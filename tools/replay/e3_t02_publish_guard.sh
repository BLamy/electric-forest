#!/usr/bin/env bash
# Validate the persisted browser telemetry before invoking the one command that
# closes the Replay lifecycle and uploads its finished recording.
set -euo pipefail

if [ "$#" -lt 5 ] || [ "$3" != "--" ]; then
  echo "usage: e3_t02_publish_guard.sh WALKTHROUGH CONSOLE -- COMMAND [ARGS...]" >&2
  exit 2
fi

walkthrough="$1"
console_transcript="$2"
shift 3

node tools/verify/e3_t02_recorder_guard.mjs "$walkthrough" "$console_transcript"
exec "$@"
