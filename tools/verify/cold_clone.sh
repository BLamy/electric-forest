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
# - PREPENDS the trusted toolchain dirs (core system bins + the directories `command -v
#   node` and `command -v pnpm` resolve to) to PATH so a caller-poisoned shim (a fake
#   `node` or `pnpm` prepended to PATH) is OUTRANKED by the real tools — while the rest of
#   PATH is kept so legitimate tools further down still resolve. A targeted scrub, not
#   `env -i`.
# - `bash --noprofile --norc` so the user's shell profile can't re-inject those vars.
set -euo pipefail

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

# Trusted toolchain dirs prepended so a poisoned shim in the caller's PATH loses. The
# node bin dir is resolved from the caller's `command -v node` (there is no fixed system
# location for node), which is safe because it is resolved HERE, before the scrub, and
# pinned — a shim dir prepended later cannot outrank it inside the clone.
trusted="/usr/bin:/bin:/usr/sbin:/sbin"
for tool in node pnpm; do
  if command -v "$tool" >/dev/null 2>&1; then
    tool_bin="$(cd "$(dirname "$(command -v "$tool")")" && pwd)"
    trusted="${trusted}:${tool_bin}"
  fi
done
clean_path="${trusted}:${PATH}"

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
