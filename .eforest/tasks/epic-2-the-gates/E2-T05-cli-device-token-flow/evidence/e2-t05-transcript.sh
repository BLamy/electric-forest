#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../../.." && pwd)"
exec node "${root}/tools/verify/e2_t05_transcript.mjs"
