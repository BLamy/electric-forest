#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${repo_root}"

node tools/verify/e5_t07_contract.mjs
node tools/verify/e5_t07_evidence.mjs
sensitivity="$(node tools/verify/e5_t07_sensitivity.mjs)"
printf '%s\n' "${sensitivity}"
test "$(printf '%s\n' "${sensitivity}" | grep -c 'EXPECTED-FAIL OK')" -ge 4
