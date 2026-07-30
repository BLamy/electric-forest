#!/usr/bin/env bash
# The old snapshot-based publication edge is permanently retired. It cannot
# close browser producers before deciding clean and therefore must fail closed.
set -euo pipefail

echo "E3-T02 recorder guard: snapshot publication is retired; use e3_t02_recorder_lifecycle.mjs" >&2
exit 1
