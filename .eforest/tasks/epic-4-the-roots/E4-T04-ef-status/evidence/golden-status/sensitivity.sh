#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
cp "${here}"/step-*.json "${tmp}/"

python3 - "${tmp}/step-01-pristine.json" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
data = bytearray(path.read_bytes())
needle = b'"baseTreeDigest":"'
start = data.index(needle) + len(needle)
data[start] = ord("1") if data[start] != ord("1") else ord("0")
path.write_bytes(data)
PY

if E4_T04_EXPECTED_DIR="${tmp}" bash "${here}/script.sh" >"${tmp}/failure.log" 2>&1; then
  echo "E4-T04 sensitivity: mutated golden unexpectedly passed" >&2
  exit 1
fi
test -s "${tmp}/failure.log"
echo "SENSITIVITY path=README.md flipped-to-modified OK"
