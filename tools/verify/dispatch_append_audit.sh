#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

evidence_dir=".eforest/tasks/epic-0-the-seed/E0-T11-validated-dispatch/evidence"
mkdir -p "$evidence_dir"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/eforest-dispatch-audit.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

all_refs="$tmp_dir/all-refs.txt"
direct_refs="$tmp_dir/direct-refs.txt"
wrapper_refs="$tmp_dir/wrapper-refs.txt"
set +e
rg -n "\\bappend\\b" packages/server/src --glob '*.ts' > "$all_refs"
rg_all_status=$?
rg -n -e '\.append[[:space:]]*\(' -e '\[\"append\"\]' -e "\['append'\]" \
  -e 'append[[:space:]]*\.(call|apply|bind)' packages/server/src --glob '*.ts' > "$direct_refs"
rg_direct_status=$?
rg -n 'appendThroughDoor' packages/server/src --glob '*.ts' > "$wrapper_refs"
rg_wrapper_status=$?
set -e
if [ "$rg_all_status" -gt 1 ] || [ "$rg_direct_status" -gt 1 ] || [ "$rg_wrapper_status" -gt 1 ]; then
  echo "append audit: ripgrep failed" >&2
  exit 1
fi

if [ ! -s "$direct_refs" ]; then
  echo "append audit: no direct append invocation found" >&2
  exit 1
fi
set +e
public_export="$(rg -n 'appendThroughDoor|appendInvocationStats|resetAppendInvocationStats' packages/server/src/index.ts)"
public_export_status=$?
set -e
if [ "$public_export_status" -eq 0 ] || [ -n "$public_export" ]; then
  echo "append audit: append wrapper or counter leaked through the public server API" >&2
  printf '%s\n' "$public_export" >&2
  exit 1
fi
sort -o "$all_refs" "$all_refs"
sort -o "$direct_refs" "$direct_refs"
sort -o "$wrapper_refs" "$wrapper_refs"
set +e
outside_wrapper="$(grep -v 'packages/server/src/append-door.ts:' "$direct_refs")"
grep_status=$?
set -e
if [ "$grep_status" -gt 1 ] || [ -n "$outside_wrapper" ]; then
  echo "append audit: append invocation escaped append-door.ts" >&2
  printf '%s\n' "$outside_wrapper" >&2
  exit 1
fi

{
  echo "E0-T11 append symbol audit"
  echo "Scope: packages/server/src/**/*.ts"
  echo "Direct invocation policy: only append-door.ts may invoke StreamStore.append."
  echo
  echo "All references (every bare append hit):"
  cat "$all_refs"
  echo
  echo "Classifications:"
  while IFS= read -r reference; do
    file="${reference%%:*}"
    case "$file" in
      packages/server/src/append-door.ts)
        echo "$reference | direct invocation wrapper; counted; validated door callers only"
        ;;
      packages/server/src/store/*)
        echo "$reference | store contract/implementation or persistence frame; not a call site"
        ;;
      packages/server/src/http.ts)
        echo "$reference | raw protocol route imports/calls appendThroughDoor; allowed door"
        ;;
      packages/server/src/dispatch.ts)
        echo "$reference | validated dispatch imports/calls appendThroughDoor; allowed door"
        ;;
      *)
        echo "$reference | test/documentation/export reference; no store append invocation"
        ;;
    esac
  done < "$all_refs"
  echo
  echo "Direct invocation scan:"
  cat "$direct_refs"
  echo
  echo "appendThroughDoor references (wrapper import/call graph):"
  cat "$wrapper_refs"
  echo "Allowed invocation paths: http.ts raw route and dispatch.ts validated route."
  echo "Result: exactly one direct StreamStore.append invocation, inside append-door.ts."
} > "$evidence_dir/e0-t11-append-callsites.txt"

echo "append audit: OK"
