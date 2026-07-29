#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
corpus="${root}/.eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests/evidence"
key="fs_maple_reading-room_main_meta"
byte=""
mode="flip"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) corpus="$(cd "$2" && pwd)"; shift 2 ;;
    --stream) key="$2"; shift 2 ;;
    --byte) byte="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    *) echo "usage: seed_sensitivity.sh [--root DIR] [--stream KEY] [--byte N] [--mode flip|truncate]" >&2; exit 2 ;;
  esac
done

scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e3-seed-sensitivity.XXXXXX")"
trap 'rm -rf "${scratch}"' EXIT
cp -R "${corpus}/." "${scratch}/"
dump="${scratch}/dumps/${key}.jsonl"
test -f "${dump}"

node -e '
const fs = require("node:fs");
const file = process.argv[1];
const mode = process.argv[2];
const requested = process.argv[3];
const bytes = fs.readFileSync(file);
if (mode === "truncate") {
  const text = bytes.toString("utf8").trimEnd().split("\n");
  if (text.length < 2) throw new Error("cannot truncate a single-record dump");
  fs.writeFileSync(file, `${text.slice(0, -1).join("\n")}\n`);
} else if (mode === "flip") {
  const index = requested === "" ? bytes.indexOf(Buffer.from("\"type\"")) + 2 : Number(requested);
  if (!Number.isSafeInteger(index) || index < 0 || index >= bytes.length) throw new Error("invalid byte");
  bytes[index] = bytes[index] === 120 ? 121 : 120;
  fs.writeFileSync(file, bytes);
} else {
  throw new Error("invalid mode");
}
' "${dump}" "${mode}" "${byte}"

output="${scratch}/compare.txt"
set +e
node "${root}/tools/verify/canopy_compare.mjs" --root "${scratch}" >"${output}" 2>&1
status="$?"
set -e
if [ "${status}" -eq 0 ]; then
  echo "E3-T01 sensitivity stayed green for ${key}" >&2
  exit 1
fi
matches="$(grep -c "^CANOPY_MISMATCH key=${key} " "${output}")"
all_matches="$(grep -c '^CANOPY_MISMATCH ' "${output}")"
if [ "${matches}" -ne 1 ] || [ "${all_matches}" -ne 1 ]; then
  cat "${output}" >&2
  echo "E3-T01 sensitivity did not localize exactly to ${key}" >&2
  exit 1
fi
echo "E3_T01_SENSITIVITY_OK key=${key} mode=${mode}"
