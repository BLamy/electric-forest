#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
cd "${root}"

fixture="packages/cli/fixtures/sessions/issue-to-merge"
ef="packages/cli/dist/src/bin.js"
expected="$(node -e 'const value=require("./packages/cli/fixtures/sessions/issue-to-merge/expected.json"); process.stdout.write(value.composite)')"

first="$(node "${ef}" replay --session "${fixture}")"
printf '%s\n' "${first}"
actual="$(printf '%s\n' "${first}" | sed -nE 's/^COMPOSITE digest=([a-f0-9]{64})$/\1/p')"
test -n "${actual}"
test "${actual}" = "${expected}"
printf 'COMPOSITE digest=%s expected=%s OK\n' "${actual}" "${expected}"

second="$(node "${ef}" replay --session "${fixture}")"
test "${second}" = "${first}"
live_one="$(pnpm --silent scenario:e5-negotiation)"
live_two="$(pnpm --silent scenario:e5-negotiation)"
live_one_digest="$(printf '%s\n' "${live_one}" | sed -nE 's/^LIVE-SESSION streams=7 composite=([a-f0-9]{64}) out=.* OK$/\1/p')"
live_two_digest="$(printf '%s\n' "${live_two}" | sed -nE 's/^LIVE-SESSION streams=7 composite=([a-f0-9]{64}) out=.* OK$/\1/p')"
test "${live_one_digest}" = "${expected}"
test "${live_two_digest}" = "${expected}"
printf 'LIVE-DUMP streams=7 composite=%s expected=%s OK\n' "${live_one_digest}" "${expected}"
printf 'DETERMINISM session=issue-to-merge OK\n'

node tools/verify/e5_t12_doc_sync.mjs

scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-e5-t12.XXXXXX")"
trap 'rm -rf "${scratch}"' EXIT

while IFS=$'\t' read -r stream filename; do
  copy="${scratch}/mutation-$(printf '%s' "${stream}" | shasum -a 256 | cut -d' ' -f1)"
  cp -R "${fixture}" "${copy}"
  byte="$(node - "${copy}/${filename}" "${stream}" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [path, stream] = process.argv.slice(2);
const bytes = readFileSync(path);
const marker = stream.startsWith("fs:")
  ? Buffer.from('"path":"')
  : stream.startsWith("evidence-content:")
    ? Buffer.from('"bytes":"')
    : stream.startsWith("evidence:")
      ? Buffer.from('"attachmentId":"')
      : Buffer.from('"body":"');
const start = bytes.indexOf(marker);
if (start < 0) throw new Error(`no semantic mutation marker for ${stream}`);
const index = start + marker.length;
bytes[index] = bytes[index] === 0x78 ? 0x79 : 0x78;
writeFileSync(path, bytes);
process.stdout.write(String(index));
NODE
)"
  if failure="$(node "${ef}" replay --session "${copy}" 2>&1)"; then
    printf 'mutation unexpectedly passed for %s\n' "${stream}" >&2
    exit 1
  fi
  printf '%s\n' "${failure}"
  grep -F "${stream}" <<<"${failure}" >/dev/null
  printf 'MUTATION stream=%s byte=%s EXPECTED-FAIL OK\n' "${stream}" "${byte}"
done < <(
  node -e '
    const manifest=require("./packages/cli/fixtures/sessions/issue-to-merge/session.json");
    for (const entry of manifest.streams) {
      process.stdout.write(`${entry.stream}\t${encodeURIComponent(entry.stream)}.events.jsonl\n`);
    }
  '
)

# A canonical envelope-byte mutation that the reducer intentionally ignores must still
# invalidate the composite. This is the adversarial case that state-only hashing misses.
inert_copy="${scratch}/mutation-reducer-inert"
cp -R "${fixture}" "${inert_copy}"
inert_stream="fs:maple/reading-room:wiki:meta"
inert_file="${inert_copy}/$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]) + ".events.jsonl")' "${inert_stream}")"
inert_byte="$(node - "${inert_file}" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[2];
const source = readFileSync(path, "utf8");
const marker = '"ts":1';
const index = source.indexOf(marker);
if (index < 0) throw new Error("reducer-inert timestamp marker missing");
const changed = `${source.slice(0, index)}"ts":9${source.slice(index + marker.length)}`;
writeFileSync(path, changed);
process.stdout.write(String(index + marker.length - 1));
NODE
)"
if inert_failure="$(node "${ef}" replay --session "${inert_copy}" 2>&1)"; then
  printf 'reducer-inert mutation unexpectedly passed for %s\n' "${inert_stream}" >&2
  exit 1
fi
printf '%s\n' "${inert_failure}"
grep -F "${inert_stream}" <<<"${inert_failure}" >/dev/null
printf 'MUTATION-INERT stream=%s byte=%s EXPECTED-FAIL OK\n' "${inert_stream}" "${inert_byte}"

issue_stream="issue:maple/reading-room/negotiation"
issue_file="${fixture}/$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]) + ".events.jsonl")' "${issue_stream}")"
bisect_copy="${scratch}/issue-diverged.jsonl"
cp "${issue_file}" "${bisect_copy}"
node - "${bisect_copy}" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[2];
const source = readFileSync(path, "utf8");
const changed = source.replace('"label":"epic-5"', '"label":"epic-6"');
if (changed === source) throw new Error("bisect mutation marker missing");
writeFileSync(path, changed);
NODE
injected="0000000000000000_0000000000000001"
if bisect_output="$(node "${ef}" bisect "${issue_file}" "${bisect_copy}" --reducer issue)"; then
  printf 'bisect unexpectedly reported identical logs\n' >&2
  exit 1
fi
found="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.bOffset)' "${bisect_output}")"
test "${found}" = "${injected}"
printf 'BISECT stream=%s injected=%s found=%s OK\n' "${issue_stream}" "${injected}" "${found}"
