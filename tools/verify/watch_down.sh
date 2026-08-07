#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${repo_root}"

CI=true pnpm exec vitest run --maxWorkers=1 packages/cli/test/downlink.test.ts
node tools/verify/e4_t07_watch_down.mjs
node tools/verify/e4_t07_stream_proof_sensitivity.mjs
node tools/verify/e4_t07_kill_resume.mjs

if grep -En "appendDurableJson|appendDurableJsonBatch|dispatchToStream|\.dispatch\(" packages/cli/src/sync/downlink.ts; then
  echo "watch_down: downlink contains a server mutation path" >&2
  exit 1
fi

test -f packages/cli/src/sync/apply-journal.ts
test -f packages/cli/src/sync/downlink.ts
test -f tools/verify/e4_t07_watch_down.mjs
echo "watch_down: unit, crash-recovery, live-tail, read-only, and journal checks passed"
