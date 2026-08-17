#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(new URL("..", import.meta.url).pathname, "..");
const source = resolve(
  process.env.EFOREST_E4_T11_EVIDENCE_DIR ??
    ".eforest/tasks/epic-4-the-roots/E4-T11-conflict-surfacing/evidence",
);
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-t11-sensitivity-"));
try {
  cpSync(source, scratch, { recursive: true });
  const target = join(scratch, "e4-t11-conflict-file.bin");
  const bytes = readFileSync(target);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  writeFileSync(target, bytes);
  const result = spawnSync(process.execPath, [join(repo, "tools/verify/e4_t11_evidence.mjs")], {
    cwd: repo,
    env: { ...process.env, EFOREST_E4_T11_EVIDENCE_DIR: scratch },
    encoding: "utf8",
  });
  if (result.status === 0) throw new Error("mutated conflict bytes were accepted");
  const output = join(source, "e4-t11-sensitivity.md");
  writeFileSync(
    output,
    `# E4-T11 sensitivity\n\n- Mutated one byte of the surfaced conflict artifact.\n- Evidence verifier failed as expected: EXPECTED-FAIL OK.\n`,
  );
  console.log("E4-T11 sensitivity: EXPECTED-FAIL OK");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
