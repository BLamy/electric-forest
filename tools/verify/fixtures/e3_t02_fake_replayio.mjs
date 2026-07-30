#!/usr/bin/env node
import {
  appendFileSync,
  chmodSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const [, , command, recordingId] = process.argv;
const recordingDirectory = process.env.RECORD_REPLAY_DIRECTORY;
if (command !== "upload" || !recordingId || !recordingDirectory) process.exit(64);

const fixture = JSON.parse(
  readFileSync(resolve(recordingDirectory, ".e3-t02-upload-fixture.json"), "utf8"),
);
const logPath = resolve(recordingDirectory, "recordings.log");

if (fixture.mode.startsWith("direct-")) {
  if (fixture.mode === "direct-recording-chmod") {
    chmodSync(resolve(recordingDirectory, `recording-${recordingId}.dat`), 0o600);
  } else if (fixture.mode === "direct-sourcemap-chmod") {
    const sourceMap = readdirSync(recordingDirectory).find(
      (name) => name.startsWith("sourcemap-") && name.endsWith(".map"),
    );
    chmodSync(resolve(recordingDirectory, sourceMap), 0o600);
  } else if (fixture.mode === "direct-log-rewrite") {
    writeFileSync(logPath, "attacker log\n");
  } else if (fixture.mode === "direct-directory-rename") {
    renameSync(
      recordingDirectory,
      resolve(dirname(recordingDirectory), `${basename(recordingDirectory)}.attacker-swap`),
    );
  }
  process.stderr.write("direct publication attack unexpectedly succeeded\n");
  process.exit(65);
}

if (fixture.mode === "failure") {
  process.stderr.write("tenant denied\n");
  process.exit(1);
}

const now = Date.now();
if (fixture.mode === "forged-suffix") {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      id: recordingId,
      kind: "writeStarted",
      path: resolve(recordingDirectory, "..", "attacker-recording.dat"),
      timestamp: now,
    })}\n`,
  );
}
let events = [
  ["uploadStarted", now + 1],
  ["uploadFinished", now + 2],
].map(([kind, timestamp]) => ({
  kind,
  server: "wss://dispatch.replay.io",
  id: recordingId,
  recordingId,
  timestamp,
}));
if (fixture.mode === "wrong-id-suffix") {
  events[1].recordingId = "deadbeef-dead-4bad-8bad-deadbeefdead";
} else if (fixture.mode === "extra-key-suffix") {
  events[0].path = resolve(recordingDirectory, "..", "attacker-recording.dat");
} else if (fixture.mode === "reversed-suffix") {
  events = events.reverse();
} else if (fixture.mode === "wrong-server-suffix") {
  events[0].server = "wss://attacker.example";
  events[1].server = "wss://attacker.example";
}
for (const event of events) appendFileSync(logPath, `\n${JSON.stringify(event)}\n`);
process.stdout.write("fixture uploaded\n");
