#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
working_tree=0
if [ "${1:-}" = "--working-tree" ]; then working_tree=1; shift; fi
if [ "$#" -ne 0 ]; then
  echo "usage: tools/verify/e2_t06_no_database_sensitivity.sh [--working-tree]" >&2
  exit 2
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e2-t06-no-db.XXXXXX")"
output="$(mktemp "${TMPDIR:-/tmp}/eforest-e2-t06-no-db-output.XXXXXX")"
cleanup() {
  if ! git -C "$root" worktree remove --force "$scratch" >/dev/null 2>&1; then :; fi
  rm -f "$output"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$scratch" HEAD >/dev/null
ln -s "$root/node_modules" "$scratch/node_modules"
if [ "$working_tree" -eq 1 ]; then
  git -C "$root" diff --binary HEAD -- | git -C "$scratch" apply --whitespace=nowarn
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    mkdir -p "$scratch/$(dirname "$path")"
    cp "$root/$path" "$scratch/$path"
  done < <(git -C "$root" ls-files --others --exclude-standard)
fi
printf '\nimport * as filesystemCapability from "node:fs";\nexport const factoryState = (() => [])();\nexport const libraryFactoryState = Array.from([]);\nexport function writeSideFile(): void {\n  const copy = Reflect.get(filesystemCapability, "copyFileSync") as typeof filesystemCapability.copyFileSync;\n  copy("/tmp/e2-t06-source", "/tmp/e2-t06-side-table");\n}\nexport function ambientSideFile(): void {\n  const ambientFs = process.getBuiltinModule("node:fs");\n  ambientFs.writeFileSync("/tmp/e2-t06-side-table", "side state");\n}\n' >> "$scratch/packages/platform/src/ns/reducer.ts"
printf 'export const hiddenState = [];\n' > "$scratch/packages/platform/src/ns/side-channel.js"
set +e
node "$scratch/tools/verify/e2_t06_no_database.mjs" --check-only >"$output" 2>&1
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "E2-T06 no-database sabotage stayed green" >&2
  exit 1
fi
if ! grep -q 'UNALLOWLISTED packages/platform/src/ns/reducer.ts:.*:namespace-runtime-import' "$output"; then
  echo "E2-T06 filesystem capability sabotage failed through the architectural import boundary" >&2
  cat "$output" >&2
  exit 1
fi
if ! grep -q 'UNALLOWLISTED packages/platform/src/ns/reducer.ts:.*:namespace-ambient-capability' "$output"; then
  echo "E2-T06 ambient capability sabotage escaped the architectural boundary" >&2
  cat "$output" >&2
  exit 1
fi
if ! grep -q 'UNALLOWLISTED packages/platform/src/ns/side-channel.js:1:namespace-source-shape' "$output"; then
  echo "E2-T06 non-TypeScript namespace source escaped the architectural boundary" >&2
  cat "$output" >&2
  exit 1
fi
state_count="$(awk '/UNALLOWLISTED packages\/platform\/src\/ns\/reducer\.ts:.*:namespace-module-state/ { count++ } END { print count + 0 }' "$output")"
if [ "$state_count" -lt 2 ]; then
  echo "E2-T06 factory-created module state escaped the architectural state boundary" >&2
  cat "$output" >&2
  exit 1
fi
echo "E2_T06_NAMESPACE_BOUNDARY_SENSITIVITY_OK invariants=no-module-state,no-unapproved-runtime-capability,typescript-only-source state_rejections=$state_count exit=$status"
