#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: e2_t12_loopback.sh <command> [args...]" >&2
  exit 2
fi

if [ "${E2_T12_OS_SANDBOX_ACTIVE:-}" = "1" ]; then
  exec "$@"
fi

if [ "$(uname -s)" != "Darwin" ] || [ ! -x /usr/bin/sandbox-exec ]; then
  echo "E2-T12: SKIPPED — a process-wide loopback network sandbox is unavailable" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
echo "E2-T12: loopback sandbox engaged (all non-loopback network denied)" >&2
exec /usr/bin/sandbox-exec -f "${root}/tools/verify/e2_t12_loopback.sb" \
  env E2_T12_OS_SANDBOX_ACTIVE=1 "$@"
