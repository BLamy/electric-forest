#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(root, "packages/platform/fixtures/ns");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces/evidence/e2-t06-golden-digests.txt",
);
const worker = resolve(root, "tools/verify/e2_t06_replay_worker.mjs");
const update = process.argv.includes("--update-evidence");
assert.deepEqual(
  process.argv.slice(2).filter((argument) => argument !== "--update-evidence"),
  [],
  "usage: node tools/verify/e2_t06_evidence.mjs [--update-evidence]",
);

const fixtures = readdirSync(fixtureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(fixtureRoot, entry.name))
  .filter((directory) => {
    try {
      readFileSync(join(directory, "expected.json"));
      return true;
    } catch {
      return false;
    }
  })
  .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
assert.ok(fixtures.length >= 2, "E2-T06 requires at least two golden namespace fixtures");

function run(directory, alternate) {
  const result = spawnSync(process.execPath, [worker, directory], {
    cwd: alternate ? resolve(root, "packages/platform") : root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(alternate ? { LANG: "C", TZ: "Pacific/Kiritimati" } : {}),
    },
  });
  assert.equal(result.status, 0, `${directory}: ${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "", `${directory}: worker wrote stderr`);
  return JSON.parse(result.stdout);
}

const lines = ["E2-T06 golden namespace replay", "processes=two separate node worker invocations"];
for (const directory of fixtures) {
  const first = run(directory, false);
  const second = run(directory, true);
  assert.notEqual(first.pid, second.pid, `${first.fixture}: replay workers reused a pid`);
  assert.deepEqual(
    { ...first, pid: undefined },
    { ...second, pid: undefined },
    `${first.fixture}: replay changed across processes/environments`,
  );
  process.stdout.write(
    `E2_T06_REPLAY_PROCESS fixture=${first.fixture} pid1=${first.pid} pid2=${second.pid}\n`,
  );
  lines.push(
    `fixture=${first.fixture}`,
    "pid-1=<distinct-process-1>",
    "pid-2=<distinct-process-2>",
    `stream-order=${first.streamOrder.join(",")}`,
    ...first.streamOrder.map((id) => `stream-digest ${id}=${first.streamDigests[id]}`),
    `view-digest=${first.viewDigest}`,
    `resolutions=${JSON.stringify(first.resolutions)}`,
  );
}
lines.push("E2_T06_GOLDEN_REPLAY_OK", "");
const transcript = lines.join("\n");
if (update) {
  writeFileSync(evidence, transcript);
} else {
  assert.equal(readFileSync(evidence, "utf8"), transcript, "golden replay evidence drifted");
}
process.stdout.write(transcript);
