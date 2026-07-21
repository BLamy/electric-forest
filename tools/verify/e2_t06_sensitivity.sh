#!/usr/bin/env bash
# E2-T06 behavioral sensitivity: sabotage the uniqueness validator and the
# payload-owner trust boundary, and prove the committed suite goes red for the
# attributable reason.
#
# The namespace child executes compiled dist/, so every worktree — including
# the zero-mutation control — REBUILDS the full compiled graph before running
# the suite; a mutation that never reaches executed code cannot masquerade as
# a sensor. Attribution is by parsed vitest JSON results: the control must
# pass every test, and each sabotage must fail EXACTLY its predicted test set
# while every other test stays green.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
evidence="$root/.eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces/evidence/e2-t06-sensitivity.md"
update=0
if [ "${1:-}" = "--update-evidence" ]; then update=1; shift; fi
working_tree=0
if [ "${1:-}" = "--working-tree" ]; then working_tree=1; shift; fi
if [ "$#" -ne 0 ]; then
  echo "usage: tools/verify/e2_t06_sensitivity.sh [--update-evidence] [--working-tree]" >&2
  exit 2
fi
transcript="$(mktemp "${TMPDIR:-/tmp}/eforest-e2-t06-sensitivity.XXXXXX")"
output="$(mktemp "${TMPDIR:-/tmp}/eforest-e2-t06-sensitivity-output.XXXXXX")"
results="$(mktemp "${TMPDIR:-/tmp}/eforest-e2-t06-sensitivity-results.XXXXXX")"
scratch=""
cleanup() {
  if [ -n "$scratch" ]; then
    if ! git -C "$root" worktree remove --force "$scratch" >/dev/null 2>&1; then :; fi
  fi
  rm -f "$transcript" "$output" "$results"
}
trap cleanup EXIT

{
  echo '# E2-T06 sensitivity proof'
  echo
  echo 'Each run uses a detached disposable worktree at the exact source snapshot and'
  echo 'rebuilds the full compiled graph inside it (the namespace child executes dist/,'
  echo 'so a mutation must reach compiled code to count). A zero-mutation control must'
  echo 'pass every test before any sabotage is attributed, and each sabotage must fail'
  echo 'exactly its named sensor tests — parsed from vitest JSON results, not grepped'
  echo 'from stdout. Normal verification never modifies this evidence file.'
  echo
} >"$transcript"

# Recreate a node_modules directory inside the scratch worktree. Workspace
# (@eforest) links are re-anchored so they resolve to the SCRATCH packages —
# symlinking node_modules wholesale would make @eforest/* resolve back into
# the primary checkout and type-check (and execute) unmutated code.
link_node_modules() {
  local source_dir="$1" target_dir="$2"
  mkdir -p "$target_dir"
  local entry name sub
  for entry in "$source_dir"/* "$source_dir"/.[!.]*; do
    { [ -e "$entry" ] || [ -L "$entry" ]; } || continue
    name="$(basename "$entry")"
    if [ "$name" = "@eforest" ]; then
      mkdir -p "$target_dir/@eforest"
      for sub in "$entry"/*; do
        { [ -e "$sub" ] || [ -L "$sub" ]; } || continue
        if [ -L "$sub" ]; then
          ln -s "$(readlink "$sub")" "$target_dir/@eforest/$(basename "$sub")"
        else
          ln -s "$sub" "$target_dir/@eforest/$(basename "$sub")"
        fi
      done
    elif [ -L "$entry" ]; then
      ln -s "$(readlink "$entry")" "$target_dir/$name"
    else
      ln -s "$entry" "$target_dir/$name"
    fi
  done
}

prepare_worktree() {
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e2-t06-sensitivity.XXXXXX")"
  git -C "$root" worktree add --detach "$scratch" HEAD >/dev/null 2>&1
  if [ "$working_tree" -eq 1 ]; then
    git -C "$root" diff --binary HEAD -- | git -C "$scratch" apply --whitespace=nowarn --allow-empty
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$scratch/$(dirname "$path")"
      cp "$root/$path" "$scratch/$path"
    done < <(git -C "$root" ls-files --others --exclude-standard)
  fi
  link_node_modules "$root/node_modules" "$scratch/node_modules"
  for package_modules in "$root"/packages/*/node_modules; do
    [ -d "$package_modules" ] || continue
    package_name="$(basename "$(dirname "$package_modules")")"
    link_node_modules "$package_modules" "$scratch/packages/$package_name/node_modules"
  done
  if ! (cd "$scratch" && CI=true pnpm run build >"$output" 2>&1); then
    echo "E2-T06 sensitivity: worktree build failed" >&2
    cat "$output" >&2
    exit 1
  fi
}

drop_worktree() {
  git -C "$root" worktree remove --force "$scratch" >/dev/null
  scratch=""
}

# run_suite → writes vitest JSON to $results; returns vitest exit status.
run_suite() {
  set +e
  (
    cd "$scratch" &&
      CI=true pnpm exec vitest run --reporter=json --outputFile="$results" \
        packages/platform/test/ns.test.ts
  ) >"$output" 2>&1
  suite_status=$?
  set -e
}

# assert_failures <label> <expected-failed-titles-newline-separated>
assert_failures() {
  local label="$1"
  local expected="$2"
  python3 - "$results" "$label" "$expected" <<'PY'
import json
import sys

results_path, label, expected_raw = sys.argv[1], sys.argv[2], sys.argv[3]
expected = sorted(t for t in expected_raw.strip().splitlines() if t.strip())
report = json.load(open(results_path))
statuses = {}
for suite in report.get("testResults", []):
    for test in suite.get("assertionResults", []):
        statuses[test.get("title", "?")] = test.get("status")
failed = sorted(title for title, status in statuses.items() if status == "failed")
not_passed = sorted(
    title for title, status in statuses.items() if status not in ("passed", "failed")
)
if not_passed:
    print(f"E2-T06 sensitivity {label}: tests neither passed nor failed: {not_passed}",
          file=sys.stderr)
    raise SystemExit(1)
if failed != expected:
    print(f"E2-T06 sensitivity {label}: failed-test attribution mismatch", file=sys.stderr)
    print(f"  expected failed: {expected}", file=sys.stderr)
    print(f"  observed failed: {failed}", file=sys.stderr)
    raise SystemExit(1)
print(f"{label}: total={len(statuses)} failed={len(failed)} (exact attribution)")
PY
}

# --- GREEN control ---------------------------------------------------------
prepare_worktree
run_suite
if [ "$suite_status" -ne 0 ]; then
  echo "E2-T06 sensitivity: zero-mutation control went RED (harness is broken)" >&2
  cat "$output" >&2
  exit 1
fi
assert_failures "control" ""
control_total="$(python3 -c 'import json,sys;r=json.load(open(sys.argv[1]));print(sum(len(s.get("assertionResults",[])) for s in r.get("testResults",[])))' "$results")"
{
  echo '## zero-mutation control'
  echo
  echo '```text'
  echo 'pnpm run build && pnpm exec vitest run --reporter=json packages/platform/test/ns.test.ts'
  echo "control-green exit=0 tests=$control_total failed=0"
  echo '```'
  echo
  echo 'Result: CONTROL_GREEN'
  echo
} >>"$transcript"
drop_worktree

run_mutation() {
  local label="$1"
  local mutation="$2"
  local expected_failures="$3"
  prepare_worktree
  python3 - "$scratch" "$mutation" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
mutation = sys.argv[2]
if mutation == "uniqueness":
    path = root / "packages/platform/src/ns/dispatch.ts"
    source = path.read_text()
    needle = 'if (Object.hasOwn(root.orgs, name)) throw new NamespaceRefusalError("ns/name-taken");'
    if source.count(needle) != 1:
        raise SystemExit("uniqueness sensitivity anchor missing or duplicated")
    path.write_text(source.replace(needle, 'if (false) throw new NamespaceRefusalError("ns/name-taken");'))
elif mutation == "payload-owner":
    path = root / "packages/platform/src/ns/events.ts"
    source = path.read_text()
    needle1 = 'const actual = (ownKeys as string[]).sort();'
    replacement1 = 'const actual = (ownKeys as string[]).filter((key) => key !== "owner").sort();'
    needle2 = 'return { ...event, payload: { ...(event.payload as object), actor: { sub } } } as NamespaceEvent;'
    replacement2 = '''const supplied = (event.payload as Record<string, unknown>).owner;
  return {
    ...event,
    payload: { ...(event.payload as object), actor: { sub: typeof supplied === "string" ? supplied : sub } },
  } as NamespaceEvent;'''
    if source.count(needle1) != 1 or source.count(needle2) != 1:
        raise SystemExit("owner sensitivity anchor missing or duplicated")
    path.write_text(source.replace(needle1, replacement1).replace(needle2, replacement2))
else:
    raise SystemExit(f"unknown sensitivity mutation: {mutation}")
PY
  # Rebuild so the mutation reaches the compiled code the child executes.
  if ! (cd "$scratch" && CI=true pnpm run build >"$output" 2>&1); then
    echo "E2-T06 sensitivity: mutated worktree build failed for $label" >&2
    cat "$output" >&2
    exit 1
  fi
  run_suite
  if [ "$suite_status" -eq 0 ]; then
    echo "E2-T06 $label sabotage stayed green" >&2
    exit 1
  fi
  assert_failures "$label" "$expected_failures"
  {
    echo "## $label"
    echo
    echo "Mutation: \`$mutation\`."
    echo
    echo '```text'
    echo 'pnpm run build && pnpm exec vitest run --reporter=json packages/platform/test/ns.test.ts'
    echo "expected-red exit=$suite_status"
    echo 'failed tests (exactly, parsed from vitest JSON):'
    while IFS= read -r title; do
      [ -z "$title" ] && continue
      echo "- $title"
    done <<<"$expected_failures"
    echo '```'
    echo
    echo "Result: ${label// /_}_SENSITIVITY_OK"
    echo
  } >>"$transcript"
  drop_worktree
}

run_mutation "uniqueness validator" uniqueness "serializes at least twenty concurrent same-name creates to one winner
freezes validation order and all five log-neutral refusal reasons"
run_mutation "payload owner trust" payload-owner "rejects actor, owner, sub, org, extras, and missing visibility as schema violations"
if [ "$update" -eq 1 ]; then
  cp "$transcript" "$evidence"
else
  cmp -s "$transcript" "$evidence" || {
    echo "E2-T06 sensitivity evidence drifted; regenerate explicitly with --update-evidence" >&2
    if ! diff -u "$evidence" "$transcript" >&2; then :; fi
    exit 1
  }
fi
cat "$transcript"
