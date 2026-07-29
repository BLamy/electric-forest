#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eforest-e3-t02-recorder-"));
const guard = path.join(root, "tools/replay/e3_t02_publish_guard.sh");
const normalizer = path.join(root, "tools/verify/e3_t02_playwright_expression.mjs");
const walkthroughSourcePath = path.join(root, "tools/replay/e3_t02_walkthrough.js");
const normalizedWalkthroughPath = path.join(scratch, "walkthrough-expression.js");
const normalizeResult = spawnSync(
  process.execPath,
  [normalizer, walkthroughSourcePath, normalizedWalkthroughPath],
  { cwd: root, encoding: "utf8" },
);
assert.equal(
  normalizeResult.status,
  0,
  `walkthrough normalization failed\n${normalizeResult.stdout}${normalizeResult.stderr}`,
);
assert.match(normalizeResult.stdout, /E3_T02_PLAYWRIGHT_EXPRESSION_OK/);
const normalizedWalkthrough = fs.readFileSync(normalizedWalkthroughPath, "utf8").trim();
assert.doesNotMatch(normalizedWalkthrough, /;\s*$/);
const walkthrough = vm.runInNewContext(`(${normalizedWalkthrough})`);

function fakePage(injectedFailure) {
  const page = {
    on(event, listener) {
      if (injectedFailure === "console.error" && event === "console") {
        listener({
          type: () => "error",
          text: () => "E3-T02 sensitivity console.error",
        });
      }
      if (injectedFailure === "pageerror" && event === "pageerror") {
        listener(new Error("E3-T02 sensitivity pageerror"));
      }
      if (injectedFailure === "requestfailed" && event === "requestfailed") {
        listener({
          url: () => "http://127.0.0.1:1/sensitivity-request",
          failure: () => ({ errorText: "E3-T02 sensitivity requestfailed" }),
        });
      }
      return page;
    },
    getByTestId(testId) {
      return {
        click: async () => undefined,
        getAttribute: async (attribute) =>
          ({
            "data-ef-stream": "__identity__",
            "data-ef-offset": "0000000000000000_0000000000000001",
            "data-ef-digest": "0".repeat(64),
          })[attribute] ?? null,
        textContent: async () =>
          testId === "identity-sub" ? "auth0|sensitivity" : "sensitivity@example.test",
        waitFor: async () => undefined,
      };
    },
    locator() {
      return { count: async () => 0 };
    },
    getByRole() {
      return { click: async () => undefined };
    },
    waitForURL: async (predicate) => {
      assert.equal(predicate({ pathname: "/" }), true);
    },
    waitForTimeout: async () => undefined,
    evaluate: async (expression) => {
      const source = String(expression);
      if (source.includes("window.location.origin")) return "http://127.0.0.1:1";
      if (source.includes("document.querySelectorAll")) return [];
      if (source.includes('performance.getEntriesByType("navigation")')) return 1;
      throw new Error(`unexpected walkthrough evaluate expression: ${source}`);
    },
    goBack: async () => undefined,
    goForward: async () => undefined,
  };
  return page;
}

function writeTranscripts(label, telemetryFailures, consoleErrors = 0) {
  const caseDir = path.join(scratch, label.replace(/[^a-z0-9.-]+/gi, "-"));
  fs.mkdirSync(caseDir, { recursive: true });
  const walkthrough = path.join(caseDir, "walkthrough.txt");
  const consoleTranscript = path.join(caseDir, "console.txt");
  fs.writeFileSync(
    walkthrough,
    `### Result\n${JSON.stringify({
      origin: "http://127.0.0.1:1",
      triple: { stream: "__identity__", offset: "0", digest: "0".repeat(64) },
      identity: { sub: "auth0|sensitivity", email: "sensitivity@example.test" },
      partialTripleElements: 0,
      documentLoads: { before: 1, after: 1 },
      telemetryFailures,
    })}\n`,
  );
  fs.writeFileSync(
    consoleTranscript,
    `### Result\nTotal messages: ${String(consoleErrors)} (Errors: ${String(consoleErrors)}, Warnings: 0)\n`,
  );
  return { caseDir, consoleTranscript, walkthrough };
}

function drive(label, telemetryFailures, expectedStatus) {
  const paths = writeTranscripts(label, telemetryFailures);
  const marker = path.join(paths.caseDir, "published");
  const markerProgram =
    'require("node:fs").writeFileSync(process.argv[1], "browser-close/upload invoked\\n")';
  const result = spawnSync(
    guard,
    [
      paths.walkthrough,
      paths.consoleTranscript,
      "--",
      process.execPath,
      "-e",
      markerProgram,
      marker,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    expectedStatus,
    `${label}: unexpected status\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return { marker, result };
}

const control = drive("control", [], 0);
assert.equal(fs.readFileSync(control.marker, "utf8"), "browser-close/upload invoked\n");
const cleanWalkthrough = await walkthrough(fakePage());
assert.deepEqual(Array.from(cleanWalkthrough.telemetryFailures), []);
process.stdout.write("control: GREEN publish-count=1\n");

for (const failureClass of ["console.error", "pageerror", "requestfailed"]) {
  await assert.rejects(
    walkthrough(fakePage(failureClass)),
    new RegExp(`recording tripwire.*${failureClass.replace(".", "\\.")}`),
    `${failureClass}: the real walkthrough stayed green`,
  );
  const sabotage = drive(
    failureClass,
    [{ class: failureClass, detail: `E3-T02 sensitivity ${failureClass}` }],
    1,
  );
  assert.equal(
    fs.existsSync(sabotage.marker),
    false,
    `${failureClass}: browser-close/upload marker was published`,
  );
  assert.match(
    `${sabotage.result.stdout}${sabotage.result.stderr}`,
    new RegExp(failureClass.replace(".", "\\.")),
  );
  process.stdout.write(`${failureClass}: EXPECTED-RED exit=1 publish-count=0\n`);
}

const recordSource = fs.readFileSync(path.join(root, "tools/replay/record-e3-t02.sh"), "utf8");
assert.match(
  recordSource,
  /tools\/replay\/e3_t02_publish_guard\.sh[\s\S]*node "\$skill_root\/scripts\/browser-close\.js"/,
  "record workflow does not route browser-close/upload through the guard",
);
assert.match(
  recordSource,
  /playwright-cli -s="\$session" close/,
  "failed recording has no non-publishing browser cleanup",
);
process.stdout.write("E3_T02_RECORDER_SENSITIVITY_OK classes=3 no-publish=3\n");
