#!/usr/bin/env bash
# Record the final happy run as a Replay recording and print its URL — the analog of
# wasm-vm's tools/rr/record-test.sh. Builds/serves the app first so the recording holds
# the app, not the build; uploads on close so the evidence is transferable (upload is our
# `rr pack`).
#
# Usage: tools/replay/record-run.sh [-o <claim-name>] [--url <url>]
#   -o <name>   name the recording for the claim, e.g. -o e0-t20-final (REQUIRED for
#               evidence runs; the verifier matches recording titles against claims)
#   --url <url> record an already-running server instead of building+serving web/
#
# Prints the uploaded recording URL(s) as the last line(s). Paste into the task's
# Verification log. An Epic 0 task extends this with scripted scenarios; today the
# walkthrough is driven by hand (or by the replayio skill's browser-open/close lifecycle
# scripts for MP4-captured agent runs).

set -euo pipefail

# Run from anywhere: resolve the repo root like the tools/verify scripts do.
here="$(cd "$(dirname "$0")" && pwd)"
cd "${here}/../.."

NAME=""
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) NAME="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

tools/replay/preflight.sh >/dev/null || {
  echo "SKIPPED: replay preflight failed — record with Playwright fallback and declare 'Replay: N/A' in the claim" >&2
  exit 1
}

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; fi
  return 0
}
trap cleanup EXIT

if [ -z "$URL" ]; then
  # Build the web app once it is wired (Epic 3); the Makefile's placeholder target
  # loud-skips until then, so probe for the real build, not the target's existence.
  if [ -f apps/web/package.json ]; then
    make web-build
  else
    echo "note: web app not wired yet (lands in Epic 3) — serving apps/web as-is" >&2
  fi
  [ -d apps/web ] || { echo "SKIPPED: no apps/web directory to serve (pre-Epic 3?)" >&2; exit 1; }
  python3 -m http.server 8901 --directory apps/web >/dev/null 2>&1 &
  SERVER_PID=$!
  URL="http://127.0.0.1:8901/"
  sleep 1
fi

echo "recording $URL — drive the walkthrough, exercise EVERY changed behavior, then close the browser."
replayio record "$URL"

echo "uploading finished recordings…"
replayio upload --all

echo "---"
echo "recent recordings (newest first) — cite the URL${NAME:+ and title it '$NAME' in the Replay UI}:"
replayio list | head -5
