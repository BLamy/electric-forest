#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

if [ ! -d packages/server/src ]; then
  echo "no_reimpl_grep: packages/server/src is missing" >&2
  exit 1
fi

set +e
violations="$(rg -n \
  'createHash|crypto\.createHash|Object\.keys\([^)]*\)\.sort\(|JSON\.stringify\([^)]*Object\.keys|Math\.(floor|ceil|trunc)\([^)]*offset|padStart\([^)]*offset' \
  packages/server/src --glob '!*.test.ts')"
rg_status=$?
set -e
if [ "$rg_status" -gt 1 ]; then
  echo "no_reimpl_grep: scan failed" >&2
  exit "$rg_status"
fi
if [ -n "$violations" ]; then
  echo "no_reimpl_grep: forbidden frozen-protocol implementation found" >&2
  echo "$violations" >&2
  exit 1
fi

if rg -n 'from "@eforest/protocol"' packages/server/src >/dev/null; then
  echo "no_reimpl_grep: server imports @eforest/protocol for frozen primitives"
else
  echo "no_reimpl_grep: server has no protocol import" >&2
  exit 1
fi
echo "no_reimpl_grep: OK"
