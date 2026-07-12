#!/usr/bin/env bash
set -euo pipefail

hits=""
if hits="$(grep -rn 'replay(\|reduceStep(' packages/server/src --include='*.ts')"; then
  :
fi

expected='packages/server/src/redux/routes.ts:'
if [ -z "${hits}" ]; then
  echo "redux replay path check: no protocol replay call found" >&2
  exit 1
fi
while IFS= read -r hit; do
  case "${hit}" in
    "${expected}"*|packages/server/src/redux.integration.test.ts:*) ;;
    *) echo "redux replay path check: unapproved state fold: ${hit}" >&2; exit 1 ;;
  esac
done <<<"${hits}"
count="$(printf '%s\n' "${hits}" | wc -l | tr -d ' ')"
[ "${count}" -eq 2 ]
echo "redux replay path check: ${hits}"
