#!/usr/bin/env bash
# "Verify the verifier" (ported from wasm-vm via the figma-clone):
# (a) every task folder with status implemented or verified has a `verify-E<n>-T<nn>`
#     Makefile target — an implemented task without one fails here, and in CI;
# (b) no verify path contains a green-washing escape (`|| true`, `|| :`, `; exit 0`,
#     hardcoded `VERIFY_ALLOW_SKIP=1`, `continue-on-error`, or make's `-`
#     ignore-errors recipe prefix) — silence and swallowed failures are forbidden
#     (AGENTS.md).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"
cd "${repo_root}"

fail=0

# (a) target coverage across ALL epics (regex generalized to E[0-9]+-T[0-9]+).
# A task here is a FOLDER (.eforest/tasks/epic-*/E*-T*/) whose spec is readme.md.
#
# RELAXATION vs the wasm-vm original: the original demanded a verify target for EVERY
# task in the epic directory. Here only tasks whose frontmatter status is
# `implemented` or `verified` require one — this repo starts with dozens of pending
# tasks and zero code, so the original rule would force dozens of vacuous targets
# (themselves a green-washing surface). A task becomes subject to the check the moment
# its status flips to implemented; `pending`/`in-progress`/`refuted` tasks are listed by
# tools/verify/list.sh but exempt here. Frozen contract:
# "verify-list treats a task with status implemented or verified and no
# verify-<id> target as a failure — pending tasks are listed but not required."
for f in .eforest/tasks/epic-*/E*-T*/readme.md; do
  [ -f "$f" ] || continue
  id="$(basename "$(dirname "$f")" | sed -nE 's/^(E[0-9]+-T[0-9]+).*/\1/p')"
  [ -n "$id" ] || continue
  status="$(sed -n 's/^status:[[:space:]]*//p' "$f" | head -1)"
  case "$status" in
    implemented|verified)
      if ! grep -qE "^verify-${id}:" Makefile; then
        echo "MISSING verify target for ${id} (status: ${status}) ($f)" >&2
        fail=1
      fi
      ;;
  esac
done

# (b) no green-washing in the verify PATH. We scan real recipe/command lines only —
# stripping comments — and exclude the detector itself (this file legitimately names the
# patterns in its own messages/regexes). Targets: the Makefile verify section (delimited
# by the marker comments below), every tools/verify/*.sh and tools/replay/*.sh except
# this one (the replay scripts are invoked by _v-replay, so they ARE verify path), all
# GitHub workflow files, and package.json scripts.
strip_comments() { grep -vE '^[[:space:]]*#'; }
# A swallowed-success token can be followed by shell whitespace/comment/end, a shell
# command separator, or a JSON string delimiter. The latter is load-bearing: package
# scripts are scanned in their encoded package.json form, where a terminal `|| true`
# is immediately followed by `"` rather than whitespace.
escape_re='\|\|[[:space:]]*(true|:)([[:space:];"]|$|#)|;[[:space:]]*exit[[:space:]]+0([[:space:];"]|$|#)|(^|[[:space:];@+])VERIFY_ALLOW_SKIP=1([[:space:];"]|$)|continue-on-error'
tab="$(printf '\t')"

start_marker='# --- Adversarial-verification tooling ---'
end_marker='# --- end verify section ---'
if ! grep -qF "${start_marker}" Makefile || ! grep -qF "${end_marker}" Makefile; then
  # Missing markers would make the section scan vacuous — that is itself a failure.
  echo "Makefile verify-section marker comments missing (self-check would be blind)" >&2
  fail=1
else
  verify_section="$(sed -n "/^${start_marker}\$/,/^${end_marker}\$/p" Makefile | strip_comments)"
  if printf '%s\n' "${verify_section}" | grep -nE "${escape_re}"; then
    echo "forbidden green-washing escape in the Makefile verify section" >&2
    fail=1
  fi
  # ignore-errors recipe prefix — make honors a leading '-' (in any mix/order with @, +,
  # and INTERSPERSED whitespace) in BOTH forms: multiline `<TAB>…-cmd` AND inline
  # `target: … ; …-cmd`. The prefix run may contain spaces/tabs (`<TAB> -cmd`, `; @ -cmd`
  # are honored), so allow whitespace in the class — but require ONLY whitespace/@/+
  # before the dash, so a mid-command dash (`cargo clippy -- -D warnings`) never trips
  # it. This is make syntax, so it is scanned in the Makefile section only; the shell
  # scripts below get the escape scan.
  prefix_re="^${tab}[[:space:]@+]*-|;[[:space:]@+]*-"
  if printf '%s\n' "${verify_section}" | grep -nE "${prefix_re}"; then
    echo "forbidden '-' ignore-errors recipe prefix in the Makefile verify section" >&2
    fail=1
  fi
fi

# A verify or _v-* target defined OUTSIDE the marked section would evade the scans
# above — forbid that placement outright.
#
# DOCUMENTED GAP (the one exception allowed by the E0-T02 frozen contract): this
# lexical scanner does not construct make's transitive dependency graph. An arbitrary
# helper target outside the marked section can therefore be invoked by an in-section
# target without its recipe being scanned. Frozen-contract review must reject such a
# dependency when the Makefile changes; only targets whose own names start `_v-` or
# `verify-` are mechanically placement-enforced here. Closing this gap later requires
# a deliberate contract change and sensitivity proof, not an undocumented heuristic.
outside_section="$(awk -v s="${start_marker}" -v e="${end_marker}" \
  '$0==s{in_sec=1} !in_sec{print} $0==e{in_sec=0}' Makefile)"
if printf '%s\n' "${outside_section}" | grep -nE '^(_v-|verify-)'; then
  echo "verify/_v- target defined outside the marked verify section (evades the greenwash scan)" >&2
  fail=1
fi

# Every verify-orchestration script must be escape-free (self_check.sh excluded — as the
# detector it names the patterns it hunts).
for s in tools/verify/*.sh tools/replay/*.sh; do
  [ "$(basename "$s")" = "self_check.sh" ] && continue
  if strip_comments < "$s" | grep -nE "${escape_re}"; then
    echo "forbidden escape in ${s}" >&2
    fail=1
  fi
done

# CI: a `continue-on-error` in a workflow is the YAML spelling of swallowed failure.
for w in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$w" ] || continue
  if strip_comments < "$w" | grep -nE 'continue-on-error'; then
    echo "forbidden continue-on-error in ${w}" >&2
    fail=1
  fi
done

# npm: a green-washing escape inside a package.json script swallows failures the same
# way. We grep the whole file (a superset of the "scripts" block — stricter and
# dialect-free).
# node_modules is third-party; .claude/ holds vendored plugin bundles — neither is our
# verify path.
while IFS= read -r p; do
  if grep -nE "${escape_re}" "$p"; then
    echo "forbidden green-washing escape in ${p} (npm scripts must fail loudly)" >&2
    fail=1
  fi
done < <(find . -name package.json -not -path '*/node_modules/*' -not -path './.claude/*')

if [ "${fail}" -eq 0 ]; then
  echo "verify self-check OK: every implemented/verified task has a target; no green-washing escapes"
fi
exit "${fail}"
