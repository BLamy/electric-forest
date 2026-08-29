#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T05-issues-ui-live/evidence");
const read = (name) => readFile(resolve(evidence, name), "utf8");

const [
  audit,
  refusal,
  digests,
  events,
  boardEvents,
  sensitivity,
  transcriptBytes,
  coverageBytes,
  replayFallback,
] = await Promise.all([
  read("e5-t05-write-audit.txt"),
  read("e5-t05-refusal.txt"),
  read("e5-t05-digests.txt"),
  read("e5-t05-session.events.jsonl"),
  read("e5-t05-board-projection.events.jsonl"),
  read("e5-t05-sensitivity.md"),
  read("e5-t05-browser-transcript.json"),
  read("e5-t05-browser-source-coverage.json"),
  read("e5-t05-replay-fallback.txt"),
]);

assert.match(audit, /dispatch-posts=8 accepted=7 refused=1 other-state-writes=0/);
assert.match(audit, /E5_T05_WRITE_AUDIT_OK/);
assert.match(refusal, /code=issue\/illegal-transition/);
assert.match(refusal, /http-status=200/);
assert.match(refusal, /x-eforest-refusal-status=409/);
assert.match(refusal, /before-after-log-bytes-equal=true/);
assert.match(refusal, /E5_T05_REFUSAL_OK/);

const facts = Object.fromEntries(
  digests
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
assert.equal(facts["writer-board-digest"], facts["follower-board-digest"]);
assert.equal(facts["follower-board-digest"], facts["endpoint-at-offset-digest"]);
assert.equal(facts["writer-issue-digest"], facts["follower-issue-digest"]);
assert.equal(facts["follower-issue-digest"], facts["replay-issue-digest"]);
assert.match(facts["board-stream"] ?? "", /^issue-board:/);
assert.match(facts["issue-stream"] ?? "", /^issue:/);
assert.ok(
  (facts["latencies-ms"] ?? "")
    .split(",")
    .every((value) => Number.isFinite(Number(value)) && Number(value) <= 2_000),
);
assert.match(digests, /E5_T05_DIGESTS_OK/);

const records = events
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(
  records.map((record) => record.type),
  [
    "issue.opened",
    "issue.commented",
    "issue.commented",
    "issue.labeled",
    "issue.unlabeled",
    "issue.state-changed",
    "issue.state-changed",
  ],
);

const replay = spawnSync(
  process.execPath,
  [
    "packages/cli/dist/src/bin.js",
    "replay",
    resolve(evidence, "e5-t05-session.events.jsonl"),
    "--digest",
    "--reducer",
    "packages/platform/issues-reducer.mjs",
    "--stream-id",
    facts["issue-stream"],
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(replay.status, 0, `${replay.stdout}${replay.stderr}`);
assert.equal(replay.stdout.trim(), facts["replay-issue-digest"]);

const boardRecords = boardEvents
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(boardRecords.length, 8);
assert.deepEqual(
  boardRecords.map((record) => record.offset),
  Array.from(
    { length: 8 },
    (_, index) => `0000000000000000_${String(index).padStart(16, "0")}`,
  ),
);
assert.ok(boardRecords.every((record) => record.type === "issue-board.replaced"));
assert.equal(boardRecords.at(-1).offset, facts["board-offset"]);
const boardReplay = spawnSync(
  process.execPath,
  [
    "packages/cli/dist/src/bin.js",
    "replay",
    resolve(evidence, "e5-t05-board-projection.events.jsonl"),
    "--digest",
    "--reducer",
    "issue-board@1",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(boardReplay.status, 0, `${boardReplay.stdout}${boardReplay.stderr}`);
assert.equal(boardReplay.stdout.trim(), facts["endpoint-at-offset-digest"]);

const transcript = JSON.parse(transcriptBytes);
assert.equal(transcript.schemaVersion, 2);
assert.match(transcript.recordedHead, /^[0-9a-f]{40}$/);
assert.equal(transcript.window, "post-authentication E5-T05 board/detail activity");
assert.ok(Array.isArray(transcript.network) && transcript.network.length > 0);
assert.ok(transcript.network.every((entry) => entry.url.startsWith("/api/")));
assert.ok(
  transcript.network.every((entry) =>
    entry.headers.every(
      ([name, value]) =>
        !["authorization", "cookie", "set-cookie"].includes(name) || value === "<redacted>",
    ),
  ),
);
assert.ok(Array.isArray(transcript.requestFailures));
assert.equal(transcript.requestFailureSummary.observed, transcript.requestFailures.length);
assert.equal(
  transcript.requestFailureSummary.expectedTerminalLongPollFailures,
  transcript.requestFailures.length,
);
assert.equal(transcript.requestFailureSummary.terminalLongPollsAccounted, 4);
assert.equal(transcript.requestFailureSummary.unexpected, 0);
for (const failure of transcript.requestFailures) {
  assert.equal(failure.phase, "terminal-cleanup");
  assert.equal(failure.classification, "expected-terminal-long-poll");
  assert.equal(failure.method, "GET");
  assert.match(failure.errorText, /^net::ERR_/);
  const request = transcript.network.find(
    (entry) =>
      entry.actor === failure.actor &&
      entry.sequence === failure.requestSequence &&
      entry.direction === "request",
  );
  assert.notEqual(request, undefined, `${failure.actor}:${String(failure.requestSequence)}`);
  assert.equal(request.method, failure.method);
  assert.equal(request.url, failure.url);
  const url = new URL(failure.url, "http://transcript.invalid");
  assert.equal(url.searchParams.get("live"), "1");
  assert.equal(url.searchParams.get("waitMs"), "500");
  assert.notEqual(url.searchParams.get("checkpoint"), null);
}
assert.ok(Array.isArray(transcript.terminalLongPolls));
assert.equal(transcript.terminalLongPolls.length, 4);
assert.deepEqual(
  transcript.terminalLongPolls.map((entry) => `${entry.actor}:${entry.surface}`).sort(),
  ["follower:board", "follower:detail", "writer:board", "writer:detail"],
);
for (const terminal of transcript.terminalLongPolls) {
  assert.equal(terminal.method, "GET");
  const request = transcript.network.find(
    (entry) =>
      entry.actor === terminal.actor &&
      entry.sequence === terminal.requestSequence &&
      entry.direction === "request",
  );
  assert.notEqual(request, undefined, `${terminal.actor}:${String(terminal.requestSequence)}`);
  assert.equal(request.method, terminal.method);
  assert.equal(request.url, terminal.url);
  const failure = transcript.requestFailures.find(
    (entry) =>
      entry.actor === terminal.actor &&
      entry.surface === terminal.surface &&
      entry.sequence === terminal.requestFailureSequence,
  );
  assert.equal(terminal.requestfailedObserved, failure !== undefined);
  assert.equal(
    terminal.disposition,
    failure === undefined
      ? "context-closed-without-requestfailed-event"
      : "expected-requestfailed-on-context-close",
  );
  const url = new URL(terminal.url, "http://transcript.invalid");
  assert.equal(url.searchParams.get("live"), "1");
  assert.equal(url.searchParams.get("waitMs"), "500");
  assert.notEqual(url.searchParams.get("checkpoint"), null);
}
assert.deepEqual(transcript.interactions.labelFilter, {
  actor: "follower",
  selectedValue: "bug",
  selectedCards: {
    open: ["live-issue"],
    "in-progress": [],
    done: [],
    closed: [],
    "wont-do": [],
  },
  cardsAfterLabelRemoval: {
    open: [],
    "in-progress": [],
    done: [],
    closed: [],
    "wont-do": [],
  },
  resetValue: "",
  resetCards: {
    open: ["live-issue"],
    "in-progress": [],
    done: [],
    closed: [],
    "wont-do": [],
  },
});
const dispatchTranscript = transcript.network.filter(
  (entry) =>
    entry.actor === "writer" &&
    entry.direction === "request" &&
    entry.method === "POST" &&
    entry.url === "/api/dispatch",
);
assert.equal(dispatchTranscript.length, 8);
assert.deepEqual(
  dispatchTranscript.map(
    (entry) => JSON.parse(Buffer.from(entry.bodyBase64, "base64").toString("utf8")).event.type,
  ),
  [
    "issue.opened",
    "issue.commented",
    "issue.commented",
    "issue.labeled",
    "issue.unlabeled",
    "issue.state-changed",
    "issue.state-changed",
    "issue.closed",
  ],
);
const dispatchResponses = transcript.network.filter(
  (entry) => entry.actor === "writer" && entry.direction === "response" && entry.url === "/api/dispatch",
);
assert.equal(dispatchResponses.length, 8);
const acceptedDispatchResponses = dispatchResponses.filter(
  (entry) =>
    entry.status === 202 &&
    !entry.headers.some(([name]) => name === "x-eforest-refusal-status"),
);
const refusedDispatchResponses = dispatchResponses.filter(
  (entry) =>
    entry.status === 200 &&
    entry.headers.some(
      ([name, value]) => name === "x-eforest-refusal-status" && value === "409",
    ),
);
assert.equal(acceptedDispatchResponses.length, 7);
assert.equal(refusedDispatchResponses.length, 1);
assert.deepEqual(
  JSON.parse(Buffer.from(refusedDispatchResponses[0].bodyBase64, "base64").toString("utf8")),
  {
    error: {
      class: "validator-rejected",
      reason: "issue/illegal-transition",
      message: "issue/illegal-transition",
    },
  },
);
assert.ok(
  transcript.network.some(
    (entry) => entry.actor === "follower" && entry.url.startsWith("/api/repos/maple/reading-room/board"),
  ),
);
assert.ok(
  transcript.network.some(
    (entry) =>
      entry.actor === "follower" &&
      entry.url.startsWith("/api/repos/maple/reading-room/main/events?stream=issue"),
  ),
);
assert.equal(transcript.console.filter((entry) => entry.type === "error").length, 0);
assert.deepEqual(transcript.pageErrors, []);
assert.doesNotMatch(transcriptBytes, /http:\/\/(?:127\.0\.0\.1|localhost):\d+/);
assert.doesNotMatch(transcriptBytes, /E5T05Browser1234!/);

const coverage = JSON.parse(coverageBytes);
assert.equal(coverage.schemaVersion, 2);
assert.equal(coverage.recordedHead, transcript.recordedHead);
assert.equal(coverage.taskDiff.base, "b3968ca3e6caa5919f953d45b13705dbdd4b7f24");
assert.equal(coverage.taskDiff.head, "42df1ae60ab8beab490e0f4e1067ac0bc6e104b9");
const expectedSources = [
  "apps/web/src/issues/IssueBoard.tsx",
  "apps/web/src/issues/IssueDetail.tsx",
  "apps/web/src/issues/useIssues.ts",
  "apps/web/src/route-pages.tsx",
  "apps/web/src/routes.tsx",
  "apps/web/src/styles.css",
  "packages/issues/src/board.ts",
  "packages/reducers/src/index.ts",
  "packages/web-hooks/src/useStreamReducer.ts",
];
assert.deepEqual(
  coverage.sourceFiles.map((entry) => entry.path),
  expectedSources,
);
for (const source of coverage.sourceFiles) {
  const bytes = await readFile(resolve(root, source.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
}
const expectedGeneratedSources = [
  {
    sourcePath: "packages/issues/src/board.ts",
    compiledPath: "packages/issues/dist/src/board.js",
    sourceMapPath: "packages/issues/dist/src/board.js.map",
  },
  {
    sourcePath: "packages/reducers/src/index.ts",
    compiledPath: "packages/reducers/dist/src/index.js",
    sourceMapPath: "packages/reducers/dist/src/index.js.map",
  },
  {
    sourcePath: "packages/web-hooks/src/useStreamReducer.ts",
    compiledPath: "packages/web-hooks/dist/src/useStreamReducer.js",
    sourceMapPath: "packages/web-hooks/dist/src/useStreamReducer.js.map",
  },
];
assert.deepEqual(
  coverage.generatedSources.map(({ sourcePath, compiledPath, sourceMapPath }) => ({
    sourcePath,
    compiledPath,
    sourceMapPath,
  })),
  expectedGeneratedSources,
);
for (const generated of coverage.generatedSources) {
  assert.equal(
    createHash("sha256").update(await readFile(resolve(root, generated.compiledPath))).digest("hex"),
    generated.compiledSha256,
  );
  assert.equal(
    createHash("sha256").update(await readFile(resolve(root, generated.sourceMapPath))).digest("hex"),
    generated.sourceMapSha256,
  );
}
const expectedRequirementIds = [
  "route.issue-board-writer",
  "route.issue-board-follower",
  "route.issue-detail-writer",
  "route.issue-detail-follower",
  "route.global-issues-link",
  "board.writer-live-region",
  "board.follower-live-region",
  "board.create-dispatch",
  "board.follower-label-filter",
  "board.follower-columns-and-cards",
  "detail.writer-live-region",
  "detail.follower-live-region",
  "detail.comment-dispatch",
  "detail.label-dispatch",
  "detail.unlabel-dispatch",
  "detail.legal-transition-dispatch",
  "detail.illegal-transition-submit",
  "detail.illegal-refusal-render",
  "detail.follower-label-render",
  "detail.follower-state-render",
  "detail.follower-timeline-render",
  "binding.issue-actions",
  "binding.typed-refusal",
  "binding.follower-board-hook",
  "binding.writer-create-hook",
  "binding.follower-issue-hook",
  "dependency.use-stream-reducer-bootstrap",
  "dependency.use-stream-reducer-follow",
  "dependency.issue-board-reducer",
  "dependency.issue-board-label-filter",
  "dependency.reducer-registration",
  "style.issue-board",
  "style.issue-detail",
  "style.issue-labels",
  "style.issue-actions",
  "style.issue-timeline",
];
assert.deepEqual(
  coverage.requirements.map((requirement) => requirement.id),
  expectedRequirementIds,
);
const expectedRuntimeSourceClassifications = [
  ["apps/web/src/issues/IssueBoard.tsx", "browser-executed-covered"],
  ["apps/web/src/issues/IssueDetail.tsx", "browser-executed-covered"],
  ["apps/web/src/issues/useIssues.ts", "browser-executed-covered"],
  ["apps/web/src/route-pages.tsx", "browser-executed-covered"],
  ["apps/web/src/routes.tsx", "browser-executed-covered"],
  ["apps/web/src/styles.css", "browser-executed-covered"],
  ["packages/issues/src/board.ts", "browser-executed-covered"],
  ["packages/platform/issues-reducer.mjs", "server-only"],
  ["packages/platform/src/gateway.ts", "server-only"],
  ["packages/platform/src/issues/board-store.ts", "server-only"],
  ["packages/platform/src/issues/reducer.ts", "server-only"],
  ["packages/reducers/src/index.ts", "browser-executed-covered"],
  ["packages/web-hooks/src/useStreamReducer.ts", "browser-executed-covered"],
];
assert.deepEqual(
  coverage.taskDiff.runtimeSources.map((source) => [source.path, source.classification]),
  expectedRuntimeSourceClassifications,
);
for (const source of coverage.taskDiff.runtimeSources) {
  assert.equal(typeof source.reason, "string");
  assert.ok(source.reason.length > 0);
  assert.deepEqual(
    source.requirementIds,
    coverage.requirements
      .filter((requirement) => requirement.file === source.path)
      .map((requirement) => requirement.id),
  );
  if (source.classification === "browser-executed-covered") {
    assert.ok(source.requirementIds.length > 0, source.path);
  } else {
    assert.deepEqual(source.requirementIds, [], source.path);
  }
}
assert.equal(coverage.summary.materialSourceFiles, expectedSources.length);
assert.equal(coverage.summary.runtimeSourcesClassified, expectedRuntimeSourceClassifications.length);
assert.equal(coverage.summary.browserExecutedSources, 9);
assert.equal(coverage.summary.serverOnlySources, 4);
assert.equal(coverage.summary.requirementsTotal, expectedRequirementIds.length);
assert.equal(coverage.summary.requirementsCovered, expectedRequirementIds.length);
assert.equal(new Set(coverage.runs.map((run) => `${run.role}:${run.stage}`)).size, 8);
for (const requirement of coverage.requirements) {
  assert.equal(requirement.covered, true, requirement.id);
  const run = coverage.runs.find(
    (candidate) => candidate.role === requirement.role && candidate.stage === requirement.stage,
  );
  assert.notEqual(run, undefined, requirement.id);
  const independentlyCovered =
    requirement.kind === "js-source"
      ? (run.js.files[requirement.file] ?? []).some(
          (line) => line >= requirement.lineStart && line <= requirement.lineEnd,
        )
      : run.css.selectors.includes(requirement.selector);
  assert.equal(independentlyCovered, true, requirement.id);
}
const criticalCoverage = Object.fromEntries(
  [
    "board.follower-label-filter",
    "detail.label-dispatch",
    "detail.unlabel-dispatch",
    "detail.legal-transition-dispatch",
    "detail.illegal-refusal-render",
    "detail.follower-label-render",
    "detail.follower-state-render",
    "detail.follower-timeline-render",
    "dependency.use-stream-reducer-bootstrap",
    "dependency.use-stream-reducer-follow",
    "dependency.issue-board-reducer",
    "dependency.issue-board-label-filter",
    "dependency.reducer-registration",
  ].map((id) => [id, coverage.requirements.find((requirement) => requirement.id === id)]),
);
for (const [id, requirement] of Object.entries(criticalCoverage)) {
  assert.notEqual(requirement, undefined, id);
}
assert.equal(criticalCoverage["board.follower-label-filter"].stage, "mutation");
assert.equal(criticalCoverage["board.follower-label-filter"].role, "follower-board");
assert.equal(criticalCoverage["detail.label-dispatch"].role, "writer-detail");
assert.equal(criticalCoverage["detail.unlabel-dispatch"].role, "writer-detail");
assert.equal(criticalCoverage["detail.legal-transition-dispatch"].role, "writer-detail");
assert.equal(criticalCoverage["detail.illegal-refusal-render"].role, "writer-detail");
assert.equal(criticalCoverage["detail.follower-label-render"].role, "follower-detail");
assert.equal(criticalCoverage["detail.follower-state-render"].role, "follower-detail");
assert.equal(criticalCoverage["detail.follower-timeline-render"].role, "follower-detail");
for (const id of [
  "detail.label-dispatch",
  "detail.unlabel-dispatch",
  "detail.legal-transition-dispatch",
  "detail.illegal-refusal-render",
  "detail.follower-label-render",
  "detail.follower-state-render",
  "detail.follower-timeline-render",
  "dependency.use-stream-reducer-follow",
  "dependency.issue-board-reducer",
  "dependency.issue-board-label-filter",
]) {
  assert.equal(criticalCoverage[id].stage, "mutation", id);
}
assert.equal(criticalCoverage["dependency.use-stream-reducer-bootstrap"].stage, "initial");
assert.equal(criticalCoverage["dependency.reducer-registration"].stage, "initial");
for (const id of [
  "dependency.use-stream-reducer-bootstrap",
  "dependency.use-stream-reducer-follow",
  "dependency.issue-board-reducer",
  "dependency.issue-board-label-filter",
  "dependency.reducer-registration",
]) {
  assert.equal(criticalCoverage[id].role, "follower-board", id);
}

assert.match(replayFallback, /^E5-T05 Replay fallback$/m);
assert.match(replayFallback, /^command=tools\/replay\/preflight\.sh$/m);
assert.match(replayFallback, /^failing-probe=npx -y replayio mcp$/m);
assert.match(replayFallback, /^probe-exit=1$/m);
assert.match(replayFallback, /^probe-stderr=error: unknown command 'mcp'$/m);
assert.match(
  replayFallback,
  /Replay: N\/A \(tools\/replay\/preflight\.sh cannot initialize Replay MCP because `npx -y replayio mcp` exits 1 with `error: unknown command 'mcp'`\) \+ mitigation:/,
);

for (const marker of [
  "drop-watcher-frame sensor=watcher-live-sync",
  "stale-board-offset sensor=board-at-offset-parity",
  "phantom-board-card sensor=board-literal-equality",
]) {
  assert.match(sensitivity, new RegExp(marker));
}
assert.match(sensitivity, /E5_T05_SENSITIVITY_OK cases=3/);

process.stdout.write(
  `E5_T05_EVIDENCE_OK board_offset=${facts["board-offset"]} issue_offset=${facts["issue-offset"]} api_entries=${String(transcript.network.length)} requestfailed_observed=${String(transcript.requestFailures.length)} terminal_long_polls=4 requestfailed_unexpected=0 browser_sources=${String(expectedSources.length)} runtime_sources_classified=${String(expectedRuntimeSourceClassifications.length)} coverage_requirements=${String(expectedRequirementIds.length)}\n`,
);
