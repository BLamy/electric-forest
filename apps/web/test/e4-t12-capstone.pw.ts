import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { OfficialStreamAdapter } from "@eforest/platform";
import { type Event } from "@eforest/protocol";
import { replayWithReducer, requireReducer } from "@eforest/reducers";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-4-the-roots/E4-T12-two-machines-one-branch");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work/e4-t12-browser");
const mainStream = "fs:maple/reading-room:main:meta";
const branchLogPath = resolve(task, "evidence/e4-t12-branch-log.jsonl");
const contentLogPath = resolve(task, "evidence/e4-t12-content.jsonl");
const digestText = await readFile(resolve(task, "evidence/e4-t12-digests.txt"), "utf8");
const conflictText = await readFile(resolve(task, "evidence/e4-t12-conflict.txt"), "utf8");
const expectedTreeDigest = digestText.match(/^replay\(branch\) --tree-digest ([0-9a-f]+)$/m)?.[1];
assert.ok(expectedTreeDigest);
const expectedConflictName = conflictText.match(/mixed-conflict\.bin\.conflict-[0-9_]+/)?.[0];
assert.ok(expectedConflictName);
const subject = {
  id: "e4-t12-browser",
  email: "e4-t12-browser@canopy.test",
  password: "E4T12Browser1234!",
  name: "E4 T12 Browser",
};

async function openReadme(page: import("playwright-core").Page, url: string): Promise<void> {
  await page.goto(url);
  await loginWithFixture(page);
  await page.getByRole("link", { name: "Maple", exact: true }).click();
  await page.getByTestId("route-org").waitFor();
  await page.getByRole("link", { name: "Repositories", exact: true }).click();
  await page.getByTestId("registry-browser").waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="registry-browser"]')
        ?.getAttribute("data-stream-status") === "live",
  );
  await page.waitForFunction(async () => {
    const paths = [
      "/api/repos/maple/reading-room/home/namespace?projection=1&reducer=repo-namespace",
      "/api/repos/maple/reading-room/home/branches?projection=1&reducer=repo-branches",
      "/api/repos/maple/reading-room/home/status?projection=1&reducer=repo-status",
    ];
    const responses = await Promise.all(paths.map((path) => fetch(path)));
    return responses.every((response) => response.ok);
  });
  await page
    .locator('nav[aria-label="Canopy routes"]')
    .getByRole("link", { name: "Reading room", exact: true })
    .click();
  await page.getByTestId("repository-home").waitFor();
  await page
    .locator('nav[aria-label="Canopy routes"]')
    .getByRole("link", { name: "File tree", exact: true })
    .click();
  await page.getByTestId("tree-list").waitFor();
  await page.getByRole("link", { name: "docs/", exact: true }).click();
  await page.getByRole("link", { name: "readme.txt", exact: true }).click();
  await page.getByTestId("file-content").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-stream-status") ===
      "live",
  );
}

const branchRecords = (await readFile(branchLogPath, "utf8"))
  .trim()
  .split("\n")
  .map(
    (line) => JSON.parse(line) as { offset: string; type: string; payload: unknown; ts: number },
  );
const timelineText = await readFile(
  resolve(task, "evidence/e4-t12-partition-timeline.txt"),
  "utf8",
);
const partitionHead = timelineText.match(/partition edit offset=([^\n]+)/)?.[1];
assert.ok(partitionHead);
const partitionStart = branchRecords.findIndex((record) => record.offset === partitionHead) + 1;
assert.ok(partitionStart > 0);
const contentRecords = (await readFile(contentLogPath, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as StreamRecord);

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
const proofReceiptPath = resolve(work, "proof-receipt.json");
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: branchRecords.slice(0, partitionStart) as Event[],
});
const contentStreams = new Set(
  contentRecords.map((record) => (record.payload as { contentStreamId: string }).contentStreamId),
);
for (const streamId of [...contentStreams].sort()) {
  await streams.create(streamId);
  for (const record of contentRecords.filter(
    (candidate) => (candidate.payload as { contentStreamId: string }).contentStreamId === streamId,
  ))
    await streams.append(streamId, record as Event);
}
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
const navigations: string[] = [];
const errors: string[] = [];
guarded.page.on("request", (request) => {
  if (request.isNavigationRequest() && request.resourceType() === "document") {
    navigations.push(request.url());
  }
});
guarded.page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
guarded.page.on("response", (response) => {
  if (response.status() >= 400) errors.push(`${String(response.status())} ${response.url()}`);
});
guarded.page.on("pageerror", (error) => errors.push(error.message));
let transcript = "E4-T12 browser capstone\n";

try {
  await openReadme(guarded.page, world.platformUrl);
  navigations.length = 0;
  const viewer = guarded.page.getByTestId("file-viewer");
  const phase1Before = await viewer.getAttribute("data-application-checkpoint");
  assert.ok(phase1Before);
  for (const event of branchRecords.slice(partitionStart, partitionStart + 4))
    await world.appendApplication(mainStream, event as Event);
  await guarded.page.waitForFunction((before) => {
    const current = document
      .querySelector('[data-testid="file-viewer"]')
      ?.getAttribute("data-application-checkpoint");
    return current !== null && current !== before;
  }, phase1Before);
  await new Promise((done) => setTimeout(done, 500));
  const phase1After = await viewer.getAttribute("data-application-checkpoint");
  assert.ok(phase1After && phase1After > phase1Before);
  transcript += `phase=live before=${phase1Before} after=${phase1After}\n`;

  const partitionSamples: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    await new Promise((done) => setTimeout(done, 150));
    partitionSamples.push((await viewer.getAttribute("data-application-checkpoint")) ?? "");
  }
  assert.deepEqual(new Set(partitionSamples), new Set([phase1After]));
  transcript += `phase=partition samples=${partitionSamples.join(",")} unchanged=true\n`;

  for (const event of branchRecords.slice(partitionStart + 4))
    await world.appendApplication(mainStream, event as Event);
  await guarded.page
    .locator('nav[aria-label="Canopy routes"]')
    .getByRole("link", { name: "File tree", exact: true })
    .click();
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.getByRole("link", { name: "docs/", exact: true }).click();
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.getByText(expectedConflictName).waitFor();
  const tree = guarded.page.getByTestId("tree-browser");
  const finalOffset = await tree.getAttribute("data-application-checkpoint");
  const finalDigest = await tree.getAttribute("data-state-digest");
  const metadata = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(mainStream)}`,
  });
  const definition = requireReducer("streamfs", mainStream);
  const replay = replayWithReducer(definition, metadata);
  assert.equal(finalOffset, metadata.at(-1)?.offset);
  assert.equal(finalDigest, replay.digest);
  assert.equal(finalDigest, expectedTreeDigest);
  assert.ok(finalOffset && phase1After && finalOffset > phase1After);
  transcript += `phase=reunion final=${finalOffset} digest=${finalDigest} conflict-visible=true\n`;
  assert.deepEqual(errors, []);
  assert.equal(navigations.length, 0);
  transcript += `console-errors=0 document-navigations=${String(navigations.length)}\n`;
  await writeFile(resolve(work, "transcript.txt"), transcript);
  await writeFile(resolve(evidence, "e4-t12-browser.txt"), transcript);
  console.log(transcript.trim());
} finally {
  await guarded.close();
  await browser.close();
  await world.close();
}
process.exit(0);
