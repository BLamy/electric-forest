import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T03-use-stream-reducer-hooks");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const transcriptPath = resolve(evidence, "e3-t03-browser.txt");
const dumpPath = resolve(evidence, "e3-t03-application.jsonl");
const digestPath = resolve(evidence, "e3-t03-digest.txt");
const subject = {
  id: "ada-stream-reducer",
  email: "ada.reducer@canopy.test",
  password: "AdaReducer1234!",
  name: "Ada Reducer",
};
const reducer = { id: "streamfs", version: 2 };

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
const proofReceiptPath = resolve(work, "e3-t03-empty-e3-t02-receipt.json");
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const streamId = await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: [{ type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 10 }],
});
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
let transcript = "E3-T03 browser application projection\n";

async function independentDigest(): Promise<string> {
  const records = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
  await writeFile(dumpPath, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
  const result = await run(
    process.execPath,
    [resolve(root, "packages/cli/dist/src/bin.js"), "replay", dumpPath, "--digest"],
    { cwd: root },
  );
  return result.stdout.trim();
}

try {
  await guarded.page.goto(world.platformUrl);
  await loginWithFixture(guarded.page);
  const requestBoundary = guarded.network.length;
  let forcedReconnect = false;
  let releaseGapProjection!: () => void;
  const gapProjectionReady = new Promise<void>((resolveReady) => {
    releaseGapProjection = resolveReady;
  });
  await guarded.page.route("**/api/repos/maple/reading-room/main/events?*", async (route) => {
    const url = new URL(route.request().url());
    if (!forcedReconnect && url.searchParams.get("live") === "1") {
      forcedReconnect = true;
      await route.fulfill({ status: 204 });
      return;
    }
    if (
      url.searchParams.get("live") === "1" &&
      url.searchParams.get("checkpoint") === offsetForOrdinal(1)
    ) {
      await gapProjectionReady;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          events: [
            {
              type: "fs.dir.create",
              payload: { v: 2, path: "gap-after-missing-event" },
              ts: 12,
              offset: offsetForOrdinal(3),
            },
          ],
          checkpoint: offsetForOrdinal(3),
          reducer,
        }),
      });
      return;
    }
    await route.fallback();
  });
  await guarded.page.getByRole("link", { name: "Stream inspector" }).click();
  const inspector = guarded.page.getByTestId("stream-inspector");
  await inspector.waitFor();
  await guarded.page.getByTestId("inspector-checkpoint").waitFor({ state: "visible" });
  await guarded.page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="stream-inspector"]')
        ?.getAttribute("data-stream-status") === "live",
  );

  const firstCheckpoint = await inspector.getAttribute("data-application-checkpoint");
  const firstDigest = await inspector.getAttribute("data-state-digest");
  assert.equal(firstCheckpoint, "0000000000000000_0000000000000000");
  assert.equal(firstDigest, await independentDigest());
  transcript += `bootstrap checkpoint=${firstCheckpoint} digest=${firstDigest} cli=equal\n`;
  await guarded.page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="stream-inspector"]')
        ?.getAttribute("data-stream-status") === "reconnecting",
  );
  assert.equal(forcedReconnect, true);
  transcript += `forced-reconnect checkpoint=${firstCheckpoint} bootstrap-requests=1\n`;

  const boundaryOffset = await world.appendApplication(streamId, {
    type: "fs.dir.create",
    payload: { v: 2, path: "src" },
    ts: 11,
  });
  await guarded.page.waitForFunction(
    (offset) =>
      document
        .querySelector('[data-testid="stream-inspector"]')
        ?.getAttribute("data-application-checkpoint") === offset,
    boundaryOffset,
  );
  const convergedDigest = await inspector.getAttribute("data-state-digest");
  assert.equal(convergedDigest, await independentDigest());
  assert.match((await guarded.page.getByTestId("inspector-state").textContent()) ?? "", /"src"/);
  transcript += `follow checkpoint=${boundaryOffset} digest=${convergedDigest} cli=equal\n`;

  const missingOffset = offsetForOrdinal(2);
  const gapOffset = offsetForOrdinal(3);
  releaseGapProjection();
  try {
    await guarded.page.waitForFunction(
      (offset) =>
        document
          .querySelector('[data-testid="stream-inspector"]')
          ?.getAttribute("data-stream-status")
          ?.includes(offset) === true,
      missingOffset,
      { timeout: 10_000 },
    );
  } catch (error) {
    await guarded.settleNetwork();
    const observedStatus = await inspector.getAttribute("data-stream-status");
    const projectionResponses = guarded.network
      .filter(
        (entry) =>
          entry.direction === "response" &&
          new URL(entry.url).pathname.includes("/api/repos/maple/reading-room/main/events"),
      )
      .map((entry) => `${String(entry.status)} ${entry.url}`);
    throw new Error(
      `gap status not exposed: status=${String(observedStatus)} responses=${projectionResponses.join(" | ")}`,
      { cause: error },
    );
  }
  const errorStatus = await inspector.getAttribute("data-stream-status");
  assert.match(errorStatus ?? "", new RegExp(missingOffset));
  assert.match(errorStatus ?? "", new RegExp(gapOffset));

  await world.appendApplicationAt(
    streamId,
    {
      type: "fs.dir.create",
      payload: { v: 2, path: "gap-after-missing-event" },
      ts: 12,
    },
    gapOffset,
  );
  const rawAfterGap = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
  assert.deepEqual(
    rawAfterGap.map(({ offset }) => offset),
    [offsetForOrdinal(0), offsetForOrdinal(1), gapOffset],
  );
  const gapProbe = await fetch(
    `${world.platformUrl}/api/repos/maple/reading-room/main/events?projection=1&reducer=streamfs&live=1&checkpoint=${encodeURIComponent(boundaryOffset)}&waitMs=1000`,
  );
  assert.equal(gapProbe.status, 422);
  assert.match(await gapProbe.text(), new RegExp(missingOffset));
  transcript += `gap observed=${gapOffset} missing=${missingOffset} status=${errorStatus}\n`;

  await guarded.settleNetwork();
  const failedResponses = guarded.network
    .filter(
      (entry) =>
        entry.direction === "response" && entry.status !== undefined && entry.status >= 400,
    )
    .map((entry) => `${String(entry.status)} ${entry.url}`);
  assert.deepEqual(failedResponses, []);
  guarded.assertClean();
  const applicationRequests = guarded.network
    .slice(requestBoundary)
    .filter(
      (entry) =>
        entry.direction === "request" &&
        new URL(entry.url).pathname.includes("/api/repos/maple/reading-room/main/events"),
    );
  assert.ok(applicationRequests.length >= 2);
  assert.ok(applicationRequests.every((entry) => new URL(entry.url).origin === world.platformUrl));
  assert.equal(
    guarded.network
      .slice(requestBoundary)
      .some(
        (entry) =>
          entry.direction === "request" &&
          (new URL(entry.url).origin === world.streamUrl ||
            new URL(entry.url).pathname.startsWith("/streams/")),
      ),
    false,
  );
  assert.equal(
    applicationRequests.some((entry) =>
      entry.headers.some(
        ([name]) => name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key",
      ),
    ),
    false,
  );
  transcript +=
    "browser-network application-requests>=2 platform-only=true direct-credentials=false platform-gap=422\n";
  transcript += "console-errors=0 page-errors=0 request-failures=0\n";
  await writeFile(transcriptPath, transcript);
  await writeFile(
    digestPath,
    `bootstrap=${firstDigest}\nconverged=${convergedDigest}\nmissingOffset=${missingOffset}\ngapOffset=${gapOffset}\n`,
  );
  process.stdout.write(transcript);
} finally {
  await guarded.close();
  await browser.close();
  await world.close();
}
