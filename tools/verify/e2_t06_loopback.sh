#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: e2_t06_loopback.sh <command> [args...]" >&2
  exit 2
fi

if [ "${E2_T06_OS_SANDBOX_ACTIVE:-}" = "1" ]; then
  echo "E2-T06: loopback sandbox inherited (E2_T06_OS_SANDBOX_ACTIVE=1; not re-entered)" >&2
  exec "$@"
fi

if [ "$(uname -s)" != "Darwin" ] || [ ! -x /usr/bin/sandbox-exec ]; then
  echo "E2-T06: SKIPPED — a process-wide loopback network sandbox is unavailable" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
echo "E2-T06: loopback sandbox engaged (sandbox-exec, non-loopback network denied)" >&2
exec /usr/bin/sandbox-exec -f "${root}/tools/verify/e2_t06_loopback.sb" \
  env E2_T06_OS_SANDBOX_ACTIVE=1 E2_T05_OS_SANDBOX_ACTIVE=1 E2_T04_OS_SANDBOX_ACTIVE=1 "$@"
