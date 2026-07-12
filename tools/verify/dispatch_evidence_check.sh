#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

evidence_dir=".eforest/tasks/epic-0-the-seed/E0-T11-validated-dispatch/evidence"
neutrality="$evidence_dir/e0-t11-refusal-neutrality.txt"
fuzz="$evidence_dir/e0-t11-fuzz.txt"
sensitivity="$evidence_dir/e0-t11-sensitivity.md"
append_callsites="$evidence_dir/e0-t11-append-callsites.txt"

for file in "$neutrality" "$fuzz" "$sensitivity" "$append_callsites"; do
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
if ! awk 'NR > 1 && ($3 != $4 || $5 != $6) { bad=1 } END { exit bad }' "$neutrality"; then
  echo "dispatch evidence contains a non-neutral refusal" >&2
  exit 1
fi
grep -q '^cases=520$' "$fuzz"
grep -q '^object-prototype-polluted=false$' "$fuzz"
grep -q 'Result: exactly one direct StreamStore.append invocation' "$append_callsites"
grep -q 'exit=1' "$sensitivity"

echo "dispatch evidence: OK"
