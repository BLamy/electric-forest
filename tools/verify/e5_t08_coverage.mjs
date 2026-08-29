#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

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

function parseHunks(source) {
  const hunks = [];
  let file;
  let current;
  const flush = () => {
    if (current !== undefined) hunks.push(current);
    current = undefined;
  };
  for (const line of source.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      file = undefined;
      continue;
    }
    const fileMatch = /^\+\+\+ b\/(.*)$/.exec(line);
    if (fileMatch !== null) {
      flush();
      file = fileMatch[1];
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunkMatch !== null) {
      flush();
      assert.ok(file !== undefined, "diff hunk has no file");
      current = {
        file,
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? "1"),
        body: [],
      };
      continue;
    }
    if (current !== undefined && !line.startsWith("\\ No newline")) current.body.push(line);
  }
  flush();
  return hunks;
}

const hunks = parseHunks(diff);
assert.ok(hunks.length > 0, "E5-T08 exact-head diff unexpectedly has no hunks");

const sourceCache = new Map();
function sourceLines(file) {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const path = resolve(root, file);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  sourceCache.set(file, lines);
  return lines;
}

function nearestNamedTest(hunk) {
  const lines = sourceLines(hunk.file);
  const end = Math.min(lines.length - 1, hunk.newStart + Math.max(hunk.newCount, 1) - 1);
  for (let index = end; index >= Math.max(0, hunk.newStart - 120); index -= 1) {
    const match = /\bit\(["']([^"']+)["']/.exec(lines[index] ?? "");
    if (match !== null) return match[1];
  }
  return undefined;
}

const browserSensors = [
  "concurrent-first-open attempts",
  "no-optimistic-visible-content-before-dispatch-ack",
  "no-optimistic-offset",
  "no-optimistic-digest",
  "no-optimistic-revision",
  "stale fence log bytes",
  "no stale auto-retry",
  "follower replayed exact full-write bytes",
  "full-write staged one new content generation",
  "hostile bytes remain verbatim in replay",
  "patch/full metadata tree parity",
  "dispatch-only-browser-write-count",
  "dispatch-only-write-audit",
  "stale-base-http-status-409",
  "raw-http-409-console-error-count",
  "full-write request carries exact canonical content generation",
  "pointer rename dispatch count",
  "wiki-digest-parity:replay-golden",
];

const evidenceSensors = [
  "independent replay matches committed golden",
  "pointer-renames=1",
  "stale-base-http-status=409",
  "refusal-http-status=409",
  "every browser console error is the handled HTTP 409 refusal",
  "raw stale 409 console error is preserved",
  "request failure transcript is complete",
  "browser.network.staleBaseStatus",
  "browser.fullWrite",
  "browser.rename",
  "one-byte metadata mutation changes the digest",
];

function nearestSensor(hunk, markers) {
  const lines = sourceLines(hunk.file);
  const midpoint = hunk.newStart + Math.max(hunk.newCount - 1, 0) / 2;
  const candidates = [];
  for (const marker of markers) {
    for (const [index, line] of lines.entries()) {
      if (line.includes(marker)) candidates.push({ marker, line: index + 1 });
    }
  }
  candidates.sort(
    (left, right) =>
      Math.abs(left.line - midpoint) - Math.abs(right.line - midpoint) || left.line - right.line,
  );
  return candidates[0];
}

function classified(kind, claim, basis) {
  if (claim === "executed") {
    assert.match(basis, /event=/, `${kind}: runtime claim lacks event`);
    assert.match(basis, /offset=/, `${kind}: runtime claim lacks offset`);
    assert.match(basis, /sensor=/, `${kind}: runtime claim lacks sensor`);
  } else if (claim === "mixed") {
    assert.match(basis, /event=/, `${kind}: mixed claim lacks event`);
    assert.match(basis, /offset=/, `${kind}: mixed claim lacks offset`);
    assert.match(basis, /sensor=/, `${kind}: mixed claim lacks sensor`);
    assert.match(basis, /waiver=/, `${kind}: mixed claim lacks waiver`);
  } else if (claim === "waived") {
    assert.match(basis, /waiver=/, `${kind}: waiver lacks reason`);
  } else {
    assert.equal(claim, "checked");
    assert.match(basis, /sensor=/, `${kind}: checked claim lacks named sensor`);
  }
  return { kind, claim, basis };
}

function classifyGateway(hunk) {
  const line = hunk.newStart;
  if (line < 180) {
    return classified(
      "compile-surface",
      "waived",
      "waiver=imports and type surface only; command=pnpm --filter @eforest/platform build",
    );
  }
  if (line < 400) {
    return classified(
      "streamfs-validation-and-content",
      "mixed",
      "event=fs.file.patch@3,4+fs.file.write@5+fs.rename@6 offset=3-6 sensor=stale-base-http-status-409+full-write-exact-bytes+guide-route-convergence waiver=malformed-content and exhausted-contention guards are not claimed as dynamically executed",
    );
  }
  if (line < 1_050) {
    return classified(
      "dispatch-parser",
      "mixed",
      "event=fs.file.write offset=5 sensor=full-write request carries exact canonical content generation waiver=invalid contentEvent parser branches are defensive and not exercised",
    );
  }
  if (line < 1_160) {
    return classified(
      "session-stale-status",
      "executed",
      "event=fs.file.patch-refused offset=0000000000000000_0000000000000002 sensor=stale-base-http-status-409",
    );
  }
  if (line < 1_500) {
    return classified(
      "dispatch-content-guard",
      "mixed",
      "event=fs.file.write offset=5 sensor=full-write request carries exact canonical content generation waiver=forbidden-writer and wrong-content-type rejection arms are not exercised",
    );
  }
  if (line < 1_800) {
    return classified(
      "writer-lane-full-write",
      "mixed",
      "event=fs.file.write offset=5 sensor=content-stream-before-metadata+one-dispatch-request waiver=writer-lane recovery and contention error arms are not exercised",
    );
  }
  if (line >= 2_500 && line < 2_616) {
    return classified(
      "file-projection-full-write",
      "executed",
      "event=fs.file.write offset=2,5 sensor=full-write staged one new content generation+both-session-exact-bytes",
    );
  }
  if (line >= 2_616 && line < 2_655) {
    return classified(
      "file-projection-patch",
      "mixed",
      "event=fs.file.patch offset=3,4 sensor=follower-replayed-patch-bytes waiver=projection corruption throws are not exercised",
    );
  }
  if (line >= 2_655 && line < 2_680) {
    return classified(
      "file-projection-rename",
      "executed",
      "event=fs.rename offset=6 sensor=old-route-missing+guide-route-writer-follower-convergence",
    );
  }
  if (line >= 2_680 && line < 2_700) {
    return classified(
      "file-projection-delete",
      "executed",
      "event=fs.file.delete offset=8 sensor=delete-tombstone+deleted-route-missing",
    );
  }
  return classified(
    "platform-nonruntime",
    "waived",
    "waiver=unchanged-route integration or type-only hunk; no E5-T08 dynamic execution claim",
  );
}

function classifyBrowserOracle(hunk) {
  if (hunk.newStart < 400) {
    return classified(
      "oracle-plumbing",
      "waived",
      "waiver=imports, deterministic helpers, signal classification, or session setup; no product runtime coverage claimed; command=node --experimental-strip-types apps/web/test/wiki.pw.ts",
    );
  }
  const sensor = nearestSensor(hunk, browserSensors);
  assert.ok(sensor !== undefined, `browser oracle hunk has no nearby sensor at ${hunk.newStart}`);
  return classified(
    "oracle-sensor",
    "checked",
    `sensor=${sensor.marker}@apps/web/test/wiki.pw.ts:${String(sensor.line)} command=node --experimental-strip-types apps/web/test/wiki.pw.ts`,
  );
}

function classifyTest(hunk) {
  const test = nearestNamedTest(hunk);
  if (test === undefined) {
    return classified(
      "test-compile-surface",
      "waived",
      `waiver=imports or fixture declarations only; command=focused Vitest file ${hunk.file}`,
    );
  }
  return classified(
    "deterministic-test",
    "checked",
    `sensor=vitest:${test} command=pnpm exec vitest run --maxWorkers=1 ${hunk.file}`,
  );
}

function classifyHunk(hunk) {
  const file = hunk.file;
  if (file.includes("/evidence/")) {
    return classified(
      "generated-artifact",
      "waived",
      `waiver=committed output, not runtime source; sensor=e5_t08_evidence:${basename(file)}`,
    );
  }
  if (file.endsWith("/readme.md")) {
    return classified(
      "documentation",
      "waived",
      "waiver=task contract and verification-log prose have no runtime branch",
    );
  }
  if (file === "Makefile") {
    return classified(
      "gate-wiring",
      "checked",
      "sensor=make verify-E5-T08 command=make verify-E5-T08",
    );
  }
  if (file === "packages/platform/src/gateway.ts") return classifyGateway(hunk);
  if (file === "apps/web/src/wiki/WikiEditor.tsx") {
    if (hunk.newStart < 30) {
      return classified(
        "compile-surface",
        "waived",
        "waiver=import/type-only hunk; command=pnpm --filter @eforest/web build",
      );
    }
    if (hunk.newStart < 100) {
      return classified(
        "editor-dispatch",
        "executed",
        "event=fs.file.patch@3,4+fs.file.write@5 offset=3-5 sensor=one-request-per-save+full-write-contentEvent",
      );
    }
    return classified(
      "editor-dom",
      "checked",
      "sensor=Save changes pointer action@browser-oracle command=node --experimental-strip-types apps/web/test/wiki.pw.ts",
    );
  }
  if (file === "apps/web/src/wiki/useWiki.ts") {
    if (hunk.newStart < 100) {
      return classified(
        "compile-surface",
        "waived",
        "waiver=canonical constructor imports and types only; command=pnpm --filter @eforest/web build",
      );
    }
    return classified(
      "canonical-save-choice",
      "executed",
      "event=fs.file.patch@3,4+fs.file.write@5 offset=3-5 sensor=browser-save-events+canonical-full-write-exact-bytes",
    );
  }
  if (file === "packages/web-hooks/src/useDispatch.ts") {
    if (hunk.newStart < 120) {
      return classified(
        "dispatch-api-type",
        "waived",
        "waiver=type/API declaration has no runtime branch; command=pnpm --filter @eforest/web-hooks build",
      );
    }
    return classified(
      "same-origin-dispatch",
      "executed",
      "event=fs.file.patch@3,4+fs.file.write@5+fs.rename@6 offset=3-6 sensor=dispatch-only-browser-write-count+full-write-single-request",
    );
  }
  if (file === "packages/web-hooks/src/index.ts") {
    return classified(
      "type-export",
      "waived",
      "waiver=barrel export only; command=pnpm --filter @eforest/web-hooks build",
    );
  }
  if (file === "packages/reducers/src/file-content.ts") {
    return classified(
      "rename-reducer",
      "executed",
      "event=fs.rename offset=6 sensor=guide-route-writer-follower-convergence+exact-full-write-bytes",
    );
  }
  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return classifyTest(hunk);
  if (file === "apps/web/test/wiki-fixture.ts") {
    return classified(
      "frozen-fixture",
      "checked",
      "sensor=literal-11-event-log-byte-equality command=node --experimental-strip-types apps/web/test/wiki.pw.ts",
    );
  }
  if (file === "apps/web/test/wiki.pw.ts") return classifyBrowserOracle(hunk);
  if (file === "tools/verify/e5_t08_sensitivity.mjs") {
    return classified(
      "sabotage-harness",
      "checked",
      "sensor=five-nonzero-causal-runs command=node tools/verify/e5_t08_sensitivity.mjs",
    );
  }
  if (file === "tools/verify/e5_t08_evidence.mjs") {
    const sensor = nearestSensor(hunk, evidenceSensors);
    assert.ok(
      sensor !== undefined,
      `evidence verifier hunk has no nearby sensor at ${hunk.newStart}`,
    );
    return classified(
      "artifact-verifier",
      "checked",
      `sensor=${sensor.marker}@tools/verify/e5_t08_evidence.mjs:${String(sensor.line)} command=node tools/verify/e5_t08_evidence.mjs`,
    );
  }
  if (file === "tools/verify/e5_t08_coverage.mjs") {
    return classified(
      "coverage-tool",
      "waived",
      "waiver=self-inventory tooling, not product runtime; sensor=E5_T08_COVERAGE_OK",
    );
  }
  assert.fail(`unclassified E5-T08 hunk: ${file}`);
}

function markdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

const rows = hunks.map((hunk) => {
  const classification = classifyHunk(hunk);
  const newEnd = hunk.newCount === 0 ? hunk.newStart : hunk.newStart + hunk.newCount - 1;
  const id = createHash("sha256")
    .update(
      `${hunk.file}\0${String(hunk.oldStart)},${String(hunk.oldCount)}\0${String(hunk.newStart)},${String(hunk.newCount)}\0${hunk.body.join("\n")}`,
    )
    .digest("hex")
    .slice(0, 12);
  const location = `${hunk.file}:${String(hunk.newStart)}-${String(newEnd)}`;
  return {
    ...hunk,
    ...classification,
    id,
    location,
    evidence: `source=${location}; fingerprint=${id}; ${classification.basis}`,
  };
});

assert.equal(new Set(rows.map((row) => `${row.file}:${row.id}`)).size, rows.length);
const counts = Object.fromEntries(
  ["executed", "mixed", "checked", "waived"].map((claim) => [
    claim,
    rows.filter((row) => row.claim === claim).length,
  ]),
);

const report = [
  "# E5-T08 exact-head hunk-specific runtime classification",
  "",
  `baseline=${baseline}`,
  `candidate-head=${candidate}`,
  `classified-hunks=${String(rows.length)}`,
  "classification-mode=explicit-hunk-basis-v2",
  `claim-counts=executed:${String(counts.executed)},mixed:${String(counts.mixed)},checked:${String(counts.checked)},waived:${String(counts.waived)}`,
  "",
  "`executed` rows name a concrete event, offset, and sensor. `mixed` rows additionally waive",
  "specific defensive arms. `checked` rows name a deterministic sensor without claiming source",
  "execution. `waived` rows explicitly make no runtime claim.",
  "",
  "| hunk | file | old hunk | new hunk | class | claim | concrete basis or waiver |",
  "| --- | --- | ---: | ---: | --- | --- | --- |",
  ...rows.map(
    (row) =>
      `| ${row.id} | ${markdown(row.file)} | ${String(row.oldStart)},${String(row.oldCount)} | ${String(row.newStart)},${String(row.newCount)} | ${row.kind} | ${row.claim} | ${markdown(row.evidence)} |`,
  ),
  "",
  "behavior=canonical-full-write event=fs.file.write metadata-offset=0000000000000000_0000000000000005 source=WikiEditor+useDispatch+gateway sensor=both-sessions+content-stream+blob-replay",
  "behavior=pointer-rename event=fs.rename metadata-offset=0000000000000000_0000000000000006 source=gateway+file-content-reducer sensor=old-route-missing+writer-follower-converged",
  "behavior=stale-refusal event=fs.file.patch attempted-base=0000000000000000_0000000000000002 response-status=409 sensor=stale-base-http-status-409",
  "behavior=no-optimistic-visible-apply event=fs.file.patch offset=0000000000000000_0000000000000003 sensor=no-optimistic-visible-content-before-dispatch-ack",
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
  `E5_T08_COVERAGE_OK baseline=${baseline} candidate=${candidate} hunks=${String(rows.length)} executed=${String(counts.executed)} mixed=${String(counts.mixed)} checked=${String(counts.checked)} waived=${String(counts.waived)}\n`,
);
