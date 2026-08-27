#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
cd "${root}"

node tools/verify/no_database_audit.mjs "${root}"
