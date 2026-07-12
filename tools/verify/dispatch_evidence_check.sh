#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

evidence_dir=".eforest/tasks/epic-0-the-seed/E0-T11-validated-dispatch/evidence"
neutrality="$evidence_dir/e0-t11-refusal-neutrality.txt"
fuzz="$evidence_dir/e0-t11-fuzz.txt"
fuzz_dump="$evidence_dir/e0-t11-fuzz.jsonl"
sensitivity="$evidence_dir/e0-t11-sensitivity.md"
append_callsites="$evidence_dir/e0-t11-append-callsites.txt"

for file in "$neutrality" "$fuzz" "$fuzz_dump" "$sensitivity" "$append_callsites"; do
  if [ ! -s "$file" ]; then
    echo "dispatch evidence missing or empty: $file" >&2
    exit 1
  fi
done

line_count="$(wc -l < "$neutrality" | tr -d ' ')"
if [ "$line_count" -ne 5 ]; then
  echo "dispatch evidence expected header plus four refusal rows, got $line_count" >&2
  exit 1
fi
if ! awk 'NR > 1 && ($3 != $4 || $5 != $6 || $7 != $8) { bad=1 } END { exit bad }' "$neutrality"; then
  echo "dispatch evidence contains a non-neutral refusal" >&2
  exit 1
fi
grep -q '^cases=520$' "$fuzz"
grep -q '^object-prototype-polluted=false$' "$fuzz"
grep -q 'Result: exactly one direct StreamStore.append invocation' "$append_callsites"
grep -q 'exit=1' "$sensitivity"

fuzz_expected="$(awk -F= '$1 == "post-fuzz-state-digest" { print $2; exit }' "$fuzz")"
fuzz_actual="$(CI=true pnpm --silent ef replay "$fuzz_dump" --digest)"
if [ "$fuzz_actual" != "$fuzz_expected" ]; then
  echo "dispatch evidence fuzzer digest disagrees with ef replay --digest" >&2
  echo "expected=$fuzz_expected actual=$fuzz_actual" >&2
  exit 1
fi

for class_name in malformed-body schema-violation unknown-action-type validator-rejected; do
  row="$(awk -v name="$class_name" '$1 == name { print; exit }' "$neutrality")"
  read -r _ status head_before head_after raw_before raw_after replay_before replay_after <<< "$row"
  if [ -z "$row" ] || [ "$head_before" = "" ] || [ "$status" = "" ]; then
    echo "dispatch evidence missing row for $class_name" >&2
    exit 1
  fi
  before_file="$evidence_dir/e0-t11-refusal-neutrality-$class_name-before.jsonl"
  after_file="$evidence_dir/e0-t11-refusal-neutrality-$class_name-after.jsonl"
  actual_before="$(CI=true pnpm --silent ef replay "$before_file" --digest)"
  actual_after="$(CI=true pnpm --silent ef replay "$after_file" --digest)"
  if [ "$actual_before" != "$replay_before" ] || [ "$actual_after" != "$replay_after" ]; then
    echo "dispatch evidence $class_name disagrees with ef replay --digest" >&2
    exit 1
  fi
done

echo "dispatch evidence: OK"
