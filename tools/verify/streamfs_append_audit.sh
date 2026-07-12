#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

manifest="$(cd packages/client && node --input-type=module -e 'const m=await import("./dist/src/index.js"); process.stdout.write(m.APPEND_SURFACE.join("\n"));')"
documented=$'StreamWriter.append\nStreamWriter.flush'
if [ "$manifest" != "$documented" ]; then
  echo "streamfs append audit: documented append surface differs from packages/client APPEND_SURFACE" >&2
  printf '%s\n' "manifest:" "$manifest" "documented:" "$documented" >&2
  exit 1
fi

set +e
bad_metadata="$(rg -n -e 'method:[[:space:]]*"POST".*metadataStreamId' -e 'metadataStreamId.*method:[[:space:]]*"POST"' packages/streamfs/src/fs.ts)"
rg_status=$?
set -e
if [ "$rg_status" -gt 1 ]; then
  echo "streamfs append audit: ripgrep failed" >&2
  exit 1
fi
if [ -n "$bad_metadata" ]; then
  echo "streamfs append audit: raw POST targets metadata outside dispatch" >&2
  printf '%s\n' "$bad_metadata" >&2
  exit 1
fi

if ! rg -n 'metadataStreamId\).*dispatch|/dispatch' packages/streamfs/src/fs.ts >/dev/null; then
  echo "streamfs append audit: no metadata dispatch path found" >&2
  exit 1
fi

echo "streamfs append audit: APPEND_SURFACE matches and metadata mutations use /dispatch only OK"
