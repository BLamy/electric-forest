#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { bootWorld } from "../../packages/browser-verify/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const statePath = resolve(
  root,
  ".eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/work/e3-t02-replay-world.json",
);
const subject = {
  id: "ada-replay",
  email: "ada.replay@canopy.test",
  password: "AdaReplay1234!",
  name: "Ada Replay",
};

await mkdir(dirname(statePath), { recursive: true });
const world = await bootWorld({ root, subject });
let closing = false;

async function publish() {
  const snapshot = await world.snapshotIdentity();
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        platformUrl: world.platformUrl,
        streamUrl: world.streamUrl,
        emulatorUrl: world.emulatorUrl,
        identityStream: world.identity.streamId,
        subject,
        offset: snapshot.offset,
        digest: snapshot.digest,
        eventCount: snapshot.events.length,
      },
      null,
      2,
    )}\n`,
  );
}

async function close() {
  if (closing) return;
  closing = true;
  clearInterval(publisher);
  await publish();
  await world.close();
  process.exit(0);
}

await publish();
const publisher = setInterval(() => void publish(), 100);
process.stdout.write(`${world.platformUrl}\n${statePath}\n`);
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await new Promise(() => undefined);
