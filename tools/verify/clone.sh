#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${repo_root}"
clone_output="$(node tools/verify/e4_t03_clone.mjs)"
printf '%s\n' "${clone_output}"
node tools/verify/e4_t03_provider.mjs
node tools/verify/e4_t03_auth.mjs

if ! printf '%s\n' "${clone_output}" | rg -q '^physical-compaction=observed='; then
  echo "E4_T03_BLOCKED: the configured Durable Streams provider did not expose physical compaction with a 410 discarded-offset response" >&2
  exit 1
fi
