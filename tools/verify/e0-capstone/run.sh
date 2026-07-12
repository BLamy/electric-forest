#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo_root"
script_dir="tools/verify/e0-capstone"
evidence_dir="${EF_CAPSTONE_EVIDENCE_DIR:-.eforest/tasks/epic-0-the-seed/E0-T13-two-terminals-one-log/evidence}"

if [ "${1:-}" = "--check" ]; then
  a_dump="${2:-}"
  b_log="${3:-}"
  if [ -z "$a_dump" ] || [ -z "$b_log" ]; then
    echo "Usage: run.sh --check <a-dump> <b-log>" >&2
    exit 2
  fi
  a_digest="$(CI=true pnpm --silent ef replay "$a_dump" --digest)"
  b_digest="$(CI=true pnpm --silent ef replay "$b_log" --digest)"
  echo "A replay digest: $a_digest"
  echo "B replay digest: $b_digest"
  set +e
  bisect_output="$(CI=true pnpm --silent ef bisect "$a_dump" "$b_log" 2>&1)"
  bisect_status=$?
  set -e
  echo "ef bisect exit=$bisect_status: $bisect_output"
  if [ "$a_digest" != "$b_digest" ] || [ "$bisect_status" -ne 0 ]; then
    exit 1
  fi
  exit 0
fi

kill_after="${EF_CAPSTONE_KILL_AFTER:-3}"
if ! [[ "$kill_after" =~ ^[0-9]+$ ]]; then
  echo "EF_CAPSTONE_KILL_AFTER must be a non-negative integer" >&2
  exit 2
fi
valid_events=5
action_delay_ms="${EF_CAPSTONE_ACTION_DELAY_MS:-200}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/eforest-capstone.XXXXXX")"
data_dir="$scratch/data"
mkdir -p "$data_dir"
server_pid=""
b_pid=""
resume_pid=""
cleanup() {
  for pid in "$server_pid" "$b_pid" "$resume_pid"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; fi
  done
  if [ "${EF_CAPSTONE_KEEP_SCRATCH:-0}" = "1" ]; then
    echo "CAPSTONE kept scratch: $scratch" >&2
  else
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT

echo "CAPSTONE scratch: $scratch"
echo "CAPSTONE dataDir: $data_dir"
node "$script_dir/server.mjs" --data-dir "$data_dir" --port=0 >"$scratch/server.log" 2>&1 &
server_pid=$!
base_url=""
for _ in $(seq 1 200); do
  if [ -s "$scratch/server.log" ]; then
    base_url="$(sed -n 's/^LISTENING //p' "$scratch/server.log" | head -1)"
    if [ -n "$base_url" ]; then break; fi
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$scratch/server.log" >&2; exit 1; fi
  sleep 0.02
done
if [ -z "$base_url" ]; then echo "server did not expose an ephemeral URL" >&2; exit 1; fi
echo "CAPSTONE server: $base_url (pid=$server_pid)"
node --input-type=module - "$base_url" <<'NODE'
const baseUrl = process.argv[2];
const response = await fetch(`${baseUrl}/streams/capstone`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ streamId: "capstone", type: "fixture" }),
});
if (response.status !== 201 && response.status !== 200) {
  throw new Error(`capstone stream pre-create failed: ${response.status} ${await response.text()}`);
}
NODE

prefix="$scratch/b-received-prefix.jsonl"
suffix="$scratch/b-received-suffix.jsonl"
checkpoint="$scratch/b-checkpoint.txt"
checkpoint_at_kill="$scratch/b-checkpoint-at-kill.txt"
a_dump="$scratch/a-dispatched.jsonl"
refusal="$scratch/dispatch-refusal.jsonl"
b_prefix_log="$scratch/b-prefix.log"
b_resume_log="$scratch/b-resume.log"
a_log="$scratch/terminal-a.log"
: >"$prefix"
: >"$suffix"
: >"$b_prefix_log"
: >"$b_resume_log"
: >"$a_log"

start_b() {
  local output="$1"
  local log="$2"
  node "$script_dir/terminal_b.mjs" \
    --base-url "$base_url" --stream capstone --expected "$valid_events" \
    --checkpoint "$checkpoint" --output "$output" --prefix "$prefix" >"$log" 2>&1 &
  last_pid=$!
}

if [ "$kill_after" -eq 0 ]; then
  start_b "$prefix" "$b_prefix_log"
  b_pid="$last_pid"
  kill -KILL "$b_pid"
  set +e
  wait "$b_pid"
  set -e
  node "$script_dir/terminal_a.mjs" --base-url "$base_url" --stream capstone \
    --actions "$script_dir/actions.jsonl" --dump "$a_dump" --refusal "$refusal" \
    --delay-ms "$action_delay_ms" >"$a_log" 2>&1 &
  a_pid=$!
else
  start_b "$prefix" "$b_prefix_log"
  b_pid="$last_pid"
  node "$script_dir/terminal_a.mjs" --base-url "$base_url" --stream capstone \
    --actions "$script_dir/actions.jsonl" --dump "$a_dump" --refusal "$refusal" \
    --delay-ms "$action_delay_ms" >"$a_log" 2>&1 &
  a_pid=$!
fi

if [ "$kill_after" -ge "$valid_events" ]; then
  set +e
  wait "$a_pid"
  a_status=$?
  wait "$b_pid"
  b_status=$?
  set -e
  if [ "$a_status" -ne 0 ] || [ "$b_status" -ne 0 ]; then cat "$a_log" "$b_prefix_log" >&2; exit 1; fi
  echo "resume leg did not execute: EF_CAPSTONE_KILL_AFTER=$kill_after" >&2
  exit 1
fi

prefix_count=0
for _ in $(seq 1 500); do
  if [ -f "$prefix" ]; then prefix_count="$(wc -l <"$prefix" | tr -d ' ')"; fi
  if [ "$prefix_count" -ge "$kill_after" ]; then break; fi
  if ! kill -0 "$a_pid" 2>/dev/null && [ "$prefix_count" -ge "$valid_events" ]; then break; fi
  sleep 0.02
done
if [ "$prefix_count" -lt "$kill_after" ] || [ "$prefix_count" -ge "$valid_events" ]; then
  echo "kill point did not land mid-stream: prefix=$prefix_count kill_after=$kill_after" >&2
  exit 1
fi
if [ "$kill_after" -gt 0 ] && [ ! -s "$checkpoint" ]; then
  echo "checkpoint was not persisted before SIGKILL" >&2
  exit 1
fi
kill_notice="CAPSTONE SIGKILL: pid=$b_pid prefix-events=$prefix_count"
echo "$kill_notice"
if [ "$kill_after" -gt 0 ]; then
  cp "$checkpoint" "$checkpoint_at_kill"
  kill -KILL "$b_pid"
  set +e
  wait "$b_pid"
  set -e
fi

start_b "$suffix" "$b_resume_log"
resume_pid="$last_pid"
set +e
wait "$a_pid"
a_status=$?
wait "$resume_pid"
resume_status=$?
set -e
if [ "$a_status" -ne 0 ] || [ "$resume_status" -ne 0 ]; then
  cat "$a_log" "$b_prefix_log" "$b_resume_log" >&2
  exit 1
fi

combined="$scratch/b-received.jsonl"
cat "$prefix" "$suffix" >"$combined"
check_output="$("$script_dir/run.sh" --check "$a_dump" "$combined")"
printf '%s\n' "$check_output"
if ! grep -q 'ef bisect exit=0' <<<"$check_output"; then exit 1; fi
expected_digest_file="$evidence_dir/expected.digest"
if [ ! -s "$expected_digest_file" ]; then
  echo "missing frozen capstone expected digest: $expected_digest_file" >&2
  exit 1
fi
a_digest="$(CI=true pnpm --silent ef replay "$a_dump" --digest)"
cmp <(printf '%s\n' "$a_digest") "$expected_digest_file"

node --input-type=module - "$a_dump" "$combined" "$checkpoint_at_kill" "$prefix" <<'NODE'
import { existsSync, readFileSync } from "node:fs";
const [aPath, bPath, checkpointPath, prefixPath] = process.argv.slice(2);
const lines = (path) => readFileSync(path, "utf8").trimEnd().split("\n").filter(Boolean).map(JSON.parse);
const a = lines(aPath);
const b = lines(bPath);
if (a.length !== b.length || a.some((record, index) => JSON.stringify(record) !== JSON.stringify(b[index]))) {
  throw new Error("B prefix+suffix contains a duplicate, gap, or divergent record");
}
const prefix = lines(prefixPath);
const checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : undefined;
if (prefix.length === 0) {
  if (checkpoint !== undefined) throw new Error("kill-before-first-batch unexpectedly wrote a checkpoint");
} else if (prefix.length >= a.length || checkpoint?.offset !== prefix.at(-1).offset) {
  throw new Error("checkpoint is not a strict interior prefix boundary");
}
NODE

mkdir -p "$evidence_dir"
cp "$a_dump" "$evidence_dir/a-dispatched.jsonl"
cp "$prefix" "$evidence_dir/b-received-prefix.jsonl"
cp "$suffix" "$evidence_dir/b-received-suffix.jsonl"
if [ -s "$checkpoint_at_kill" ]; then cp "$checkpoint_at_kill" "$evidence_dir/b-checkpoint.txt"; fi
cp "$a_log" "$evidence_dir/terminal-a.log"
cp "$b_prefix_log" "$evidence_dir/terminal-b-prefix.log"
cp "$b_resume_log" "$evidence_dir/terminal-b-resume.log"
printf '%s\n' "$check_output" >"$evidence_dir/bisect-clean.txt"
{
  echo "Command: EF_CAPSTONE_KILL_AFTER=$kill_after $script_dir/run.sh"
  echo "Server PID: $server_pid"
  echo "Fresh data dir: $data_dir"
  echo "$kill_notice"
  cat "$a_log" "$b_prefix_log" "$b_resume_log"
} >"$evidence_dir/digests.txt"
printf 'Dispatch refusal response:\n' >"$evidence_dir/dispatch-refusal.txt"
cat "$refusal" >>"$evidence_dir/dispatch-refusal.txt"
printf 'Dump valid event count: %s\nInvalid action present: ' "$valid_events" >>"$evidence_dir/dispatch-refusal.txt"
if grep -q 'capstone/invalid' "$a_dump"; then echo yes >>"$evidence_dir/dispatch-refusal.txt"; else echo no >>"$evidence_dir/dispatch-refusal.txt"; fi

tampered="$scratch/b-tampered.jsonl"
node --input-type=module - "$combined" "$tampered" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson } from "./packages/protocol/dist/src/index.js";
const [source, target] = process.argv.slice(2);
const lines = readFileSync(source, "utf8").trimEnd().split("\n").filter(Boolean);
const record = JSON.parse(lines[0]);
record.payload = Number(record.payload) + 1;
lines[0] = canonicalJson(record);
writeFileSync(target, `${lines.join("\n")}\n`);
NODE
set +e
tamper_output="$("$script_dir/run.sh" --check "$a_dump" "$tampered" 2>&1)"
tamper_status=$?
set -e
if [ "$tamper_status" -eq 0 ] || ! grep -q 'index.*1' <<<"$tamper_output"; then
  echo "tamper drill unexpectedly passed or missed index 1" >&2
  exit 1
fi
{
  echo "Command: $script_dir/run.sh --check $a_dump $tampered"
  echo "Exit: $tamper_status"
  echo "$tamper_output"
} >"$evidence_dir/sensitivity-tamper.txt"

echo "CAPSTONE PASS: two terminals, SIGKILL/resume, replay, bisect, refusal, and tamper proof"
