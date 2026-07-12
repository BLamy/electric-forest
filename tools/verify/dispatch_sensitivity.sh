#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

evidence_dir=".eforest/tasks/epic-0-the-seed/E0-T11-validated-dispatch/evidence"
mkdir -p "$evidence_dir"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-dispatch-sensitivity.XXXXXX")"
output="$(mktemp "${TMPDIR:-/tmp}/eforest-dispatch-sensitivity-output.XXXXXX")"
cleanup() {
  rm -f "$output"
  git worktree remove --force "$scratch"
}
trap cleanup EXIT

git worktree add --detach "$scratch" HEAD
ln -s "$repo_root/node_modules" "$scratch/node_modules"
python3 - "$scratch/packages/server/src/dispatch.ts" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
needle = "  const action = schemaValidate(body);\n"
replacement = '  const action = { type: "set", payload: 0, ts: 0 } as Event;\n'
if source.count(needle) != 1:
    raise SystemExit("sensitivity mutation found an unexpected dispatch validation shape")
path.write_text(source.replace(needle, replacement))
PY

set +e
CI=true pnpm --dir "$scratch" exec vitest run \
  packages/server/src/dispatch.test.ts packages/server/src/dispatch.fuzz.test.ts > "$output" 2>&1
status=$?
set -e
{
  echo "E0-T11 sensitivity proof"
  echo "Mutation: replaced schemaValidate(body) with an unconditional set action in a detached worktree."
  echo "Command: CI=true pnpm exec vitest run packages/server/src/dispatch.test.ts packages/server/src/dispatch.fuzz.test.ts"
  echo "Expected: invalid-dispatch tests go red."
  echo "Observed exit=$status"
  echo "Failure summary:"
  awk '/Failed Tests|Test Files|Tests [0-9]+ failed|AssertionError|^[[:space:]]*❯/{ gsub(/[0-9]+ms/, "<timing>"); print }' "$output"
  echo
} > "$evidence_dir/e0-t11-sensitivity.md"
if [ "$status" -eq 0 ]; then
  echo "dispatch sensitivity: sabotage stayed green" >&2
  exit 1
fi
echo "dispatch sensitivity: OK (sabotage exited $status)"
