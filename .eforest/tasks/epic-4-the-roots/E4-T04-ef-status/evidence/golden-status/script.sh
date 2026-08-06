#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
exec node --no-warnings --experimental-strip-types "${here}/script.ts"
