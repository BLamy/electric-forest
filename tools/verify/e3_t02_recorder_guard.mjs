#!/usr/bin/env node
import fs from "node:fs";

function fail(message) {
  process.stderr.write(`E3-T02 recorder guard: ${message}\n`);
  process.exit(1);
}

const [walkthroughPath, consolePath] = process.argv.slice(2);
if (!walkthroughPath || !consolePath) {
  fail("usage: e3_t02_recorder_guard.mjs WALKTHROUGH CONSOLE");
}

let walkthrough;
let consoleTranscript;
try {
  walkthrough = fs.readFileSync(walkthroughPath, "utf8");
  consoleTranscript = fs.readFileSync(consolePath, "utf8");
} catch (error) {
  fail(
    `cannot read recorder transcript: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const resultBlock = walkthrough.match(/(?:^|\n)### Result\s*\n(\{[^\n]*\})(?:\n|$)/);
if (!resultBlock) {
  fail("walkthrough has no machine-readable result");
}

let result;
try {
  result = JSON.parse(resultBlock[1]);
} catch (error) {
  fail(`walkthrough result is not JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (!Array.isArray(result.telemetryFailures)) {
  fail("walkthrough result does not expose telemetryFailures");
}
if (result.telemetryFailures.length > 0) {
  const classes = result.telemetryFailures
    .map((entry) => (entry && typeof entry === "object" ? entry.class : String(entry)))
    .join(",");
  fail(`walkthrough reported browser failures: ${classes}`);
}

const summary = consoleTranscript.match(
  /Total messages:\s*(\d+)\s*\(Errors:\s*(\d+),\s*Warnings:\s*(\d+)\)/,
);
if (!summary) {
  fail("Playwright console transcript has no summary");
}
if (Number(summary[2]) !== 0) {
  fail(`Playwright console transcript reported ${summary[2]} error(s)`);
}

process.stdout.write("E3_T02_RECORDER_GUARD_OK telemetry=0 console-errors=0\n");
