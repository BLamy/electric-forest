#!/usr/bin/env bash
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
scratch=""
cleanup() {
  if [ -n "$scratch" ]; then
    if ! git -C "$root" worktree remove --force "$scratch" >/dev/null 2>&1; then :; fi
  fi
  rm -f "$transcript" "$output"
}
trap cleanup EXIT

{
  echo '# E2-T06 sensitivity proof'
  echo
  echo 'Each mutation ran in a detached disposable worktree at the exact source snapshot.'
  echo 'Normal verification never modifies this evidence file.'
  echo
} >"$transcript"

run_mutation() {
  local label="$1"
  local mutation="$2"
  local expected="$3"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e2-t06-sensitivity.XXXXXX")"
  git -C "$root" worktree add --detach "$scratch" HEAD >/dev/null
  if [ "$working_tree" -eq 1 ]; then
    git -C "$root" diff --binary HEAD -- | git -C "$scratch" apply --whitespace=nowarn
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$scratch/$(dirname "$path")"
      cp "$root/$path" "$scratch/$path"
    done < <(git -C "$root" ls-files --others --exclude-standard)
  fi
  ln -s "$root/node_modules" "$scratch/node_modules"
  for package_modules in "$root"/packages/*/node_modules; do
    [ -d "$package_modules" ] || continue
    package_dir="$(dirname "$package_modules")"
    package_name="$(basename "$package_dir")"
    ln -s "$package_modules" "$scratch/packages/$package_name/node_modules"
  done
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
  set +e
  CI=true pnpm --dir "$scratch" exec vitest run packages/platform/test/ns.test.ts >"$output" 2>&1
  local status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "E2-T06 $label sabotage stayed green" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$output"; then
    echo "E2-T06 $label failed through the wrong sensor" >&2
    cat "$output" >&2
    exit 1
  fi
  {
    echo "## $label"
    echo
    echo "Mutation: \`$mutation\`."
    echo
    echo '```text'
    echo 'pnpm exec vitest run packages/platform/test/ns.test.ts'
    echo "expected-red exit=$status sensor=$expected"
    echo '```'
    echo
    echo "Result: ${label// /_}_SENSITIVITY_OK"
    echo
  } >>"$transcript"
  git -C "$root" worktree remove --force "$scratch" >/dev/null
  scratch=""
}

run_mutation "uniqueness validator" uniqueness "serializes at least twenty concurrent"
run_mutation "payload owner trust" payload-owner "rejects actor, owner, sub"
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
