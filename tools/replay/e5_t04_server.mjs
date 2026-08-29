#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootWorld } from "../../packages/browser-verify/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const work = resolve(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T04-browser-dispatch-hook/work/replay",
);
const proofReceiptPath = resolve(work, "empty-proof-receipt.json");
const subject = {
  id: "e5-t04-replay",
  email: "e5-t04-replay@canopy.test",
  password: "E5T04Replay1234!",
  name: "E5 T04 Replay",
};

await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
});

let stop;
const stopped = new Promise((resolveStop) => {
  stop = resolveStop;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop());
}
process.stdout.write(
  `E5_T04_READY ${JSON.stringify({
    url: world.platformUrl,
    labelsUrl: `${world.platformUrl}/orgs/maple/repos/reading-room/labels`,
    subject: subject.email,
  })}\n`,
);

try {
  await stopped;
} finally {
  await world.close();
}
