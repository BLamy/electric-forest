#!/usr/bin/env bash
# Build the PATH used by cold-clone verification without executing any candidate tool.
# The frozen threat model is a fake node/pnpm shim PREPENDED to an otherwise working
# caller PATH. Walking left-to-right and retaining the last executable candidate makes
# the original tool outrank that shim while preserving portable installation locations.

trusted_tool_path() {
  local input_path="${1:?trusted_tool_path requires a PATH value}"
  local trusted="/usr/bin:/bin:/usr/sbin:/sbin"
  local tool tool_bin candidate_dir old_ifs

  for tool in node pnpm; do
    tool_bin=""
    old_ifs="${IFS}"
    IFS=:
    for candidate_dir in ${input_path}; do
      [ -n "${candidate_dir}" ] || candidate_dir=.
      if [ -x "${candidate_dir}/${tool}" ] && [ ! -d "${candidate_dir}/${tool}" ]; then
        tool_bin="$(cd "${candidate_dir}" && pwd)"
      fi
    done
    IFS="${old_ifs}"

    if [ -n "${tool_bin}" ]; then
      case ":${trusted}:" in
        *":${tool_bin}:"*) ;;
        *) trusted="${trusted}:${tool_bin}" ;;
      esac
    fi
  done

  printf '%s:%s\n' "${trusted}" "${input_path}"
}
