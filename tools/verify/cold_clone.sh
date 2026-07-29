#!/usr/bin/env bash
# Run a verify target from a PRISTINE clone of HEAD, in a scratch directory, with
# a scrubbed environment — eliminating "works on the builder's machine".
# (Ported from wasm-vm via the figma-clone; this repo is TypeScript, so the Node/npm
# scrubs are the load-bearing ones and the Rust scrubs are kept as harmless belt-and-
# braces for any future native tooling.)
#
#   tools/verify/cold_clone.sh [--keep] <verify-target>
#
# - Clones the COMMITTED HEAD (never the dirty working tree) into `mktemp -d`.
# - Scrubs the environment: unsets RUSTFLAGS / RUSTDOCFLAGS / RUST_LOG, every CARGO_*,
#   NODE_OPTIONS / NODE_ENV, Bash startup hooks, every MAKE* plus GNUMAKEFLAGS / MFLAGS,
#   and every npm_config_* (any case). REPLAY_API_KEY is deliberately PRESERVED — evidence
#   upload needs it, and a cold clone that cannot upload its own recording would be
#   evidence-blind.
# - Accepts only targets in `tools/verify/cold_clone_targets.txt`. Before dependency
#   hydration, the clone's resolved Make executable must dry-run the exact target and
#   schedule its target-specific success marker. After execution, that marker must be
#   emitted exactly. Human-readable Make-database text, empty/no-op rules, arbitrary
#   files/directories, options, and injected targets cannot earn PASS.
# - PREPENDS the trusted toolchain dirs (core system bins + the LAST executable `node`
#   and `pnpm` found while walking the caller PATH) so a caller-poisoned shim PREPENDED
#   to PATH is outranked by the real tools that were already present later — while the
#   rest of PATH is kept so legitimate tools further down still resolve. Selection only
#   inspects executable files; it never executes a candidate shim. A targeted scrub,
#   not `env -i`.
# - If the caller has a pnpm installation, reuses only its content-addressed store through
#   an explicit offline frozen-lockfile install. Package bytes remain pinned by the lockfile;
#   no source files or linked `node_modules` enter the clone. If that cache is incomplete,
#   the attempt is discarded and the ordinary install path remains available.
# - Before any name-resolved command, an absolute `/bin/bash -p` boundary starts a
#   privileged shell. Privileged Bash does not import exported functions or startup
#   hooks. The clean shell then performs the explicit environment scrub for its later
#   non-privileged child and calls a resolved Make executable rather than shell lookup.
if [[ "$-" != *p* ]]; then
  /bin/bash --noprofile --norc -p "$0" "$@"
else
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
source "${here}/trusted_path.sh"

keep=0
if [ "${1:-}" = "--keep" ]; then keep=1; shift; fi
if [ "$#" -ne 1 ]; then
  echo "usage: cold_clone.sh [--keep] <verify-target>" >&2
  exit 1
fi
target="$1"
case "${target}" in
  verify-*) ;;
  *)
    echo "cold_clone: FAIL — invalid verify target ${target}" >&2
    exit 1
    ;;
esac
case "${target}" in
  verify-|*[!A-Za-z0-9_.-]*)
    echo "cold_clone: FAIL — invalid verify target ${target}" >&2
    exit 1
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
git -C "${repo_root}" rev-parse --verify -q HEAD >/dev/null || {
  echo "cold_clone: FAIL — repository has no commits; cold_clone clones committed HEAD only (commit the bootstrap first)" >&2
  exit 1
}
sha="$(git -C "${repo_root}" rev-parse HEAD)"
dir="$(mktemp -d)"
cleanup() { [ "${keep}" -eq 1 ] || rm -rf "${dir}"; }
trap cleanup EXIT

echo "cold_clone: cloning HEAD ${sha} → ${dir}"
git clone --quiet "${repo_root}" "${dir}/repo"
git -C "${dir}/repo" checkout --quiet "${sha}"

# A task's pinned submodule is source input, like the lockfile-addressed pnpm store below,
# not runtime network. Seed it from the caller's local object database before any
# task-specific network sandbox starts, then checkout the exact gitlink recorded by HEAD.
# The clone remains independent (`--dissociate`) and cannot see caller working-tree files.
if [ -f "${dir}/repo/.gitmodules" ] && [ -e "${repo_root}/vendor/emulate/.git" ]; then
  git -C "${dir}/repo" config submodule.vendor/emulate.url "${repo_root}/vendor/emulate"
  git -c protocol.file.allow=always -C "${dir}/repo" submodule update --init --dissociate -- vendor/emulate
fi

# Trusted toolchain dirs prepended so a poisoned shim PREPENDED to the caller's PATH
# loses. `command -v` is deliberately not used: it would select the attacker's first
# candidate. Instead, walk every PATH entry without executing anything and retain the
# last executable candidate for each tool. This exactly enforces the frozen threat
# model (a fake shim prepended to an otherwise working PATH) while remaining portable
# to Node/pnpm installations outside fixed system directories.
clean_path="$(trusted_tool_path "${PATH}")"
old_path="${PATH}"
PATH="${clean_path}"
make_bin="$(builtin type -P make)" || {
  echo "cold_clone: FAIL — trusted Make executable is unavailable" >&2
  exit 1
}
PATH="${old_path}"
if [ -z "${make_bin}" ] || [ ! -x "${make_bin}" ] || [ -d "${make_bin}" ]; then
  echo "cold_clone: FAIL — trusted Make executable is unavailable" >&2
  exit 1
fi

# The pnpm store recorded by the caller's installed graph is a package cache, not part of
# the working tree. Accept only an absolute, structurally valid content-addressed store.
# The clone still performs its own frozen-lockfile install and pnpm verifies every cached
# file against lockfile integrity before linking it.
seed_store=""
modules_file="${repo_root}/node_modules/.modules.yaml"
if [ -f "${modules_file}" ]; then
  candidate_store="$(sed -n 's/^storeDir: //p' "${modules_file}" | tail -n 1)"
  case "${candidate_store}" in
    /*)
      if [ -d "${candidate_store}/files" ] && [ -d "${candidate_store}/index" ]; then
        seed_store="${candidate_store}"
      fi
      ;;
  esac
fi

# Fixed vars, plus every CARGO_*, MAKE*, and npm_config_* currently in the environment,
# are unset. Make's ambient control inputs are load-bearing here: MAKEFILES and flags can
# otherwise add a target that does not exist in the committed clone. REPLAY_API_KEY is
# NOT in this list — see the header.
unset_args=(
  -u RUSTFLAGS -u RUSTDOCFLAGS -u RUST_LOG
  -u NODE_OPTIONS -u NODE_ENV
  -u BASH_ENV -u ENV
  -u GNUMAKEFLAGS -u MFLAGS
)
while IFS= read -r v; do unset_args+=(-u "$v"); done \
  < <(env | sed -n 's/^\(CARGO_[A-Za-z0-9_]*\)=.*/\1/p')
while IFS= read -r v; do unset_args+=(-u "$v"); done \
  < <(env | sed -n 's/^\(MAKE[A-Za-z0-9_]*\)=.*/\1/p')
while IFS= read -r v; do unset_args+=(-u "$v"); done \
  < <(env | sed -n 's/^\([Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_[A-Za-z0-9_]*\)=.*/\1/p')
# The *_OS_SANDBOX_ACTIVE family (E2-T04/T05/T06/T07 loopback wrappers) is
# scrubbed so an inherited flag can never make a task's OS network sandbox
# silently skip engagement inside the pristine clone (E2-T06 run-10 standing
# demand).
while IFS= read -r v; do unset_args+=(-u "$v"); done \
  < <(env | sed -n 's/^\([A-Za-z0-9_]*_OS_SANDBOX_ACTIVE\)=.*/\1/p')

echo "cold_clone: make ${target} (registered marker; resolved ${make_bin}; scrubbed aliases/functions/RUSTFLAGS/RUSTDOCFLAGS/RUST_LOG/CARGO_*/NODE_OPTIONS/NODE_ENV/BASH_ENV/ENV/MAKE*/GNUMAKEFLAGS/MFLAGS/npm_config_*/*_OS_SANDBOX_ACTIVE; REPLAY_API_KEY preserved; trusted PATH prepended)"
set +e
env "${unset_args[@]}" \
  PATH="${clean_path}" \
  bash --noprofile --norc -c '
    set -euo pipefail
    cd "$1"
    hydrate_dependencies() {
      local candidate_store="$1"
      if [ -n "$candidate_store" ]; then
        echo "cold_clone: hydrating dependencies from lockfile-verified pnpm store $candidate_store"
        if ! CI=true pnpm install --offline --frozen-lockfile --store-dir "$candidate_store"; then
          echo "cold_clone: cached store incomplete; discarding partial install and using ordinary install path" >&2
          rm -rf node_modules packages/*/node_modules
        fi
      fi
    }
    registry="tools/verify/cold_clone_targets.txt"
    if [ ! -f "$registry" ]; then
      echo "cold_clone: FAIL — committed cold-clone target registry is missing" >&2
      exit 1
    fi
    registered=0
    while IFS= read -r registered_target || [ -n "$registered_target" ]; do
      case "$registered_target" in ""|\#*) continue ;; esac
      if [ "$registered_target" = "$3" ]; then
        registered=1
        break
      fi
    done < "$registry"
    if [ "$registered" -ne 1 ]; then
      echo "cold_clone: FAIL — make target $3 is not in the committed cold-clone registry" >&2
      exit 1
    fi
    expected_marker="$3: OK"
    if [ "$3" = "verify-all" ]; then
      expected_marker="verify-all: every defined verify target passed"
    fi
    expected_plan_line="echo \"$expected_marker\""
    make_command="$4"
    target_plan="$(mktemp)"
    set +e
    "$make_command" -rR -nB -- "$3" >"$target_plan" 2>&1
    target_plan_rc=$?
    set -e
    if [ "$target_plan_rc" -ne 0 ]; then
      rm -f "$target_plan"
      echo "cold_clone: FAIL — make target $3 has no applicable committed recipe closure" >&2
      exit 1
    fi
    marker_scheduled=0
    while IFS= read -r plan_line || [ -n "$plan_line" ]; do
      if [ "$plan_line" = "$expected_plan_line" ]; then
        marker_scheduled=1
        break
      fi
    done < "$target_plan"
    rm -f "$target_plan"
    if [ "$marker_scheduled" -ne 1 ]; then
      echo "cold_clone: FAIL — make target $3 does not schedule its registered success marker" >&2
      exit 1
    fi
    hydrate_dependencies "$2"
    set +e
    target_output="$("$make_command" -- "$3" 2>&1)"
    target_rc=$?
    set -e
    printf "%s\n" "$target_output"
    if [ "$target_rc" -ne 0 ]; then
      exit "$target_rc"
    fi
    marker_emitted=0
    while IFS= read -r output_line || [ -n "$output_line" ]; do
      if [ "$output_line" = "$expected_marker" ]; then
        marker_emitted=1
        break
      fi
    done <<< "$target_output"
    if [ "$marker_emitted" -ne 1 ]; then
      echo "cold_clone: FAIL — make target $3 exited zero without its registered success marker" >&2
      exit 1
    fi
  ' cold-clone "${dir}/repo" "${seed_store}" "${target}" "${make_bin}"
rc=$?
set -e

if [ "${keep}" -eq 1 ]; then echo "cold_clone: kept ${dir}"; fi
if [ "${rc}" -eq 0 ]; then
  echo "cold_clone: ${target} PASSED from a pristine clone"
else
  echo "cold_clone: ${target} FAILED (exit ${rc})" >&2
fi
exit "${rc}"
fi
