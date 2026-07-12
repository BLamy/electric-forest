#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

target="packages/server/src/store/memory.ts"
backup="$(mktemp)"
trap 'cp "$backup" "$target"; rm -f "$backup"' EXIT
cp "$target" "$backup"

mutate() {
  local from="$1" to="$2"
  node --input-type=module - "$target" "$from" "$to" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [path, from, to] = process.argv.slice(2);
const source = readFileSync(path, "utf8");
if (!source.includes(from)) throw new Error(`mutation target not found: ${from}`);
writeFileSync(path, source.replace(from, to));
NODE
}

run_red_test() {
  local name="$1"
  local log="$(mktemp)"
  set +e
  CI=true pnpm exec vitest run packages/server/src/http.integration.test.ts >"$log" 2>&1
  local status="$?"
  set -e
  if [ "$status" -eq 0 ]; then
    cat "$log"
    rm -f "$log"
    echo "sabotage ${name}: FAILED — mutation unexpectedly passed" >&2
    exit 1
  fi
  echo "sabotage ${name}: RED (vitest exit ${status})"
  tail -n 3 "$log"
  rm -f "$log"
  cp "$backup" "$target"
}

mutate 'if (sequence <= stream.sequence)' 'if (sequence === stream.sequence)'
run_red_test stale-positive-fencing

mutate 'compareOffsets(record.offset, after) > 0' 'compareOffsets(record.offset, after) >= 0'
run_red_test strict-after-offset

mutate 'if (existing.config !== canonicalConfig)' 'if (false)'
run_red_test config-conflict

echo "sabotage-E0-T05: all three mutations were detected by the integration apparatus"
