#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
evidence=".eforest/tasks/epic-0-the-seed/E0-T12-ef-bisect/evidence/e0-t12-sensitivity.md"
output="$(mktemp "${TMPDIR:-/tmp}/eforest-bisect-sensitivity-output.XXXXXX")"
cleanup() { rm -f "$output"; }
trap cleanup EXIT

run_mutation() {
  local label="$1"
  local mutation="$2"
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-bisect-sensitivity.XXXXXX")"
  git worktree add --detach "$scratch" HEAD >/dev/null
  ln -s "$repo_root/node_modules" "$scratch/node_modules"
  python3 - "$scratch/packages/cli/src/bisect-command.ts" "$mutation" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
mutation = sys.argv[2]
source = path.read_text()
needle = "      aPrefixes[length] === bPrefixes[length]"
if source.count(needle) != 1:
    raise SystemExit("bisect sensitivity anchor missing or duplicated")
if mutation == "linear":
    replacement = '''      a.slice(0, length).every((record, index) => {
        rawPrefixComparisons += 1;
        return canonicalRecord(record) === canonicalRecord(b[index]!);
      })'''
elif mutation == "digest-only":
    replacement = "      true"
else:
    raise SystemExit(f"unknown mutation: {mutation}")
path.write_text(source.replace(needle, replacement))
PY

  set +e
  CI=true pnpm --dir "$scratch" exec vitest run packages/cli/src/bisect.test.ts >"$output" 2>&1
  local status=$?
  set -e
  git worktree remove --force "$scratch" >/dev/null
  if [ "$status" -eq 0 ]; then
    echo "bisect sensitivity: $label sabotage stayed green" >&2
    exit 1
  fi
  {
    echo "- $label sabotage: expected red, observed exit=$status"
    awk '/Failed Tests|Test Files|Tests [0-9]+ failed|AssertionError|^[[:space:]]*❯/{ gsub(/[0-9]+ms/, "<timing>"); print }' "$output"
  } >> "$evidence"
  echo "bisect sensitivity: $label sabotage red (exit=$status)"
}

{
  echo "E0-T12 sensitivity proof"
  echo "Command: detached worktree vitest run packages/cli/src/bisect.test.ts"
  echo "Expected: both search-mechanism sabotages fail the committed tests."
} > "$evidence"
run_mutation "linear raw-prefix scan" linear
run_mutation "digest-only search" digest-only
