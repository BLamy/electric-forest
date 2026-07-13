import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
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
    "usage: watch-worker baseUrl streamId mode from transcript report checkpoint killAt ready",
  );
}

let emissions = 0;
const watcher = watch(".", {
  baseUrl,
  streamId,
  mode,
  from,
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
