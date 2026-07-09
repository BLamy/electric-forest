#!/usr/bin/env bash
# Run a verify target from a PRISTINE clone of HEAD, in a scratch directory, with
# a scrubbed environment — eliminating "works on the builder's machine".
# (Ported from wasm-vm via the figma-clone; this repo is TypeScript, so the Node/npm
# scrubs are the load-bearing ones and the Rust scrubs are kept as harmless belt-and-
# braces for any future native tooling.)
#
#   tools/verify/cold_clone.sh [--keep] <make-target>
#
# - Clones the COMMITTED HEAD (never the dirty working tree) into `mktemp -d`.
# - Scrubs the environment: unsets RUSTFLAGS / RUSTDOCFLAGS / RUST_LOG, every CARGO_*,
#   NODE_OPTIONS / NODE_ENV, and every npm_config_* (any case). REPLAY_API_KEY is
#   deliberately PRESERVED — evidence upload needs it, and a cold clone that cannot
#   upload its own recording would be evidence-blind.
# - PREPENDS the trusted toolchain dirs (core system bins + the LAST executable `node`
#   and `pnpm` found while walking the caller PATH) so a caller-poisoned shim PREPENDED
#   to PATH is outranked by the real tools that were already present later — while the
#   rest of PATH is kept so legitimate tools further down still resolve. Selection only
#   inspects executable files; it never executes a candidate shim. A targeted scrub,
#   not `env -i`.
# - `bash --noprofile --norc` so the user's shell profile can't re-inject those vars.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
source "${here}/trusted_path.sh"

keep=0
if [ "${1:-}" = "--keep" ]; then keep=1; shift; fi
target="${1:?usage: cold_clone.sh [--keep] <make-target>}"

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

# Trusted toolchain dirs prepended so a poisoned shim PREPENDED to the caller's PATH
# loses. `command -v` is deliberately not used: it would select the attacker's first
# candidate. Instead, walk every PATH entry without executing anything and retain the
# last executable candidate for each tool. This exactly enforces the frozen threat
# model (a fake shim prepended to an otherwise working PATH) while remaining portable
# to Node/pnpm installations outside fixed system directories.
clean_path="$(trusted_tool_path "${PATH}")"

# Fixed vars, plus every CARGO_* and npm_config_* currently in the environment, are
# unset. REPLAY_API_KEY is NOT in this list — see the header.
unset_args=(-u RUSTFLAGS -u RUSTDOCFLAGS -u RUST_LOG -u NODE_OPTIONS -u NODE_ENV)
while IFS= read -r v; do unset_args+=(-u "$v"); done \
  < <(env | sed -n 's/^\(CARGO_[A-Za-z0-9_]*\)=.*/\1/p')
while IFS= read -r v; do unset_args+=(-u "$v"); done \
  < <(env | sed -n 's/^\([Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_[A-Za-z0-9_]*\)=.*/\1/p')

echo "cold_clone: make ${target} (scrubbed RUSTFLAGS/RUSTDOCFLAGS/RUST_LOG/CARGO_*/NODE_OPTIONS/NODE_ENV/npm_config_*; REPLAY_API_KEY preserved; trusted PATH prepended)"
set +e
env "${unset_args[@]}" \
  PATH="${clean_path}" \
  bash --noprofile --norc -c "cd '${dir}/repo' && make ${target}"
rc=$?
set -e

if [ "${keep}" -eq 1 ]; then echo "cold_clone: kept ${dir}"; fi
if [ "${rc}" -eq 0 ]; then
  echo "cold_clone: ${target} PASSED from a pristine clone"
else
  echo "cold_clone: ${target} FAILED (exit ${rc})" >&2
fi
exit "${rc}"
