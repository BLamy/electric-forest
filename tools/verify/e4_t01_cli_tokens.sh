#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
BASE=$(git -C "$ROOT" merge-base HEAD origin/codex/e3-t10-reading-room)
PATTERN='createHash|crypto\.subtle|sha-?256|JSON\.stringify|sort_keys|\.sort[[:space:]]*\('

printf "BASE: %s\n" "$BASE"
printf "COMMAND: grep -Ein '%s' packages/cli/src/worktree-command.ts\n" "$PATTERN"
if grep -Ein "$PATTERN" "$ROOT/packages/cli/src/worktree-command.ts"; then
  exit 1
else
  status=$?
  [ "$status" -eq 1 ] || exit "$status"
fi
printf "OUTPUT: (empty)\n"

printf "COMMAND: git diff --unified=0 %s..HEAD -- packages/cli/src | grep -E '^\\+' | grep -v '^\\+\\+\\+' | grep -Ein '%s'\n" "$BASE" "$PATTERN"
diff_output=$(git -C "$ROOT" diff --unified=0 "$BASE..HEAD" -- packages/cli/src)
status=$?
[ "$status" -eq 0 ] || exit "$status"
set +e
matches=$(printf "%s\n" "$diff_output" \
  | grep -E '^\\+' \
  | grep -v '^\\+\\+\\+' \
  | grep -Ein "$PATTERN")
status=$?
set -e
[ "$status" -le 1 ] || exit "$status"
if [ -n "$matches" ]; then
  printf "%s\n" "$matches"
  exit 1
fi
printf "OUTPUT: (empty)\n"
