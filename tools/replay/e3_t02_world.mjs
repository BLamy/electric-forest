#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { promisify } from "node:util";
import { bootWorld } from "../../packages/browser-verify/dist/src/index.js";
import { pkceChallenge } from "../../packages/platform/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const run = promisify(execFile);
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
let cachedCount = -1;
let cachedCliDigest = "";

async function publish() {
  const snapshot = await world.snapshotIdentity();
  const records = await world.dumpIdentity();
  const dumpPath = resolve(dirname(statePath), "e3-t02-replay-identity.jsonl");
  await writeFile(dumpPath, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
  if (records.length !== cachedCount) {
    cachedCliDigest =
      records.length === 0
        ? snapshot.digest
        : (
            await run(
              process.execPath,
              [
                resolve(root, "packages/cli/dist/src/bin.js"),
                "replay",
                dumpPath,
                "--digest",
                "--reducer",
                resolve(root, "packages/identity/reducer.mjs"),
              ],
              { cwd: root },
            )
          ).stdout.trim();
    cachedCount = records.length;
  }
  const cliDigest = cachedCliDigest;
  const tokenRequest = world.serverNetwork.find(
    (entry) =>
      entry.direction === "request" &&
      entry.method === "POST" &&
      new URL(entry.url).pathname.endsWith("/oauth/token"),
  );
  const tokenForm =
    tokenRequest?.bodyBase64 === null || tokenRequest?.bodyBase64 === undefined
      ? undefined
      : new globalThis.URLSearchParams(
          Buffer.from(tokenRequest.bodyBase64, "base64").toString("utf8"),
        );
  const verifier = tokenForm?.get("code_verifier") ?? undefined;
  const code = tokenForm?.get("code") ?? undefined;
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
        cliDigest,
        cliDigestMatches: cliDigest === snapshot.digest,
        pkce:
          verifier === undefined || code === undefined
            ? null
            : {
                method: "S256",
                challenge: pkceChallenge(verifier),
                verifierSha256: createHash("sha256").update(verifier).digest("hex"),
                codeSha256: createHash("sha256").update(code).digest("hex"),
                redeemed: true,
                verifierExposed: false,
              },
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
const publisher = setInterval(() => void publish(), 500);
process.stdout.write(`${world.platformUrl}\n${statePath}\n`);
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await new Promise(() => undefined);
