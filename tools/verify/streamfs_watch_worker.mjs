import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson, compareOffsets } from "../../packages/protocol/dist/src/index.js";
import { watch } from "../../packages/streamfs/dist/src/index.js";

const [
  baseUrl,
  streamId,
  mode,
  from,
  transcriptPath,
  reportPath,
  checkpointPath,
  killAt = "0",
  readyPath,
  crashAfterTranscript = "0",
] = process.argv.slice(2);
if (
  !baseUrl ||
  !streamId ||
  !mode ||
  !from ||
  !transcriptPath ||
  !reportPath ||
  !checkpointPath ||
  !readyPath
) {
  throw new Error(
    "usage: watch-worker baseUrl streamId mode from transcript report checkpoint killAt ready crashAfterTranscript",
  );
}

function persistedTranscriptOffset(path, requested) {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text.length === 0) return requested;
    const last = JSON.parse(text.split("\n").at(-1)).offset;
    return compareOffsets(last, requested) > 0 ? last : requested;
  } catch {
    return requested;
  }
}

let emissions = 0;
let transcriptBatches = 0;
const effectiveFrom = persistedTranscriptOffset(transcriptPath, from);
const watcher = watch(".", {
  baseUrl,
  streamId,
  mode,
  from: effectiveFrom,
});

watcher.on("error", (error) => {
  writeFileSync(`${readyPath}.error`, String(error));
  process.exitCode = 1;
});

watcher.onAll((event, path, offset) => {
  emissions += 1;
  appendFileSync(reportPath, `${canonicalJson({ emissions, record: { event, path, offset } })}\n`);
  if (Number(killAt) === emissions) process.kill(process.pid, "SIGKILL");
});

watcher.onBatch((records, checkpoint) => {
  if (records.length > 0) {
    appendFileSync(
      transcriptPath,
      `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
    );
  }
  transcriptBatches += 1;
  if (Number(crashAfterTranscript) === transcriptBatches) process.kill(process.pid, "SIGKILL");
  const temporaryPath = `${checkpointPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${canonicalJson(checkpoint)}\n`);
  renameSync(temporaryPath, checkpointPath);
});

writeFileSync(readyPath, `${canonicalJson({ pid: process.pid, mode })}\n`);
await watcher.ready;

const shutdown = async () => {
  await watcher.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
await new Promise(() => undefined);
