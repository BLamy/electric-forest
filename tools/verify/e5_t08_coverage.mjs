#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const baseline = "de9f59940eac1b6624a824965165d1cab5bd5b78";
const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const diff = execFileSync(
  "git",
  ["diff", "--unified=0", "--no-ext-diff", "--no-renames", `${baseline}..${candidate}`],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);

const classifications = new Map([
  [
    "packages/platform/src/gateway.ts",
    ["runtime", "full-write request at metadata offset 5 stages canonical content before append"],
  ],
  [
    "packages/web-hooks/src/useDispatch.ts",
    ["runtime", "network audit observes one POST carrying metadata plus contentEvent"],
  ],
  ["packages/web-hooks/src/index.ts", ["type-export", "build-time API surface; no runtime branch"]],
  [
    "packages/web-hooks/src/useDispatch.test.ts",
    ["deterministic-test", "focused Vitest asserts one request body and one fetch"],
  ],
  [
    "packages/reducers/src/file-content.ts",
    ["runtime", "renamed guide view consumes projected exact bytes in both browser sessions"],
  ],
  [
    "packages/reducers/src/file-content.test.ts",
    ["deterministic-test", "focused Vitest freezes destination-route rename materialization"],
  ],
  [
    "apps/web/src/wiki/useWiki.ts",
    ["runtime", "browser edits at offsets 3, 4, and 5 exercise patch and full-write branches"],
  ],
  [
    "apps/web/src/wiki/useWiki.test.ts",
    ["deterministic-test", "focused Vitest freezes chooser, base, and exact content generation"],
  ],
  [
    "apps/web/src/wiki/WikiEditor.tsx",
    ["runtime", "two-session browser run executes patch, stale refusal, and full-write dispatch"],
  ],
  [
    "apps/web/src/wiki/renderMarkdown.test.ts",
    ["deterministic-test", "focused hostile corpus names the sanitizer assertion used by sabotage"],
  ],
  [
    "apps/web/test/wiki-fixture.ts",
    ["fixture", "literal expected 11-event log compared byte-for-byte by browser oracle"],
  ],
  [
    "apps/web/test/wiki.pw.ts",
    ["verification-harness", "the focused Playwright fallback executes this exact file"],
  ],
  [
    "tools/verify/e5_t08_sensitivity.mjs",
    ["verification-harness", "focused gate executes five causal mutation runs"],
  ],
  [
    "tools/verify/e5_t08_coverage.mjs",
    ["verification-harness", "self-enumerates exact candidate diff and rejects unknown hunks"],
  ],
  [
    "tools/verify/e5_t08_evidence.mjs",
    ["deterministic-verifier", "focused gate independently replays and checks committed artifacts"],
  ],
  ["Makefile", ["gate-wiring", "focused make target executes only E5-T08 builds and checks"]],
  [
    ".eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live/readme.md",
    ["documentation", "verification-log text has no runtime branch"],
  ],
  [
    ".eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live/evidence/e5-t08-golden.digest",
    ["frozen-golden", "browser and independent replay compare against this pre-run digest"],
  ],
]);

const hunks = [];
let file;
for (const line of diff.split("\n")) {
  const fileMatch = /^\+\+\+ b\/(.*)$/.exec(line);
  if (fileMatch !== null) {
    file = fileMatch[1];
    continue;
  }
  const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (hunkMatch === null) continue;
  assert.ok(file !== undefined, "diff hunk has no file");
  const classification = classifications.get(file);
  assert.ok(classification !== undefined, `unclassified E5-T08 hunk: ${file} ${line}`);
  hunks.push({
    file,
    oldStart: hunkMatch[1],
    oldCount: hunkMatch[2] ?? "1",
    newStart: hunkMatch[3],
    newCount: hunkMatch[4] ?? "1",
    kind: classification[0],
    evidence: classification[1],
  });
}
assert.ok(hunks.length > 0, "E5-T08 exact-head diff unexpectedly has no hunks");

const report = [
  "# E5-T08 exact-head per-hunk runtime classification",
  "",
  `baseline=${baseline}`,
  `candidate-head=${candidate}`,
  `classified-hunks=${String(hunks.length)}`,
  "",
  "| file | old hunk | new hunk | class | runtime evidence or waiver |",
  "| --- | ---: | ---: | --- | --- |",
  ...hunks.map(
    (hunk) =>
      `| ${hunk.file} | ${hunk.oldStart},${hunk.oldCount} | ${hunk.newStart},${hunk.newCount} | ${hunk.kind} | ${hunk.evidence} |`,
  ),
  "",
  "behavior=canonical-full-write event=fs.file.write metadata-offset=0000000000000000_0000000000000005 source=WikiEditor+useDispatch+gateway class=runtime exact-bytes=both-sessions+content-stream+blob-replay",
  "behavior=pointer-rename event=fs.rename metadata-offset=0000000000000000_0000000000000006 source=WikiPage.tsx baseline-hunk class=runtime old-route=missing new-route=writer-follower-converged",
  "",
  "E5_T08_COVERAGE_OK",
  "",
].join("\n");

await writeFile(
  resolve(
    root,
    ".eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live/evidence/e5-t08-coverage.md",
  ),
  report,
);
process.stdout.write(
  `E5_T08_COVERAGE_OK baseline=${baseline} candidate=${candidate} hunks=${String(hunks.length)}\n`,
);
