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
const finalTelemetrySourcePath = path.join(root, "tools/replay/e3_t02_final_telemetry.js");
const normalizedWalkthroughPath = path.join(scratch, "walkthrough-expression.js");
const normalizedFinalTelemetryPath = path.join(scratch, "final-telemetry-expression.js");
for (const [label, sourcePath, outputPath] of [
  ["walkthrough", walkthroughSourcePath, normalizedWalkthroughPath],
  ["final telemetry", finalTelemetrySourcePath, normalizedFinalTelemetryPath],
]) {
  const normalizeResult = spawnSync(process.execPath, [normalizer, sourcePath, outputPath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(
    normalizeResult.status,
    0,
    `${label} normalization failed\n${normalizeResult.stdout}${normalizeResult.stderr}`,
  );
  assert.match(normalizeResult.stdout, /E3_T02_PLAYWRIGHT_EXPRESSION_OK/);
}
const normalizedWalkthrough = fs.readFileSync(normalizedWalkthroughPath, "utf8").trim();
const normalizedFinalTelemetry = fs.readFileSync(normalizedFinalTelemetryPath, "utf8").trim();
assert.doesNotMatch(normalizedWalkthrough, /;\s*$/);
assert.doesNotMatch(normalizedFinalTelemetry, /;\s*$/);
const walkthrough = vm.runInNewContext(`(${normalizedWalkthrough})`);
const finalTelemetry = vm.runInNewContext(`(${normalizedFinalTelemetry})`);

function fakePage(injectedFailure) {
  const listeners = new Map();
  const page = {
    listeners,
    on(event, listener) {
      listeners.set(event, listener);
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

function writeTranscripts(
  label,
  walkthroughResult,
  finalTelemetryResult,
  consoleErrors = 0,
  requestsTranscript = "### Result\n1. [GET] http://127.0.0.1:1/ => [200] OK\n",
) {
  const caseDir = path.join(scratch, label.replace(/[^a-z0-9.-]+/gi, "-"));
  fs.mkdirSync(caseDir, { recursive: true });
  const walkthroughPath = path.join(caseDir, "walkthrough.txt");
  const finalTelemetryPath = path.join(caseDir, "final-telemetry.txt");
  const consoleTranscript = path.join(caseDir, "console.txt");
  const requestsPath = path.join(caseDir, "requests.txt");
  fs.writeFileSync(walkthroughPath, `### Result\n${JSON.stringify(walkthroughResult)}\n`);
  fs.writeFileSync(finalTelemetryPath, `### Result\n${JSON.stringify(finalTelemetryResult)}\n`);
  fs.writeFileSync(
    consoleTranscript,
    `### Result\nTotal messages: ${String(consoleErrors)} (Errors: ${String(consoleErrors)}, Warnings: 0)\n`,
  );
  fs.writeFileSync(requestsPath, requestsTranscript);
  return {
    caseDir,
    consoleTranscript,
    finalTelemetryPath,
    requestsPath,
    walkthroughPath,
  };
}

function drive(label, walkthroughResult, finalTelemetryResult, expectedStatus, options = {}) {
  const paths = writeTranscripts(
    label,
    walkthroughResult,
    finalTelemetryResult,
    options.consoleErrors,
    options.requestsTranscript,
  );
  const marker = path.join(paths.caseDir, "published");
  const markerProgram =
    'require("node:fs").writeFileSync(process.argv[1], "browser-close/upload invoked\\n")';
  const result = spawnSync(
    guard,
    [
      paths.walkthroughPath,
      paths.finalTelemetryPath,
      paths.consoleTranscript,
      paths.requestsPath,
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

const cleanPage = fakePage();
const cleanWalkthrough = await walkthrough(cleanPage);
assert.deepEqual(Array.from(cleanWalkthrough.telemetryFailures), []);
const cleanFinalTelemetry = await finalTelemetry(cleanPage);
assert.deepEqual(Array.from(cleanFinalTelemetry.telemetryFailures), []);

const control = drive("control", cleanWalkthrough, cleanFinalTelemetry, 0);
assert.equal(fs.readFileSync(control.marker, "utf8"), "browser-close/upload invoked\n");
process.stdout.write("control: GREEN publish-count=1\n");

for (const failureClass of ["console.error", "pageerror", "requestfailed"]) {
  await assert.rejects(
    walkthrough(fakePage(failureClass)),
    new RegExp(`recording tripwire.*${failureClass.replace(".", "\\.")}`),
    `${failureClass}: the real walkthrough stayed green`,
  );
  const telemetryFailures = [{ class: failureClass, detail: `E3-T02 sensitivity ${failureClass}` }];
  const sabotage = drive(
    failureClass,
    { ...cleanWalkthrough, telemetryFailures },
    { ...cleanFinalTelemetry, telemetryFailures },
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

for (const failureClass of ["pageerror", "requestfailed"]) {
  const page = fakePage();
  const walkthroughResult = await walkthrough(page);
  assert.deepEqual(Array.from(walkthroughResult.telemetryFailures), []);
  const persistedWalkthroughResult = JSON.parse(JSON.stringify(walkthroughResult));

  if (failureClass === "pageerror") {
    page.listeners.get("pageerror")(new Error("E3-T02 delayed-after-result pageerror"));
  } else {
    page.listeners.get("requestfailed")({
      url: () => "http://127.0.0.1:1/delayed-after-result",
      failure: () => ({ errorText: "E3-T02 delayed-after-result requestfailed" }),
    });
  }

  const finalTelemetryResult = await finalTelemetry(page);
  assert.equal(finalTelemetryResult.telemetryFailures[0].class, failureClass);
  const sabotage = drive(
    `delayed-after-result-${failureClass}`,
    persistedWalkthroughResult,
    finalTelemetryResult,
    1,
  );
  assert.equal(
    fs.existsSync(sabotage.marker),
    false,
    `${failureClass}: delayed browser-close/upload marker was published`,
  );
  assert.match(`${sabotage.result.stdout}${sabotage.result.stderr}`, new RegExp(failureClass));
  process.stdout.write(`${failureClass}: DELAYED-AFTER-RESULT guard-exit=1 publish-count=0\n`);
}

const requestTranscriptSabotage = drive(
  "request-transcript",
  cleanWalkthrough,
  cleanFinalTelemetry,
  1,
  {
    requestsTranscript:
      "### Result\n1. [GET] http://127.0.0.1:1/late => [FAILED] net::ERR_CONNECTION_RESET\n",
  },
);
assert.equal(fs.existsSync(requestTranscriptSabotage.marker), false);
assert.match(
  `${requestTranscriptSabotage.result.stdout}${requestTranscriptSabotage.result.stderr}`,
  /transport failure/,
);
process.stdout.write("request-transcript: EXPECTED-RED exit=1 publish-count=0\n");

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
assert.match(
  recordSource,
  /requests >"\$work\/requests\.txt"[\s\S]*run-code --filename "\$final_telemetry_expression"[\s\S]*e3_t02_publish_guard\.sh/,
  "record workflow does not snapshot persisted telemetry after post-walkthrough inspection",
);
assert.match(
  recordSource,
  /"\$work\/walkthrough\.txt" "\$work\/final-telemetry\.txt"[\s\S]*"\$work\/console\.txt" "\$work\/requests\.txt"/,
  "record workflow does not pass every final transcript to the publish guard",
);
process.stdout.write(
  "E3_T02_RECORDER_SENSITIVITY_OK immediate=3 delayed=2 request-transcript=1 no-publish=6\n",
);
