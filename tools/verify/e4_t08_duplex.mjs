import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "../../packages/protocol/dist/src/canonical.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const task = resolve(root, ".eforest/tasks/epic-4-the-roots/E4-T08-ef-watch-duplex-daemon");
const evidence = resolve(task, "evidence");
const vitest = resolve(root, "node_modules/.bin/vitest");
const generated = mkdtempSync(join(tmpdir(), "eforest-e4-t08-proof-"));

try {
  const environment = { ...process.env, CI: "true", EFOREST_E4_T08_EVIDENCE_DIR: generated };
  const run = spawnSync(
    vitest,
    [
      "run",
      "--maxWorkers=1",
      "packages/cli/test/watch-duplex.test.ts",
      "packages/cli/test/watch-command.test.ts",
    ],
    { cwd: root, env: environment, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const convergence = readFileSync(join(generated, "e4-t08-interleaved-convergence.txt"), "utf8");
  assert.match(convergence, /^branch fs mutation count: 5$/m);
  assert.match(convergence, /^logical mutation count: 5$/m);
  assert.match(convergence, /^tree-byte-equal: true$/m);
  assert.doesNotMatch(convergence, /(?:\/private\/tmp|\/Users\/)/);

  const quiescence = readFileSync(join(generated, "e4-t08-quiescence.txt"), "utf8");
  const idleWindow = Number(quiescence.match(/^measured idle window ms: (\d+)$/m)?.[1]);
  assert.ok(Number.isSafeInteger(idleWindow) && idleWindow >= 60_000, quiescence);
  assert.match(quiescence, /^head byte-identical: true$/m);
  const beforeUploaded = Number(quiescence.match(/^uploaded lines before: (\d+)$/m)?.[1]);
  const afterUploaded = Number(quiescence.match(/^uploaded lines after: (\d+)$/m)?.[1]);
  assert.equal(afterUploaded, beforeUploaded, quiescence);

  const audit = readFileSync(join(generated, "e4-t08-journal-audit.txt"), "utf8");
  const journalLines = audit.split("\n").filter((line) => line.startsWith("{"));
  const records = journalLines.map((line) => JSON.parse(line));
  assert.equal(records.length, 8, audit);
  for (const [index, record] of records.entries()) {
    assert.equal(journalLines[index], canonicalJson(record));
  }
  const byOffset = new Map();
  for (const record of records) {
    const entries = byOffset.get(record.offset) ?? [];
    entries.push(record);
    byOffset.set(record.offset, entries);
  }
  for (const entries of byOffset.values()) {
    const dispositions = entries.map((entry) => entry.disposition);
    assert.ok(
      dispositions.length === 1
        ? dispositions[0] === "applied"
        : dispositions.join(",") === "uploaded,suppressed",
      JSON.stringify(entries),
    );
  }
  assert.match(
    audit,
    /^audit: every fs mutation offset classified; own offsets uploaded then suppressed; foreign offsets applied$/m,
  );

  const lifecycle = readFileSync(join(evidence, "e4-t08-lifecycle.txt"), "utf8");
  assert.match(lifecycle, /^second start: exit=3 code=cli\/watch-already-running$/m);
  assert.match(lifecycle, /^stop without daemon: exit=3 code=cli\/watch-not-running$/m);
  assert.match(lifecycle, /^stale pidfile: exit=0 warning-count=1$/m);
  assert.match(lifecycle, /^concurrent starts: exits=0,3 live-winner-count=1$/m);
  assert.doesNotMatch(lifecycle, /(?:\/private\/tmp|\/Users\/|pid=\d+)/);

  const sensitivity = readFileSync(join(evidence, "e4-t08-sensitivity.md"), "utf8");
  assert.equal((sensitivity.match(/EXPECTED-FAIL OK/g) ?? []).length, 4, sensitivity);

  console.log(
    `E4-T08_VERIFY convergence=5/5 idle-ms>=${idleWindow} journal-offsets=${byOffset.size} lifecycle=snapshotted sensitivity=4`,
  );
} finally {
  rmSync(generated, { recursive: true, force: true });
}
