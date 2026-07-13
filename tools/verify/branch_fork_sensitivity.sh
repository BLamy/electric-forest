#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
evidence_dir=".eforest/tasks/epic-1-the-trunk/E1-T08-branch-fork-cow/evidence"
tmp_output="$(mktemp "${TMPDIR:-/tmp}/eforest-e1-t08-sensitivity.XXXXXX")"
trap 'rm -f "$tmp_output"' EXIT

golden_branch="$evidence_dir/e1-t08-golden-feature.jsonl"
golden_parent="$evidence_dir/e1-t08-golden-main.jsonl"
expected_digest="$(node packages/cli/dist/src/bin.js replay "$golden_branch" --parent "$golden_parent" --digest)"
mutated_dump="$(mktemp "${TMPDIR:-/tmp}/eforest-e1-t08-mutated.XXXXXX.jsonl")"
trap 'rm -f "$tmp_output" "$mutated_dump"' EXIT

cp "$golden_branch" "$mutated_dump"
python3 - "$mutated_dump" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
needle = '"shared-feature"'
if source.count(needle) != 1:
    raise SystemExit("golden mutation anchor missing or duplicated")
path.write_text(source.replace(needle, '"shared-mutated"'))
PY
set +e
mutated_digest="$(node packages/cli/dist/src/bin.js replay "$mutated_dump" --parent "$golden_parent" --digest 2>"$tmp_output")"
mutated_status=$?
set -e
if [ "$mutated_status" -eq 0 ] && [ "$mutated_digest" = "$expected_digest" ]; then
  echo "branch sensitivity: flipped golden byte stayed green" >&2
  exit 1
fi

run_mutation() {
  local label="$1"
  local file="$2"
  local needle="$3"
  local replacement="$4"
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e1-t08-sensitivity-worktree.XXXXXX")"
  git worktree add --detach "$scratch" HEAD >/dev/null
  ln -s "$repo_root/node_modules" "$scratch/node_modules"
  python3 - "$scratch/$file" "$needle" "$replacement" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
needle = sys.argv[2]
replacement = sys.argv[3]
source = path.read_text()
if source.count(needle) != 1:
    raise SystemExit(f"mutation anchor missing or duplicated: {needle}")
path.write_text(source.replace(needle, replacement))
PY
  set +e
  pnpm --dir "$scratch" --silent build >"$tmp_output" 2>&1
  local build_status=$?
  if [ "$build_status" -eq 0 ]; then
    node "$scratch/tools/verify/branch_fork.mjs" >>"$tmp_output" 2>&1
    local verify_status=$?
  else
    local verify_status=$build_status
  fi
  set -e
  git worktree remove --force "$scratch" >/dev/null
  if [ "$verify_status" -eq 0 ]; then
    echo "branch sensitivity: $label sabotage stayed green" >&2
    cat "$tmp_output" >&2
    exit 1
  fi
  echo "- $label: EXPECTED-FAIL exit=$verify_status"
}

{
  echo "# E1-T08 sensitivity proof"
  echo "- golden byte mutation: EXPECTED-FAIL (status=$mutated_status)"
  run_mutation \
    "resolver includes parent events above fork" \
    "packages/streamfs/src/resolve.ts" \
    ": link.fork.payload.forkOffset;" \
    ": undefined;"
  run_mutation \
    "branch writes reuse parent content stream" \
    "packages/streamfs/src/fs.ts" \
    'const inherited = this.branchName !== "main" && !isBranchContentStreamId(file.contentStreamId);' \
    'const inherited = false;'
  run_mutation \
    "emit-log includes fork directive" \
    "packages/cli/src/replay-command.ts" \
    'const records = resolveBranchLog(dumps, options.until) as DumpRecord[];' \
    'const records = dumps.flatMap((dump) => dump.records) as DumpRecord[];'
} > "$evidence_dir/e1-t08-sensitivity.md"

echo "branch sensitivity: golden mutation and three implementation sabotages red"
