#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
cd "${root}"

evidence="${root}/.eforest/tasks/epic-5-the-meadow/E5-T13-issue-to-merge/evidence"
session="${evidence}/e5-t13-session"
if [[ "${session}" != "${evidence}/e5-t13-session" ]]; then
  echo "refusing unsafe E5-T13 evidence cleanup" >&2
  exit 2
fi
if [[ -d "${session}" ]]; then
  rm -r -- "${session}"
fi
for artifact in \
  e5-t13-actor-final.png \
  e5-t13-browser.json \
  e5-t13-content-stream.jsonl \
  e5-t13-content-stream.jsonl.sha256 \
  e5-t13-digests.txt \
  e5-t13-evidence-stream.jsonl \
  e5-t13-evidence-stream.jsonl.sha256 \
  e5-t13-issue-log.jsonl \
  e5-t13-issue-log.jsonl.sha256 \
  e5-t13-main-log.jsonl \
  e5-t13-main-log.jsonl.sha256 \
  e5-t13-no-database.txt \
  e5-t13-pr-log.jsonl \
  e5-t13-pr-log.jsonl.sha256 \
  e5-t13-branch-log.jsonl \
  e5-t13-branch-log.jsonl.sha256 \
  e5-t13-sensitivity.md \
  e5-t13-timeline.txt \
  e5-t13-transcript.txt \
  e5-t13-wiki-log.jsonl \
  e5-t13-wiki-log.jsonl.sha256 \
  e5-t13-witness-pr-final.png \
  e5-t13-witness-wiki-final.png
do
  rm -f -- "${evidence}/${artifact}"
done

{
  node --experimental-strip-types apps/web/test/capstone-e5.pw.ts
  node tools/verify/capstone_e5.mjs
  node tools/verify/no_database_audit.mjs "${root}" | tee "${evidence}/e5-t13-no-database.txt"
} 2>&1 | tee "${evidence}/e5-t13-transcript.txt"
