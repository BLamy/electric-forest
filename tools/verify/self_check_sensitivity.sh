#!/usr/bin/env bash
# Permanent regression probes for the verifier holes found by the E0-T02 critic.
# Plants are assembled from tokens so this test harness is not itself mistaken for a
# swallowed-failure escape by self_check.sh.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"
source "${here}/trusted_path.sh"

tmp="$(mktemp -d)"
cleanup() { rm -rf "${tmp}"; }
trap cleanup EXIT

fixture="${tmp}/repo"
prepare_fixture() {
  rm -rf "${fixture}"
  mkdir -p "${fixture}/tools/verify" "${fixture}/tools/replay" "${fixture}/.eforest"
  cp "${repo_root}/Makefile" "${repo_root}/package.json" "${fixture}/"
  cp "${repo_root}/tools/verify/self_check.sh" "${repo_root}/tools/verify/list.sh" \
    "${fixture}/tools/verify/"
  cp -R "${repo_root}/.eforest/tasks" "${fixture}/.eforest/"
  printf '#!/usr/bin/env bash\nexit 0\n' > "${fixture}/tools/replay/probe.sh"
  chmod +x "${fixture}/tools/replay/probe.sh"
}

expect_red() {
  local label="$1"
  local output rc
  set +e
  output="$(cd "${fixture}" && bash tools/verify/self_check.sh 2>&1)"
  rc=$?
  set -e
  if [ "${rc}" -eq 0 ]; then
    printf 'sensitivity %s: FAILED (plant passed)\n%s\n' "${label}" "${output}" >&2
    exit 1
  fi
  printf 'sensitivity %s: EXPECTED-FAIL OK (exit %s)\n' "${label}" "${rc}"
}

expect_green() {
  local label="$1"
  local output
  output="$(cd "${fixture}" && bash tools/verify/self_check.sh 2>&1)" || {
    printf 'sensitivity %s: FAILED (documented behavior went red)\n%s\n' \
      "${label}" "${output}" >&2
    exit 1
  }
  printf 'sensitivity %s: DOCUMENTED-GAP OK\n' "${label}"
}

expect_coverage_red() {
  local label="$1"
  local tool output rc
  for tool in self_check.sh list.sh; do
    set +e
    output="$(cd "${fixture}" && bash "tools/verify/${tool}" 2>&1)"
    rc=$?
    set -e
    if [ "${rc}" -eq 0 ]; then
      printf 'sensitivity %s/%s: FAILED (malformed task passed)\n%s\n' \
        "${label}" "${tool}" "${output}" >&2
      exit 1
    fi
    printf 'sensitivity %s/%s: EXPECTED-FAIL OK (exit %s)\n' \
      "${label}" "${tool}" "${rc}"
  done
}

op='||'
success_word='true'
swallow="${op} ${success_word}"

prepare_fixture
node -e '
  const fs = require("node:fs");
  const [file, plant] = process.argv.slice(1);
  const before = fs.readFileSync(file, "utf8");
  const needle = "then pnpm lint;";
  if (!before.includes(needle)) throw new Error("lint recipe anchor missing");
  fs.writeFileSync(file, before.replace(needle, `then pnpm lint ${plant};`));
' "${fixture}/Makefile" "${swallow}"
expect_red 'make-semicolon-terminator'

prepare_fixture
node -e '
  const fs = require("node:fs");
  const [file, op, word] = process.argv.slice(1);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.scripts.lint = `${json.scripts.lint} ${op} ${word}`;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
' "${fixture}/package.json" "${op}" "${success_word}"
expect_red 'package-json-string-terminator'

prepare_fixture
node -e '
  const fs = require("node:fs");
  const [file, op, word] = process.argv.slice(1);
  const before = fs.readFileSync(file, "utf8");
  const needle = "\t@bash tools/verify/self_check.sh";
  if (!before.includes(needle)) throw new Error("self-check recipe anchor missing");
  fs.writeFileSync(file, before.replace(needle, `\t@(false ${op} ${word})\n${needle}`));
' "${fixture}/Makefile" "${op}" "${success_word}"
expect_red 'make-parenthesized-terminator'

prepare_fixture
mkdir -p "${fixture}/.eforest/tasks/epic-9-critic/E9-T98-malformed"
printf '%s\n' '---' 'id: E9-T98' 'title: critic malformed task with no status' '---' \
  > "${fixture}/.eforest/tasks/epic-9-critic/E9-T98-malformed/readme.md"
expect_coverage_red 'missing-task-status'

prepare_fixture
grep -qF 'DOCUMENTED GAP (the one exception allowed by the E0-T02 frozen contract)' \
  "${fixture}/tools/verify/self_check.sh"
node -e '
  const fs = require("node:fs");
  const [file, op, word] = process.argv.slice(1);
  let text = fs.readFileSync(file, "utf8");
  text = text.replace("_v-lint: _v-install", "_v-lint: _v-install critic-fake-pass");
  text += `\ncritic-fake-pass:\n\t@false ${op} ${word}\n`;
  fs.writeFileSync(file, text);
' "${fixture}/Makefile" "${op}" "${success_word}"
expect_green 'out-of-section-helper'

shim="${tmp}/shim"
marker="${tmp}/shim-executed"
mkdir -p "${shim}"
for tool in node pnpm; do
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$0" >> "%s"\nexit 97\n' \
    "${marker}" > "${shim}/${tool}"
  chmod +x "${shim}/${tool}"
done

clean_path="$(trusted_tool_path "${shim}:${PATH}")"
PATH="${clean_path}" node --version >/dev/null
PATH="${clean_path}" pnpm --version >/dev/null
if [ -e "${marker}" ]; then
  echo 'sensitivity prepended-path-shim: FAILED (fake tool executed)' >&2
  exit 1
fi
case "$(PATH="${clean_path}" command -v node):$(PATH="${clean_path}" command -v pnpm)" in
  *"${shim}"*)
    echo 'sensitivity prepended-path-shim: FAILED (fake tool outranked real tool)' >&2
    exit 1
    ;;
esac
echo 'sensitivity prepended-path-shim: NOT-EXECUTED OK'
