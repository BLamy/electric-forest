#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
evidence="$root/.eforest/tasks/epic-1-the-trunk/E1-T09-fast-forward-merge/evidence/e1-t09-sensitivity.md"
update=0
if [ "${1:-}" = "--update-evidence" ]; then update=1; fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/eforest-e1-t09-sensitivity.XXXXXX")
cleanup() {
  if git -C "$root" worktree remove --force "$scratch" >/dev/null 2>&1; then :; fi
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$scratch" HEAD >/dev/null
ln -s "$root/node_modules" "$scratch/node_modules"

run_red() {
  name=$1
  file=$2
  expression=$3
  output="$scratch/$name.log"
  perl -0pi -e "$expression" "$scratch/$file"
  if (cd "$scratch" && CI=true pnpm --silent vitest run packages/streamfs/test/merge-ff.test.ts >"$output" 2>&1); then
    echo "$name: FAILED TO TURN THE SUITE RED" >&2
    cat "$output" >&2
    exit 1
  fi
  printf '%s\n' "$name: suite-red"
}

lines=(
  "RUN bash tools/verify/merge_sensitivity.sh --update-evidence"
  "golden byte flip: node tools/verify/merge_replay_attacks.mjs -> red on one-byte mergedThroughOffset mutation"
)
run_red "not-advanced-check" "packages/streamfs/src/server.ts" \
  's/if \(targetRecords\.some\(\(record\) => compareOffsets\(record\.offset, payload\.forkOffset\) > 0\)\) \{/if (false) {/' \
  >>"$scratch/sensitivity-lines"
lines+=("$(cat "$scratch/sensitivity-lines")")
run_red "exclusive-endpoint" "packages/streamfs/src/resolve.ts" \
  's/compareOffsets\(sourceRecord\.offset, event\.payload\.mergedThroughOffset\) <= 0/compareOffsets(sourceRecord.offset, event.payload.mergedThroughOffset) < 0/' \
  >>"$scratch/sensitivity-lines"
lines+=("$(tail -n 1 "$scratch/sensitivity-lines")")

body=$(printf '%s\n' "${lines[@]}")
if [ "$update" -eq 1 ]; then
  printf '%s' "$body" >"$evidence"
elif [ ! -f "$evidence" ] || [ "$(cat "$evidence")"$'\n' != "$body" ]; then
  echo "frozen evidence mismatch: $evidence" >&2
  exit 1
fi
printf '%s' "$body"
