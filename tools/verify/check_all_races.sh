#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
count=0
for dump in packages/server/work/race-[0-9]*-dump.jsonl; do
  if [ ! -f "$dump" ]; then continue; fi
  attempts="${dump%-dump.jsonl}-attempts.json"
  node tools/verify/check_race.mjs "$dump" "$attempts" --replay
  count=$((count + 1))
done
if [ "$count" -ne 20 ]; then
  echo "check_all_races: expected 20 persisted race runs, found $count" >&2
  exit 1
fi
echo "check_all_races: $count race runs passed"
