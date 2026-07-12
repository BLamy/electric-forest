#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

purity_command="grep -rnE --exclude='*.test.ts' --exclude='fs.ts' \"Math\\.random|Date\\.now|process\\.env|(from ['\"]|require\\(['\"]|import\\(['\"])(node:)?(fs|net|http|child_process)['\"]/?\" packages/streamfs/src"
set +e
purity_output="$(grep -rnE --exclude='*.test.ts' --exclude='fs.ts' "Math\.random|Date\.now|process\.env|(from ['\"]|require\(['\"]|import\(['\"])(node:)?(fs|net|http|child_process)['\"]/?" packages/streamfs/src)"
purity_status=$?
set -e
if [ "$purity_status" -gt 1 ]; then
  echo "streamfs purity: grep failed" >&2
  exit 1
fi
if [ -n "$purity_output" ]; then
  printf '%s\n' "$purity_output" >&2
  echo "streamfs purity: forbidden impurity found" >&2
  exit 1
fi

closure_command="grep -rnE --include='*.ts' --exclude='fs.ts' --exclude='*.test.ts' \"from ['\"]\\./fs['\"]|require\\(['\"]\\./fs|import\\(['\"]\\./fs\" packages/streamfs/src"
set +e
closure_output="$(grep -rnE --include='*.ts' --exclude='fs.ts' --exclude='*.test.ts' "from ['\"]\./fs['\"]|require\(['\"]\./fs|import\(['\"]\./fs" packages/streamfs/src)"
closure_status=$?
set -e
if [ "$closure_status" -gt 1 ]; then
  echo "streamfs purity: closure grep failed" >&2
  exit 1
fi
if [ -n "$closure_output" ]; then
  printf '%s\n' "$closure_output" >&2
  echo "streamfs purity: reducer closure imports fs.ts" >&2
  exit 1
fi

golden=".eforest/tasks/epic-1-the-trunk/E1-T01-streamfs-core-tree-digest/evidence/golden-fs.jsonl"
reducer="$PWD/packages/streamfs/reducer.mjs"
digest_default="$(node packages/cli/dist/src/bin.js replay "$golden" --digest --reducer "$reducer")"
digest_env="$(TZ=Pacific/Kiritimati LANG=C node packages/cli/dist/src/bin.js replay "$golden" --digest --reducer "$reducer")"
[ "$digest_default" = "$digest_env" ]
echo "streamfs purity: exact impurity command empty; exact closure command empty; default=$digest_default env=$digest_env OK"
