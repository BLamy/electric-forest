#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
exec node "$root/tools/verify/e4-sync/run.mjs" "$@"
