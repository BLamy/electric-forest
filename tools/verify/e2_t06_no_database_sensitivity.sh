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
printf '\n// E2-T06 sabotage: better-sqlite3\nimport * as fs from "node:fs";\nimport * as hiddenFs from "node:fs";\nexport const namespaceCache: Record<string, unknown> = Object.create(null);\nexport const namespaceLedger: unknown[] = [];\nexport const namespaceEntries = new Set<string>();\nexport const namespaceLedgerViaCall = Array<unknown>();\nexport class NamespaceSideTable { static entries: unknown[] = []; }\nexport let deferredNamespaceLedger: unknown[];\ndeferredNamespaceLedger = [];\nexport let fallbackNamespaceLedger: unknown[] | undefined;\nfallbackNamespaceLedger ??= [];\nexport let lazyNamespaceLedger: unknown[] | undefined;\nlazyNamespaceLedger ||= [];\nexport const globalNamespaceLedger = new globalThis.Map<string, unknown>();\nexport const computedGlobalNamespaceLedger = new globalThis["Set"]<string>();\nconst filesystemAlias = fs;\nconst { cpSync: copySideFile } = fs;\nlet deferredFsAlias: typeof fs;\ndeferredFsAlias = fs;\nlet deferredFsMutation: typeof fs.renameSync;\ndeferredFsMutation = fs["renameSync"];\nvoid copyFileSync("/tmp/e2-t06-source", "/tmp/e2-t06-side-table");\nvoid fs.cpSync("/tmp/e2-t06-source", "/tmp/e2-t06-side-table-2");\nvoid filesystemAlias.rmSync("/tmp/e2-t06-side-table-3");\nvoid copySideFile("/tmp/e2-t06-source", "/tmp/e2-t06-side-table-4");\nvoid hiddenFs["cpSync"]("/tmp/e2-t06-source", "/tmp/e2-t06-side-table-5");\nvoid deferredFsAlias["rmSync"]("/tmp/e2-t06-side-table-6");\nvoid deferredFsMutation("/tmp/e2-t06-source", "/tmp/e2-t06-side-table-7");\n' >> "$scratch/packages/platform/src/ns/reducer.ts"
set +e
node "$scratch/tools/verify/e2_t06_no_database.mjs" --check-only >"$output" 2>&1
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "E2-T06 no-database sabotage stayed green" >&2
  exit 1
fi
if ! grep -q 'UNALLOWLISTED packages/platform/src/ns/reducer.ts:.*:database-package' "$output"; then
  echo "E2-T06 no-database sabotage failed through the wrong sensor" >&2
  cat "$output" >&2
  exit 1
fi
mutable_count="$(awk '/UNALLOWLISTED packages\/platform\/src\/ns\/reducer\.ts:.*:mutable-object/ { count++ } END { print count + 0 }' "$output")"
if [ "$mutable_count" -lt 10 ]; then
  echo "E2-T06 module-scope container sabotages failed through the wrong sensor" >&2
  cat "$output" >&2
  exit 1
fi
filesystem_count="$(awk '/UNALLOWLISTED packages\/platform\/src\/ns\/reducer\.ts:.*:filesystem-write/ { count++ } END { print count + 0 }' "$output")"
if [ "$filesystem_count" -lt 7 ]; then
  echo "E2-T06 bare and namespace filesystem sabotages failed through the wrong sensor" >&2
  cat "$output" >&2
  exit 1
fi
echo "E2_T06_NO_DATABASE_SENSITIVITY_OK mutations=better-sqlite3,Object.create(null),array,Set,Array(),class-static-array,deferred-array,nullish-array,or-array,globalThis.Map,globalThis-computed-Set,copyFileSync,fs.cpSync,fs-alias.rmSync,destructured-cpSync,computed-fs-cpSync,deferred-fs-alias,deferred-fs-mutator exit=$status"
