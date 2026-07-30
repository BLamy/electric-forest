#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import {
  runRecorderLifecycle,
  validateMp4,
  validateTerminalJournal,
} from "../replay/e3_t02_recorder_lifecycle.mjs";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eforest-e3-t02b-recorder-"));
const session = "e3-t02b-sensitivity";
let cases = 0;
let transcript = "# E3-T02b atomic recorder sensitivity\n\n";
function emit(line) {
  transcript += line;
  process.stdout.write(line);
}

function normalizedFunction(sourceName) {
  const source = path.join(root, "tools/replay", sourceName);
  const output = path.join(scratch, `${sourceName}.normalized.js`);
  const result = spawnSync(
    process.execPath,
    [path.join(root, "tools/verify/e3_t02_playwright_expression.mjs"), source, output],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return vm.runInNewContext(`(${fs.readFileSync(output, "utf8").trim()})`);
}

const walkthrough = normalizedFunction("e3_t02_walkthrough.js");
const finalTelemetry = normalizedFunction("e3_t02_final_telemetry.js");

function fakePage(injectedFailure) {
  const listeners = new Map();
  const page = {
    listeners,
    on(event, listener) {
      listeners.set(event, listener);
      if (injectedFailure === "console.error" && event === "console") {
        listener({ type: () => "error", text: () => "sensitivity console" });
      }
      if (injectedFailure === "pageerror" && event === "pageerror") {
        listener(new Error("sensitivity pageerror"));
      }
      if (injectedFailure === "requestfailed" && event === "requestfailed") {
        listener({
          url: () => "http://127.0.0.1:1/red",
          failure: () => ({ errorText: "sensitivity requestfailed" }),
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
    locator: () => ({ count: async () => 0 }),
    getByRole: () => ({ click: async () => undefined }),
    waitForURL: async (predicate) => assert.equal(predicate({ pathname: "/" }), true),
    waitForTimeout: async () => undefined,
    evaluate: async (expression) => {
      const source = String(expression);
      if (source.includes("window.location.href")) {
        return "http://127.0.0.1:49152/authorize?state=sensitivity-state&nonce=sensitivity-nonce&code_challenge=sensitivity-challenge";
      }
      if (source.includes("window.location.origin")) return "http://127.0.0.1:1";
      if (source.includes("document.querySelectorAll")) return [];
      if (source.includes('performance.getEntriesByType("navigation")')) return 1;
      throw new Error(`unexpected evaluate: ${source}`);
    },
    goBack: async () => undefined,
    goForward: async () => undefined,
  };
  return page;
}

for (const failureClass of ["console.error", "pageerror", "requestfailed"]) {
  await assert.rejects(walkthrough(fakePage(failureClass)), /recording tripwire/);
  emit(`${failureClass}: REAL-WALKTHROUGH EXPECTED-RED\n`);
}
const cleanPage = fakePage();
const cleanWalkthrough = await walkthrough(cleanPage);
const cleanFinal = await finalTelemetry(cleanPage);
assert.deepEqual(Array.from(cleanFinal.telemetryFailures), []);

function baseCase(label) {
  const directory = path.join(scratch, label);
  fs.mkdirSync(directory, { recursive: true });
  const paths = {
    directory,
    journalPath: path.join(directory, "journal.jsonl"),
    walkthroughPath: path.join(directory, "walkthrough.txt"),
    finalTelemetryPath: path.join(directory, "final.txt"),
    consolePath: path.join(directory, "console.txt"),
    requestsPath: path.join(directory, "requests.txt"),
    videoPath: path.join(directory, "video.mp4"),
    receiptPath: path.join(directory, "receipt.json"),
    recordingDirectory: path.join(directory, "replay-process"),
  };
  fs.mkdirSync(paths.recordingDirectory);
  fs.writeFileSync(
    paths.journalPath,
    [
      { v: 1, session, seq: 1, phase: "OPEN", kind: "transition", to: "OPEN" },
      {
        v: 1,
        session,
        seq: 2,
        phase: "SEALING",
        kind: "transition",
        to: "SEALING",
        activity: 0,
        failureCount: 0,
        stableSamples: 2,
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  fs.writeFileSync(paths.walkthroughPath, `### Result\n${JSON.stringify(cleanWalkthrough)}\n`);
  fs.writeFileSync(
    paths.finalTelemetryPath,
    `### Result\n${JSON.stringify({ ...cleanFinal, v: 1, session, phase: "SEALING" })}\n`,
  );
  fs.writeFileSync(paths.consolePath, "### Result\nTotal messages: 0 (Errors: 0, Warnings: 0)\n");
  fs.writeFileSync(paths.requestsPath, "### Result\n1. [GET] / => [200] OK\n");
  fs.writeFileSync(paths.videoPath, "fixture-video");
  const fixtureRecordingId = "00000000-0000-4000-8000-000000000001";
  const fixtureSourceMapId = "a".repeat(64);
  const fixtureSourceMapUrl = "http://127.0.0.1:49152/index.js.map";
  const fixtureSourceUrl = "http://127.0.0.1:49152/index.js";
  const fixtureRecordingPath = path.join(
    paths.recordingDirectory,
    `recording-${fixtureRecordingId}.dat`,
  );
  const fixtureSourceMapPath = path.join(
    paths.recordingDirectory,
    `sourcemap-${fixtureSourceMapId}.map`,
  );
  fs.writeFileSync(fixtureRecordingPath, "fixture-recording");
  fs.writeFileSync(
    fixtureSourceMapPath,
    JSON.stringify({ version: 3, file: "index.js", sources: [], names: [], mappings: "" }),
  );
  fs.writeFileSync(
    path.join(paths.recordingDirectory, "recordings.log"),
    [
      {
        buildId: "fixture-build",
        driverVersion: "fixture-driver",
        id: fixtureRecordingId,
        kind: "createRecording",
        timestamp: 1,
      },
      {
        id: fixtureRecordingId,
        kind: "addMetadata",
        metadata: { uri: cleanWalkthrough.authorizationUrl },
        timestamp: 1,
      },
      {
        id: fixtureRecordingId,
        kind: "addMetadata",
        metadata: { process: "root" },
        timestamp: 1,
      },
      {
        id: fixtureRecordingId,
        kind: "writeStarted",
        path: fixtureRecordingPath,
        timestamp: 2,
      },
      {
        baseURL: fixtureSourceMapUrl,
        id: fixtureSourceMapId,
        kind: "sourcemapAdded",
        path: fixtureSourceMapPath,
        recordingId: fixtureRecordingId,
        targetContentHash: `sha256:${fixtureSourceMapId}`,
        targetMapURLHash: `sha256:${crypto.createHash("sha256").update(fixtureSourceMapUrl).digest("hex")}`,
        targetURLHash: `sha256:${crypto.createHash("sha256").update(fixtureSourceUrl).digest("hex")}`,
        timestamp: 2,
        url: fixtureSourceMapUrl,
      },
      { id: fixtureRecordingId, kind: "writeFinished", timestamp: 3 },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  return paths;
}

function closeReceipt(paths) {
  return {
    status: 0,
    stdout: JSON.stringify({
      browser_close: "ok",
      video: { output: paths.videoPath, bytes: 13, mime: "video/mp4" },
      upload: { result: { ok: true, stdout: "Upload skipped by --upload false." } },
    }),
    stderr: "",
  };
}

function runCase(label, mutate = () => {}, dependencies = {}) {
  const paths = baseCase(label);
  mutate(paths);
  let publicationCount = 0;
  const recordingId = "00000000-0000-4000-8000-000000000001";
  const merged = {
    close: dependencies.closeFactory?.(paths) ?? dependencies.close ?? (() => closeReceipt(paths)),
    validateVideo: () => undefined,
    listRecordings: () => [
      {
        id: recordingId,
        recordingStatus: "finished",
        metadata: {
          uri: cleanWalkthrough.authorizationUrl,
        },
        path: path.join(paths.recordingDirectory, `recording-${recordingId}.dat`),
      },
    ],
    publish: ({ recordingDirectory, manifest }) => {
      assert.equal(fs.existsSync(paths.recordingDirectory), false);
      assert.equal(
        path
          .basename(recordingDirectory)
          .startsWith(`${path.basename(paths.recordingDirectory)}.sealed-`),
        true,
      );
      for (const entry of manifest) {
        assert.equal(
          crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(recordingDirectory, entry.name)))
            .digest("hex"),
          entry.sha256,
        );
      }
      publicationCount += 1;
      return { status: 0, stdout: "uploaded", stderr: "" };
    },
    ...Object.fromEntries(
      Object.entries(dependencies).filter(
        ([name]) => !["closeFactory", "close", "recordingId"].includes(name),
      ),
    ),
  };
  return {
    paths,
    publicationCount: () => publicationCount,
    invoke: () =>
      runRecorderLifecycle(
        {
          ...paths,
          cwd: root,
          session,
          recordingId: dependencies.recordingId ?? recordingId,
          browserClosePath: "/unused/browser-close.js",
        },
        merged,
      ),
  };
}

const control = runCase("clean-control");
const receipt = control.invoke();
assert.equal(receipt.publicationCount, 1);
assert.equal(control.publicationCount(), 1);
emit(
  "clean-control: GREEN lifecycle=OPEN>SEALING>CLOSED>DECIDED_CLEAN>PUBLISHING sealed-snapshot=true publish-count=1\n",
);

function appendFailure(paths, failureClass, phase = "SEALING") {
  const records = fs.readFileSync(paths.journalPath, "utf8").trimEnd().split("\n").map(JSON.parse);
  records.push({
    v: 1,
    session,
    seq: records.length + 1,
    phase,
    kind: "failure",
    failure: { class: failureClass, detail: `${failureClass} sensitivity` },
  });
  fs.writeFileSync(paths.journalPath, `${records.map(JSON.stringify).join("\n")}\n`);
}

for (const timing of [
  "walkthrough",
  "after-serialization",
  "after-final-sample",
  "while-close-begins",
]) {
  for (const failureClass of ["console.error", "pageerror", "requestfailed"]) {
    const label = `${timing}-${failureClass}`;
    const attack =
      timing === "while-close-begins"
        ? runCase(label, undefined, {
            closeFactory: (paths) => () => {
              appendFailure(paths, failureClass);
              return closeReceipt(paths);
            },
          })
        : runCase(label, (paths) => appendFailure(paths, failureClass));
    assert.throws(attack.invoke, /browser failure/);
    assert.equal(fs.existsSync(attack.paths.receiptPath), false);
    emit(`${label}: EXPECTED-RED publish-count=0 receipt=0\n`);
    cases += 1;
  }
}

const schemaMutations = [
  [
    "unknown-version",
    (record) => {
      record.v = 2;
    },
  ],
  [
    "wrong-session",
    (record) => {
      record.session = "other";
    },
  ],
  [
    "sequence-gap",
    (record) => {
      record.seq = 7;
    },
  ],
  [
    "unknown-phase",
    (record) => {
      record.phase = record.to = "QUIET";
    },
  ],
  [
    "missing-stable",
    (record) => {
      delete record.stableSamples;
    },
  ],
  [
    "wrong-type",
    (record) => {
      record.activity = "0";
    },
  ],
  [
    "contradictory-count",
    (record) => {
      record.activity = 1;
    },
  ],
  [
    "extra-key",
    (record) => {
      record.clean = true;
    },
  ],
];
for (const [label, mutate] of schemaMutations) {
  const attack = runCase(`schema-${label}`, (paths) => {
    const records = fs
      .readFileSync(paths.journalPath, "utf8")
      .trimEnd()
      .split("\n")
      .map(JSON.parse);
    mutate(records[1]);
    fs.writeFileSync(paths.journalPath, `${records.map(JSON.stringify).join("\n")}\n`);
  });
  assert.throws(attack.invoke, /telemetry|SEALING|transition|record/);
  assert.equal(attack.publicationCount(), 0);
  emit(`schema-${label}: EXPECTED-RED publish-count=0\n`);
  cases += 1;
}

for (const [label, dependencies, pattern] of [
  [
    "close-failure",
    { close: () => ({ status: 1, stdout: "", stderr: "close failed" }) },
    /close failed/,
  ],
  [
    "video-failure",
    {
      validateVideo: () => {
        throw new Error("wrong codec");
      },
    },
    /wrong codec/,
  ],
  [
    "upload-failure",
    { publish: () => ({ status: 1, stdout: "", stderr: "tenant denied" }) },
    /upload failed/i,
  ],
]) {
  const attack = runCase(label, undefined, dependencies);
  assert.throws(attack.invoke, pattern);
  assert.equal(fs.existsSync(attack.paths.receiptPath), false);
  emit(`${label}: EXPECTED-RED success-receipt=0\n`);
  cases += 1;
}

for (const [label, listRecordings, pattern, attackRecordingId] of [
  ["wrong-recording-id", () => [], /recording ID is not uniquely present/],
  [
    "wrong-recording-session",
    () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        recordingStatus: "finished",
        metadata: {
          uri: cleanWalkthrough.authorizationUrl.replace(
            "sensitivity-nonce",
            "unrelated-browser-nonce",
          ),
        },
        path: "/fixture/.replay/recording-00000000-0000-4000-8000-000000000001.dat",
      },
    ],
    /does not match browser authorization nonce|process metadata conflicts with the local Replay catalog/,
  ],
  [
    "already-uploaded-recording",
    () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        recordingStatus: "finished",
        uploadStatus: "uploaded",
        metadata: { uri: cleanWalkthrough.authorizationUrl },
        path: path.join(
          scratch,
          "already-uploaded-recording",
          "replay-process",
          "recording-00000000-0000-4000-8000-000000000001.dat",
        ),
      },
    ],
    /not bound to the closed browser session/,
  ],
  [
    "copied-authorization-unowned-recording",
    () => [
      {
        id: "deadbeef-dead-4bad-8bad-deadbeefdead",
        recordingStatus: "finished",
        metadata: { uri: cleanWalkthrough.authorizationUrl },
        path: path.join(
          scratch,
          "copied-authorization-unowned-recording",
          "replay-process",
          "recording-deadbeef-dead-4bad-8bad-deadbeefdead.dat",
        ),
      },
    ],
    /run-private browser process log/,
    "deadbeef-dead-4bad-8bad-deadbeefdead",
  ],
]) {
  const attack = runCase(label, undefined, {
    listRecordings,
    ...(attackRecordingId === undefined ? {} : { recordingId: attackRecordingId }),
  });
  assert.throws(attack.invoke, pattern);
  assert.equal(attack.publicationCount(), 0);
  assert.equal(fs.existsSync(attack.paths.receiptPath), false);
  emit(`${label}: EXPECTED-RED publish-count=0 success-receipt=0\n`);
  cases += 1;
}

for (const [label, mutate, pattern] of [
  [
    "symlinked-process-log",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const externalLog = path.join(paths.directory, "external-recordings.log");
      fs.renameSync(logPath, externalLog);
      fs.symlinkSync(externalLog, logPath);
    },
    /process log is not a real file/,
  ],
  [
    "reordered-process-log",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const finish = records.splice(
        records.findIndex((record) => record.kind === "writeFinished"),
        1,
      )[0];
      records.unshift(finish);
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /recording file is not owned by the run-private browser process|associated process record falls outside its recording interval/,
  ],
  [
    "unexpected-same-recording-event",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
      records.splice(
        1,
        0,
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          kind: "unexpectedLifecycleEvent",
          timestamp: 1,
        }),
      );
      fs.writeFileSync(logPath, `${records.join("\n")}\n`);
    },
    /unexpected same-recording process event/,
  ],
  [
    "extra-process-record-fields",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs
        .readFileSync(logPath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => ({ ...JSON.parse(line), injected: true }));
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /process record has an invalid schema/,
  ],
  [
    "unexpected-recording-id-event",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
      records.splice(
        3,
        0,
        JSON.stringify({
          id: "other-artifact",
          kind: "unexpectedAssociatedEvent",
          recordingId: "00000000-0000-4000-8000-000000000001",
          timestamp: 2,
        }),
      );
      fs.writeFileSync(logPath, `${records.join("\n")}\n`);
    },
    /unexpected same-recording process event/,
  ],
  [
    "corrupted-sourcemap-record",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.find((record) => record.kind === "sourcemapAdded").injected = true;
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /sourcemapAdded process record has an invalid schema/,
  ],
  [
    "string-sourcemap-timestamp",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.find((record) => record.kind === "sourcemapAdded").timestamp = "2";
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /invalid timestamp/,
  ],
  [
    "sourcemap-after-write-finished",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const sourceMapIndex = records.findIndex((record) => record.kind === "sourcemapAdded");
      records[sourceMapIndex].timestamp = 4;
      records.push(records.splice(sourceMapIndex, 1)[0]);
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /outside its recording interval/,
  ],
  [
    "cross-linked-sourcemap",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const sourceMap = records.find((record) => record.kind === "sourcemapAdded");
      sourceMap.id = "00000000-0000-4000-8000-000000000001";
      sourceMap.recordingId = "deadbeef-dead-4bad-8bad-deadbeefdead";
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /sourcemapAdded process record has an invalid schema/,
  ],
  [
    "conflicting-uri-metadata",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.splice(1, 0, {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "addMetadata",
        metadata: {
          uri: cleanWalkthrough.authorizationUrl.replace("sensitivity-state", "conflicting-state"),
        },
        timestamp: 1,
      });
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /process metadata conflicts with the local Replay catalog|does not prove one browser identity/,
  ],
  [
    "duplicate-conflicting-sourcemap-artifact",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const sourceMapIndex = records.findIndex((record) => record.kind === "sourcemapAdded");
      const otherPath = path.join(paths.recordingDirectory, "other-fixture.map");
      fs.writeFileSync(otherPath, "other-source-map");
      records.splice(sourceMapIndex + 1, 0, {
        ...records[sourceMapIndex],
        path: otherPath,
        url: "http://127.0.0.1:49152/other.js.map",
      });
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /source-map artifact ID is not unique/,
  ],
  [
    "missing-sourcemap-artifact",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const sourceMap = records.find((record) => record.kind === "sourcemapAdded");
      sourceMap.path = path.join(paths.recordingDirectory, "missing.map");
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /source-map artifact is not a real run-private file/,
  ],
  [
    "symlinked-sourcemap-artifact",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const sourceMap = records.find((record) => record.kind === "sourcemapAdded");
      const externalPath = path.join(paths.directory, "external.map");
      fs.writeFileSync(externalPath, "external-source-map");
      fs.unlinkSync(sourceMap.path);
      fs.symlinkSync(externalPath, sourceMap.path);
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /source-map artifact is not a real run-private file/,
  ],
  [
    "duplicate-sourcemap-path",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const sourceMapIndex = records.findIndex((record) => record.kind === "sourcemapAdded");
      records.splice(sourceMapIndex + 1, 0, {
        ...records[sourceMapIndex],
        id: "e".repeat(64),
      });
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /source-map artifact path is not unique|source-map artifact is not a real run-private file/,
  ],
  [
    "invalid-uri-metadata",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.splice(1, 0, {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "addMetadata",
        metadata: { uri: "not a URL" },
        timestamp: 1,
      });
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /process metadata has an invalid browser URI|does not prove one browser identity/,
  ],
  [
    "missing-uri-identity-metadata",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.splice(
        records.findIndex(
          (record) => record.kind === "addMetadata" && record.metadata.uri !== undefined,
        ),
        1,
      );
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /does not prove one browser identity/,
  ],
  [
    "duplicate-uri-identity-metadata",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const identity = records.find(
        (record) => record.kind === "addMetadata" && record.metadata.uri !== undefined,
      );
      records.splice(2, 0, { ...identity, metadata: { ...identity.metadata } });
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /does not prove one browser identity/,
  ],
  [
    "missing-process-identity-metadata",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.splice(
        records.findIndex(
          (record) => record.kind === "addMetadata" && record.metadata.process !== undefined,
        ),
        1,
      );
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /does not prove one browser identity/,
  ],
  [
    "target-content-hash-mismatch",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.find((record) => record.kind === "sourcemapAdded").targetContentHash =
        `sha256:${"0".repeat(64)}`;
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /descriptor is not cryptographically self-consistent/,
  ],
  [
    "artifact-id-descriptor-mismatch",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.find((record) => record.kind === "sourcemapAdded").id = "e".repeat(64);
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /source-map artifact is not a real run-private file/,
  ],
  [
    "encoded-source-map-url-alias",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.find((record) => record.kind === "sourcemapAdded").url =
        "http://127.0.0.1:49152/%69ndex.js.map";
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /descriptor is not cryptographically self-consistent/,
  ],
  [
    "hardlinked-sourcemap-path-alias",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      const sourceMap = records.find((record) => record.kind === "sourcemapAdded");
      const aliasId = "e".repeat(64);
      const aliasPath = path.join(paths.recordingDirectory, `sourcemap-${aliasId}.map`);
      fs.linkSync(sourceMap.path, aliasPath);
      records.splice(
        records.findIndex((record) => record.kind === "writeFinished"),
        0,
        {
          ...sourceMap,
          id: aliasId,
          path: aliasPath,
          targetContentHash: `sha256:${aliasId}`,
        },
      );
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /source-map artifact is not a real run-private file|filesystem object is not unique/,
  ],
  [
    "arbitrary-process-identity",
    (paths) => {
      const logPath = path.join(paths.recordingDirectory, "recordings.log");
      const records = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map(JSON.parse);
      records.find(
        (record) => record.kind === "addMetadata" && record.metadata.process !== undefined,
      ).metadata.process = "unrelated-copyable-label";
      fs.writeFileSync(logPath, `${records.map(JSON.stringify).join("\n")}\n`);
    },
    /addMetadata process record has an invalid schema/,
  ],
]) {
  const attack = runCase(label, mutate);
  assert.throws(attack.invoke, pattern);
  assert.equal(attack.publicationCount(), 0);
  assert.equal(fs.existsSync(attack.paths.receiptPath), false);
  emit(`${label}: EXPECTED-RED publish-count=0 success-receipt=0\n`);
  cases += 1;
}

for (const [label, artifactName] of [
  ["source-map-mutated-after-decision", `sourcemap-${"a".repeat(64)}.map`],
  ["recording-mutated-after-decision", "recording-00000000-0000-4000-8000-000000000001.dat"],
]) {
  let originalArtifactPath;
  const attack = runCase(
    label,
    (paths) => {
      originalArtifactPath = path.join(paths.recordingDirectory, artifactName);
    },
    {
      publish: () => {
        fs.writeFileSync(originalArtifactPath, "replacement-after-decision");
        return { status: 0, stdout: "uploaded", stderr: "" };
      },
    },
  );
  assert.throws(attack.invoke, /ENOENT/);
  assert.equal(attack.publicationCount(), 0);
  assert.equal(fs.existsSync(attack.paths.receiptPath), false);
  emit(`${label}: EXPECTED-RED original-path-gone publish-count=0 success-receipt=0\n`);
  cases += 1;
}

for (const [label, attackPublication] of [
  [
    "sealed-recording-mutate-restore",
    ({ recordingDirectory }) => {
      const artifactPath = path.join(
        recordingDirectory,
        "recording-00000000-0000-4000-8000-000000000001.dat",
      );
      fs.chmodSync(artifactPath, 0o600);
    },
  ],
  [
    "sealed-sourcemap-mutate-restore",
    ({ recordingDirectory }) => {
      const artifactPath = path.join(recordingDirectory, `sourcemap-${"a".repeat(64)}.map`);
      fs.chmodSync(artifactPath, 0o600);
    },
  ],
  [
    "sealed-log-rewrite-restore",
    ({ recordingDirectory }) => {
      fs.writeFileSync(path.join(recordingDirectory, "recordings.log"), "attacker log\n");
    },
  ],
  [
    "sealed-directory-path-swap",
    ({ recordingDirectory }) => {
      fs.renameSync(recordingDirectory, `${recordingDirectory}.attacker-swap`);
    },
  ],
]) {
  const attack = runCase(label, undefined, {
    publish: (sealed) => {
      attackPublication(sealed);
      return { status: 0, stdout: "uploaded", stderr: "" };
    },
  });
  assert.throws(attack.invoke, /EPERM/);
  assert.equal(attack.publicationCount(), 0);
  assert.equal(fs.existsSync(attack.paths.receiptPath), false);
  emit(`${label}: EXPECTED-RED immutable-boundary=EPERM publish-count=0 success-receipt=0\n`);
  cases += 1;
}

const retry = runCase("retry-after-success");
retry.invoke();
assert.throws(retry.invoke, /already exists/);
assert.equal(retry.publicationCount(), 1);
emit("retry-after-success: EXPECTED-RED second-publish=0 global-publish-count=1\n");
cases += 1;

const invalidVideo = path.join(scratch, "truncated.mp4");
fs.writeFileSync(invalidVideo, "not an mp4");
assert.throws(() => validateMp4(invalidVideo), /not H\.264/);
emit("mp4-truncated-wrong-codec: EXPECTED-RED\n");
cases += 1;

const cleanJournal = baseCase("journal-control").journalPath;
assert.equal(validateTerminalJournal(cleanJournal, session).failures.length, 0);
emit(
  `E3_T02_RECORDER_SENSITIVITY_OK cases=${String(cases)} timing=12 schema=8 crash=3 binding=33 retry=1 mp4=1 clean-publish=1\n`,
);
const evidenceDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-canopy/E3-T02b-browser-evidence-hardening/evidence",
);
fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.writeFileSync(path.join(evidenceDirectory, "e3-t02b-recorder-sensitivity.txt"), transcript);
