#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
source_fixture=".eforest/tasks/epic-0-the-seed/E0-T05-stream-server-core/evidence/curl-transcript.md"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
mutated="$tmp/curl-transcript.md"
cp "$source_fixture" "$mutated"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const path=process.argv[1]; const text=readFileSync(path,"utf8"); const marker="\"name\": \"read-all\""; const start=text.indexOf(marker); if(start<0) throw new Error("read-all fixture missing"); const status=text.indexOf("\"status\": 200",start); if(status<0) throw new Error("read-all status missing"); writeFileSync(path,text.slice(0,status)+"\"status\": 201"+text.slice(status+"\"status\": 200".length));' "$mutated"

set +e
EFOREST_TRANSCRIPT_PATH="$mutated" bash tools/verify/replay_transcript.sh
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "transcript sensitivity: mutated expected status unexpectedly passed" >&2
  exit 1
fi
echo "transcript sensitivity: mutated read-all status rejected as expected (exit=$status)"
