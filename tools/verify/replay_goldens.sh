#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"
cd "${repo_root}"

tmp="$(mktemp -d)"
cleanup() { rm -rf "${tmp}"; }
trap cleanup EXIT

field() {
  local json="$1" key="$2"
  node -e 'const [json,key]=process.argv.slice(1); process.stdout.write(String(JSON.parse(json)[key]))' "${json}" "${key}"
}

mutations=0
for log in packages/protocol/fixtures/*.events.jsonl; do
  name="$(basename "${log}" .events.jsonl)"
  expected="packages/protocol/fixtures/${name}.expected.json"
  run1="$(node tools/verify/replay_fixture.mjs "${log}" "${expected}")"
  run2="$(node tools/verify/replay_fixture.mjs "${log}" "${expected}")"
  pid1="$(field "${run1}" pid)"
  pid2="$(field "${run2}" pid)"
  digest1="$(field "${run1}" finalStateDigest)"
  digest2="$(field "${run2}" finalStateDigest)"
  expected_digest="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).finalStateDigest)' "${expected}")"
  [ "${pid1}" != "${pid2}" ]
  [ "${digest1}" = "${digest2}" ]
  [ "${digest1}" = "${expected_digest}" ]
  echo "fixture=${name} run1=${digest1} run1.pid=${pid1} run2=${digest2} run2.pid=${pid2} expected=${expected_digest} OK"

  if [ -s "${log}" ]; then
    mutated="${tmp}/${name}.events.jsonl"
    cp "${log}" "${mutated}"
    byte="$(node -e 'const fs=require("node:fs"); const p=process.argv[1]; const s=fs.readFileSync(p,"utf8"); const i=s.indexOf("\"ts\":"); if(i<0) process.exit(2); const at=i+5; const c=s[at]; const next=c==="9"?"8":String(Number(c)+1); fs.writeFileSync(p,s.slice(0,at)+next+s.slice(at+1)); process.stdout.write(String(at))' "${mutated}")"
    if node tools/verify/replay_fixture.mjs "${mutated}" "${expected}" >/dev/null 2>&1; then
      echo "mutation unexpectedly matched fixture ${name}" >&2
      exit 1
    fi
    echo "MUTATION fixture=${name} byte=${byte} digest-mismatch EXPECTED-FAIL OK"
    mutations=$((mutations + 1))
  fi
done

[ "${mutations}" -ge 1 ]
