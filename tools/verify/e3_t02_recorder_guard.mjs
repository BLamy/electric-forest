#!/usr/bin/env node
import fs from "node:fs";

function fail(message) {
  process.stderr.write(`E3-T02 recorder guard: ${message}\n`);
  process.exit(1);
}

const [walkthroughPath, finalTelemetryPath, consolePath, requestsPath] = process.argv.slice(2);
if (!walkthroughPath || !finalTelemetryPath || !consolePath || !requestsPath) {
  fail("usage: e3_t02_recorder_guard.mjs WALKTHROUGH FINAL_TELEMETRY CONSOLE REQUESTS");
}

let walkthrough;
let finalTelemetry;
let consoleTranscript;
let requestsTranscript;
try {
  walkthrough = fs.readFileSync(walkthroughPath, "utf8");
  finalTelemetry = fs.readFileSync(finalTelemetryPath, "utf8");
  consoleTranscript = fs.readFileSync(consolePath, "utf8");
  requestsTranscript = fs.readFileSync(requestsPath, "utf8");
} catch (error) {
  fail(
    `cannot read recorder transcript: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function parseResult(label, transcript) {
  const resultBlock = transcript.match(/(?:^|\n)### Result\s*\n(\{[^\n]*\})(?:\n|$)/);
  if (!resultBlock) {
    fail(`${label} has no machine-readable result`);
  }
  try {
    return JSON.parse(resultBlock[1]);
  } catch (error) {
    fail(`${label} result is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCleanTelemetry(label, result) {
  if (!Array.isArray(result.telemetryFailures)) {
    fail(`${label} result does not expose telemetryFailures`);
  }
  if (result.telemetryFailures.length === 0) {
    return;
  }
  const classes = result.telemetryFailures
    .map((entry) => (entry && typeof entry === "object" ? entry.class : String(entry)))
    .join(",");
  fail(`${label} reported browser failures: ${classes}`);
}

assertCleanTelemetry("walkthrough", parseResult("walkthrough", walkthrough));
assertCleanTelemetry(
  "final telemetry snapshot",
  parseResult("final telemetry snapshot", finalTelemetry),
);

const summary = consoleTranscript.match(
  /Total messages:\s*(\d+)\s*\(Errors:\s*(\d+),\s*Warnings:\s*(\d+)\)/,
);
if (!summary) {
  fail("Playwright console transcript has no summary");
}
if (Number(summary[2]) !== 0) {
  fail(`Playwright console transcript reported ${summary[2]} error(s)`);
}

if (!/(?:^|\n)### Result(?:\n|$)/.test(requestsTranscript)) {
  fail("Playwright requests transcript has no result");
}
const requestFailure = requestsTranscript.match(
  /(?:=>\s*\[(?:FAILED|ERROR)\]|\bnet::ERR_[A-Z_]+\b|\brequestfailed\b)/i,
);
if (requestFailure) {
  fail(`Playwright requests transcript reported a transport failure: ${requestFailure[0]}`);
}

process.stdout.write(
  "E3_T02_RECORDER_GUARD_OK walkthrough-telemetry=0 final-telemetry=0 console-errors=0 request-failures=0\n",
);
