#!/usr/bin/env bash
# E2-T06 storage-detector sensitivity: prove the structural no-database sweep
# attributes red to the sabotage, not to harness breakage.
#
# Every case runs in a detached disposable worktree. The runtime-boundary
# manifest is regenerated inside each worktree first — exactly what a
# sabotaging builder would do — so a red verdict can only come from the
# structural detector itself, never from manifest byte drift. A zero-mutation
# control must be GREEN before any sabotage runs, and each sabotage must fail
# with the exact predicted finding class on the exact mutated file.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
working_tree=0
if [ "${1:-}" = "--working-tree" ]; then working_tree=1; shift; fi
if [ "$#" -ne 0 ]; then
  echo "usage: tools/verify/e2_t06_no_database_sensitivity.sh [--working-tree]" >&2
  exit 2
fi

output="$(mktemp "${TMPDIR:-/tmp}/eforest-e2-t06-storage-output.XXXXXX")"
scratch=""
cleanup() {
  if [ -n "$scratch" ]; then
    if ! git -C "$root" worktree remove --force "$scratch" >/dev/null 2>&1; then :; fi
  fi
  rm -f "$output"
}
trap cleanup EXIT

manifest_rel=".eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces/evidence/e2-t06-runtime-boundary.sha256"

prepare_worktree() {
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e2-t06-storage.XXXXXX")"
  git -C "$root" worktree add --detach "$scratch" HEAD >/dev/null
  if [ "$working_tree" -eq 1 ]; then
    git -C "$root" diff --binary HEAD -- | git -C "$scratch" apply --whitespace=nowarn --allow-empty
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$scratch/$(dirname "$path")"
      cp "$root/$path" "$scratch/$path"
    done < <(git -C "$root" ls-files --others --exclude-standard)
  fi
  ln -s "$root/node_modules" "$scratch/node_modules"
}

regenerate_manifest() {
  (
    cd "$scratch"
    awk '{print $2}' "$manifest_rel" | while IFS= read -r path; do
      shasum -a 256 "$path"
    done >"$manifest_rel.regen"
    mv "$manifest_rel.regen" "$manifest_rel"
  )
}

drop_worktree() {
  git -C "$root" worktree remove --force "$scratch" >/dev/null
  scratch=""
}

# --- GREEN control: zero mutation must pass -------------------------------
prepare_worktree
regenerate_manifest
if ! (cd "$scratch" && node tools/verify/e2_t06_no_database.mjs --check-only >"$output" 2>&1); then
  echo "E2-T06 storage sensitivity: zero-mutation control went RED (harness is broken)" >&2
  cat "$output" >&2
  exit 1
fi
if ! grep -q "E2_T06_NO_DATABASE_OK" "$output"; then
  echo "E2-T06 storage sensitivity: control run missing E2_T06_NO_DATABASE_OK" >&2
  exit 1
fi
echo "control: zero-mutation GREEN"
drop_worktree

# run_case <label> <python-mutation> <expected-grep-1> [expected-grep-2 ...]
run_case() {
  local label="$1"
  local mutation="$2"
  shift 2
  prepare_worktree
  python3 - "$scratch" "$mutation" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
mutation = sys.argv[2]

def append(path: str, text: str) -> None:
    file = root / path
    file.write_text(file.read_text() + text)

if mutation == "dispatch-side-table":
    # Judge round 8: an ordinary module-lifetime side table in the parent
    # decision layer, plus the populate call.
    append(
        "packages/platform/src/ns/dispatch.ts",
        "\nexport const namespaceSideTable: Record<string, unknown> = Object.create(null);\n"
        'namespaceSideTable["last-created"] = "sabotage";\n',
    )
elif mutation == "index-side-table":
    # Judge round 8: Object.create(null) side table plus a copyFileSync
    # side-file writer in packages/platform/src/index.ts.
    append(
        "packages/platform/src/index.ts",
        '\nimport { copyFileSync } from "node:fs";\n'
        "export const namespaceIndexCache: Record<string, unknown> = Object.create(null);\n"
        'copyFileSync("/tmp/e2-t06-source", "/tmp/e2-t06-side-table");\n',
    )
elif mutation == "official-side-table":
    # Judge round 8: the same pair in the live OfficialStreamAdapter module.
    append(
        "packages/platform/src/official.ts",
        '\nimport { copyFileSync } from "node:fs";\n'
        "export const officialSideTable: Record<string, unknown> = Object.create(null);\n"
        'copyFileSync("/tmp/e2-t06-source", "/tmp/e2-t06-official-side-table");\n',
    )
elif mutation == "factory-containers":
    # Judge round 6: factory-created module state that no spelling rule named.
    append(
        "packages/platform/src/gateway.ts",
        "\nexport const gatewayLedgerA = (() => [] as unknown[])();\n"
        "export const gatewayLedgerB = Array.from([] as unknown[]);\n",
    )
elif mutation == "deferred-assignment":
    # Judge round 5: deferred module-level container assignment.
    append(
        "packages/platform/src/namespace-runtime.ts",
        "\nexport let deferredNamespaceLedger: unknown[];\ndeferredNamespaceLedger = [];\n",
    )
elif mutation == "reflected-filesystem":
    # Judge rounds 6/8: reach a filesystem mutator through Reflect.get — the
    # import itself is the capability tell, however members are reached.
    append(
        "packages/platform/src/production.ts",
        '\nimport * as sideFs from "node:fs";\n'
        'const copyTool = Reflect.get(sideFs, "copyFileSync") as (a: string, b: string) => void;\n'
        'copyTool("/tmp/e2-t06-source", "/tmp/e2-t06-reflected");\n',
    )
else:
    raise SystemExit(f"unknown storage sabotage: {mutation}")
PY
  regenerate_manifest
  set +e
  (cd "$scratch" && node tools/verify/e2_t06_no_database.mjs --check-only >"$output" 2>&1)
  local status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "E2-T06 storage sabotage '$label' stayed GREEN" >&2
    cat "$output" >&2
    exit 1
  fi
  local expected
  for expected in "$@"; do
    if ! grep -Eq "$expected" "$output"; then
      echo "E2-T06 storage sabotage '$label' went red WITHOUT the predicted finding: $expected" >&2
      cat "$output" >&2
      exit 1
    fi
  done
  echo "$label: expected-red with attributed findings"
  drop_worktree
}

run_case "dispatch-side-table" dispatch-side-table \
  'UNALLOWLISTED packages/platform/src/ns/dispatch\.ts:[0-9]+:module-scope-state' \
  'UNALLOWLISTED packages/platform/src/ns/dispatch\.ts:[0-9]+:module-scope-execution'
run_case "index-side-table" index-side-table \
  'UNALLOWLISTED packages/platform/src/index\.ts:[0-9]+:capability-import' \
  'UNALLOWLISTED packages/platform/src/index\.ts:[0-9]+:module-scope-state' \
  'UNALLOWLISTED packages/platform/src/index\.ts:[0-9]+:module-scope-execution' \
  'UNALLOWLISTED packages/platform/src/index\.ts:[0-9]+:filesystem-write'
run_case "official-side-table" official-side-table \
  'UNALLOWLISTED packages/platform/src/official\.ts:[0-9]+:capability-import' \
  'UNALLOWLISTED packages/platform/src/official\.ts:[0-9]+:module-scope-state' \
  'UNALLOWLISTED packages/platform/src/official\.ts:[0-9]+:filesystem-write'
run_case "factory-containers" factory-containers \
  'UNALLOWLISTED packages/platform/src/gateway\.ts:[0-9]+:module-scope-state'
run_case "deferred-assignment" deferred-assignment \
  'UNALLOWLISTED packages/platform/src/namespace-runtime\.ts:[0-9]+:module-scope-mutable-binding' \
  'UNALLOWLISTED packages/platform/src/namespace-runtime\.ts:[0-9]+:module-scope-execution'
run_case "reflected-filesystem" reflected-filesystem \
  'UNALLOWLISTED packages/platform/src/production\.ts:[0-9]+:capability-import' \
  'UNALLOWLISTED packages/platform/src/production\.ts:[0-9]+:module-scope-execution'

# The VM/permission runtime-boundary sabotages remain part of this proof.
node "$root/tools/verify/e2_t06_runtime_boundary_sensitivity.mjs"

echo "E2_T06_NO_DATABASE_SENSITIVITY_OK control=green cases=6 runtime-boundary=red"
