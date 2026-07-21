#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$root/tools/verify/e2_t06_runtime_boundary_sensitivity.mjs"
