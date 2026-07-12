#!/usr/bin/env bash
# `make verify-list` (ported from wasm-vm via the figma-clone): print the
# target↔task map across ALL epics and FAIL if any task whose frontmatter status is
# `implemented` or `verified` lacks a `verify-E<n>-T<nn>` Makefile target. Pending
# tasks are listed (target column `(pending)`) but not required — see the relaxation
# note in tools/verify/self_check.sh. A task is a FOLDER whose spec is readme.md.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"
cd "${repo_root}"

missing=0
printf '%-18s  %-12s  %s\n' "TARGET" "STATUS" "TASK"
for f in .eforest/tasks/epic-*/E*-T*/readme.md; do
  [ -f "$f" ] || continue
  id="$(basename "$(dirname "$f")" | sed -nE 's/^(E[0-9]+-T[0-9]+).*/\1/p')"
  [ -n "$id" ] || continue
  status="$(sed -n 's/^status:[[:space:]]*//p' "$f" | head -1)"
  title="$(sed -n 's/^title:[[:space:]]*//p' "$f" | head -1)"
  case "$status" in
    pending|in-progress|implemented|verified|refuted|cancelled) ;;
    *)
      printf '%-18s  %-12s  %s\n' "INVALID" "${status:-<missing>}" "${title:-$f}"
      echo "verify-list: invalid or missing task status in $f" >&2
      missing=1
      continue
      ;;
  esac
  if grep -qE "^verify-${id}:" Makefile; then
    target="verify-${id}"
  else
    case "$status" in
      implemented|verified) target="MISSING"; missing=1 ;;
      *) target="(pending)" ;;
    esac
  fi
  printf '%-18s  %-12s  %s\n' "${target}" "${status}" "${title}"
done

if [ "${missing}" -ne 0 ]; then
  echo "verify-list: an implemented/verified task has no verify target — add one to the Makefile" >&2
  exit 1
fi
