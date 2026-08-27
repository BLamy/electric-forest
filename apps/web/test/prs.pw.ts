import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bootWorld,
  loginWithFixture,
  replayChromiumPath,
  type GuardedPage,
  type WireObservation,
} from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { OfficialStreamAdapter, RepositoryHomeStore } from "@eforest/platform";
import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { digestBytes } from "@eforest/streamfs";
import { chromium, type Locator, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T09-pr-ui-live");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const proofReceiptPath = resolve(work, "e5-t09-empty-proof-receipt.json");
const subject = {
  id: "e5-t09-browser",
  email: "e5-t09-browser@canopy.test",
  password: "E5T09Browser1234!",
  name: "E5 T09 Browser",
};
const org = "maple";
const repo = "reading-room";
const listPath = `/orgs/${org}/repos/${repo}/pulls`;
const mainStream = `fs:${org}/${repo}:main:meta`;
const featureStream = `fs:${org}/${repo}:feature-review:meta`;
const mainContent = `fs:${org}/${repo}:main:file:readme`;
const featureContent = `fs:${org}/${repo}:feature-review:file:feature`;
const mainBytes = new TextEncoder().encode("# Reading room\n");
const featureBytes = new TextEncoder().encode("export const meadow = true;\n");
const LIVE_BOUND_MS = 2_000;

function decodedBody(observation: WireObservation): string {
  return observation.bodyBase64 === null
    ? ""
    : Buffer.from(observation.bodyBase64, "base64").toString("utf8");
}

function dispatchRequests(observations: readonly WireObservation[]): readonly WireObservation[] {
  return observations.filter(
    (entry) =>
      entry.layer === "browser" &&
      entry.direction === "request" &&
      entry.method === "POST" &&
      new URL(entry.url).pathname === "/api/dispatch",
  );
}

async function withinLiveBound(label: string, observe: () => Promise<void>): Promise<number> {
  const started = Date.now();
  await observe();
  const latency = Date.now() - started;
  assert.ok(
    latency <= LIVE_BOUND_MS,
    `${label} exceeded ${String(LIVE_BOUND_MS)} ms: ${String(latency)}`,
  );
  return latency;
}

async function waitForLive(page: Page, testId: "pr-list" | "pr-detail"): Promise<Locator> {
  const region = page.getByTestId(testId);
  await region.waitFor();
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-stream-status") ===
      "live",
    testId,
  );
  return region;
}

async function loginAt(guarded: GuardedPage, platformUrl: string, path: string): Promise<void> {
  await guarded.page.goto(platformUrl);
  await loginWithFixture(guarded.page);
  await guarded.page.goto(`${platformUrl}${path}`);
}

async function createPr(page: Page, title: string, body: string): Promise<string> {
  const form = page.getByRole("form", { name: "Create pull request" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Description").fill(body);
  await form.getByLabel("Source branch").selectOption(featureStream);
  const navigated = page.waitForURL((url) => /\/pulls\/[^/]+$/.test(url.pathname));
  await form.getByRole("button", { name: "Create pull request" }).click();
  await navigated;
  const prId = page.url().split("/").at(-1);
  assert.ok(prId);
  return decodeURIComponent(prId);
}

async function streamRecords(world: { readonly streamUrl: string }, streamId: string) {
  return readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
}

function attributes(values: readonly (string | null)[]): asserts values is readonly string[] {
  assert.equal(
    values.every((value) => value !== null && value !== ""),
    true,
  );
}

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
await world.seedPublicRepo({
  org,
  project: "canopy",
  repo,
  branch: "main",
  events: [
    { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 },
    {
      type: "fs.file.create",
      payload: { v: 2, path: "README.md", contentStreamId: mainContent },
      ts: 2,
    },
    {
      type: "fs.file.write",
      payload: {
        v: 2,
        path: "README.md",
        base: "BASE_NONE",
        contentSha256: digestBytes(mainBytes),
        size: mainBytes.byteLength,
      },
      ts: 3,
    },
  ],
});
await streams.create(mainContent);
await streams.append(mainContent, {
  type: "fs.file.content",
  payload: {
    v: 2,
    contentStreamId: mainContent,
    contentBase64: Buffer.from(mainBytes).toString("base64"),
  },
  ts: 3,
});
const mainRecords = await streamRecords(world, mainStream);
const forkOffset = mainRecords.at(-1)?.offset;
assert.ok(forkOffset);
await streams.create(featureStream);
await streams.append(
  featureStream,
  {
    type: "fs.branch.fork",
    payload: { v: 1, parentStreamId: mainStream, forkOffset },
    ts: 4,
  },
  { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
);
await streams.create(featureContent);
await streams.append(featureContent, {
  type: "fs.file.content",
  payload: {
    v: 2,
    contentStreamId: featureContent,
    contentBase64: Buffer.from(featureBytes).toString("base64"),
  },
  ts: 5,
});
await streams.append(
  featureStream,
  {
    type: "fs.file.create",
    payload: { v: 2, path: "docs/feature.ts", contentStreamId: featureContent },
    ts: 5,
  },
  { sequence: offsetForOrdinal(1), applicationOffset: offsetForOrdinal(1) },
);
await streams.append(
  featureStream,
  {
    type: "fs.file.write",
    payload: {
      v: 2,
      path: "docs/feature.ts",
      base: "BASE_NONE",
      contentSha256: digestBytes(featureBytes),
      size: featureBytes.byteLength,
    },
    ts: 6,
  },
  { sequence: offsetForOrdinal(2), applicationOffset: offsetForOrdinal(2) },
);
let repositoryEventTime = 100;
const homes = new RepositoryHomeStore(streams, () => repositoryEventTime++);
await homes.ensureRepository(org, repo, "canopy");
await homes.registerNativeBranch(org, repo, "feature-review");

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const writer = await world.openPage(browser);
const follower = await world.openPage(browser);
const mobile = await world.openPage(browser);
await Promise.all([
  writer.page.setViewportSize({ width: 1440, height: 900 }),
  follower.page.setViewportSize({ width: 1440, height: 900 }),
  mobile.page.setViewportSize({ width: 390, height: 844 }),
]);
for (const guarded of [writer, follower]) {
  await guarded.page.addInitScript(() => {
    let now = 1_700_009_000_000;
    Date.now = () => ++now;
  });
}

const latencies: Array<{ readonly step: string; readonly ms: number }> = [];
const transcript: string[] = [
  "E5-T09 focused two-session browser oracle",
  `live-bound-ms=${String(LIVE_BOUND_MS)}`,
];

try {
  await Promise.all([
    loginAt(writer, world.platformUrl, listPath),
    loginAt(follower, world.platformUrl, listPath),
  ]);
  await Promise.all([waitForLive(writer.page, "pr-list"), waitForLive(follower.page, "pr-list")]);
  const writerNetworkStart = writer.network.length;
  const followerNetworkStart = follower.network.length;

  const firstTitle = "Review the live meadow";
  const firstPrId = await createPr(writer.page, firstTitle, "Exercise the complete review UI.");
  const firstPrStream = `pr:${org}/${repo}/${firstPrId}`;
  latencies.push({
    step: "pr-created",
    ms: await withinLiveBound("pr-created", async () => {
      await follower.page.locator(`[data-testid="pr-row"][data-pr-id="${firstPrId}"]`).waitFor();
    }),
  });
  await follower.page.locator(`[data-testid="pr-row"][data-pr-id="${firstPrId}"] a`).click();
  const [writerDetail, followerDetail] = await Promise.all([
    waitForLive(writer.page, "pr-detail"),
    waitForLive(follower.page, "pr-detail"),
  ]);
  assert.equal(await writerDetail.getAttribute("data-ef-stream"), firstPrStream);
  assert.equal(await writerDetail.getAttribute("data-ef-reducer"), "pr");

  await writer.page.getByLabel("Pull request comment").fill("Root review comment");
  await writer.page.getByRole("button", { name: "Comment", exact: true }).click();
  latencies.push({
    step: "root-comment",
    ms: await withinLiveBound("root-comment", async () => {
      await follower.page.getByText("Root review comment", { exact: true }).waitFor();
    }),
  });
  const rootEvent = writer.page
    .getByTestId("pr-timeline-event")
    .filter({ hasText: "Root review comment" });
  await rootEvent.getByRole("button", { name: "Reply" }).click();
  const replyDialog = writer.page.getByRole("dialog");
  await replyDialog.getByLabel("Pull request comment").fill("Nested durable reply");
  await replyDialog.getByRole("button", { name: "Comment", exact: true }).click();
  latencies.push({
    step: "threaded-reply",
    ms: await withinLiveBound("threaded-reply", async () => {
      await follower.page.getByText("Nested durable reply", { exact: true }).waitFor();
      await follower.page.getByRole("list", { name: /^Replies to / }).waitFor();
    }),
  });

  await writer.page.getByRole("tab", { name: /Changes/ }).click();
  const diff = writer.page.getByTestId("pr-diff");
  await diff.waitFor();
  assert.equal(await diff.getAttribute("data-source-stream"), featureStream);
  await diff.getByTestId("pr-diff-comment-line").first().click();
  const lineDialog = writer.page.getByRole("dialog");
  await lineDialog.getByTestId("pr-comment-target").waitFor();
  const lineTarget = await lineDialog.getByTestId("pr-comment-target").textContent();
  assert.match(lineTarget ?? "", /docs\/feature\.ts:\d+/);
  await lineDialog.getByLabel("Pull request comment").fill("Selected line needs a note");
  await lineDialog.getByRole("button", { name: "Comment", exact: true }).click();
  await writer.page.getByRole("tab", { name: /Activity/ }).click();
  latencies.push({
    step: "selected-line-comment",
    ms: await withinLiveBound("selected-line-comment", async () => {
      await follower.page.getByText("Selected line needs a note", { exact: true }).waitFor();
    }),
  });

  await writer.page.getByRole("button", { name: "Approve", exact: true }).click();
  latencies.push({
    step: "approved",
    ms: await withinLiveBound("approved", async () => {
      await follower.page.getByText("Ready to merge", { exact: true }).waitFor();
    }),
  });
  await writer.page.getByRole("button", { name: "Merge", exact: true }).last().click();
  latencies.push({
    step: "merged",
    ms: await withinLiveBound("merged", async () => {
      await follower.page.getByText("Merged", { exact: true }).waitFor();
    }),
  });
  const desktopDetailValues = await Promise.all([
    followerDetail.getAttribute("data-ef-stream"),
    followerDetail.getAttribute("data-ef-offset"),
    followerDetail.getAttribute("data-ef-digest"),
    followerDetail.getAttribute("data-ef-reducer"),
    followerDetail.getAttribute("data-stream-status"),
  ]);
  attributes(desktopDetailValues);

  await Promise.all([
    writer.page.goto(`${world.platformUrl}${listPath}`),
    follower.page.goto(`${world.platformUrl}${listPath}`),
  ]);
  await Promise.all([waitForLive(writer.page, "pr-list"), waitForLive(follower.page, "pr-list")]);
  const secondTitle = "Close from the review surface";
  const secondPrId = await createPr(writer.page, secondTitle, "This pull request should close.");
  const secondPrStream = `pr:${org}/${repo}/${secondPrId}`;
  latencies.push({
    step: "second-pr-created",
    ms: await withinLiveBound("second-pr-created", async () => {
      await follower.page.locator(`[data-testid="pr-row"][data-pr-id="${secondPrId}"]`).waitFor();
    }),
  });
  await follower.page.locator(`[data-testid="pr-row"][data-pr-id="${secondPrId}"] a`).click();
  await Promise.all([
    waitForLive(writer.page, "pr-detail"),
    waitForLive(follower.page, "pr-detail"),
  ]);
  await writer.page.getByRole("button", { name: "Close pull request", exact: true }).click();
  latencies.push({
    step: "closed",
    ms: await withinLiveBound("closed", async () => {
      await follower.page.locator(".pr-state-closed").waitFor();
    }),
  });

  await loginAt(mobile, world.platformUrl, listPath);
  const mobileList = await waitForLive(mobile.page, "pr-list");
  const mobileListValues = await Promise.all([
    mobileList.getAttribute("data-ef-stream"),
    mobileList.getAttribute("data-ef-offset"),
    mobileList.getAttribute("data-ef-digest"),
    mobileList.getAttribute("data-ef-reducer"),
    mobileList.getAttribute("data-stream-status"),
  ]);
  attributes(mobileListValues);
  assert.equal(mobileListValues[3], "pr-index@1");
  await mobile.page.goto(`${world.platformUrl}${listPath}/${firstPrId}`);
  const mobileDetail = await waitForLive(mobile.page, "pr-detail");
  const mobileDetailValues = await Promise.all([
    mobileDetail.getAttribute("data-ef-stream"),
    mobileDetail.getAttribute("data-ef-offset"),
    mobileDetail.getAttribute("data-ef-digest"),
    mobileDetail.getAttribute("data-ef-reducer"),
    mobileDetail.getAttribute("data-stream-status"),
  ]);
  attributes(mobileDetailValues);
  assert.deepEqual(mobileDetailValues, desktopDetailValues);
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth), 390);

  const firstRecords = await streamRecords(world, firstPrStream);
  const rootComment = firstRecords.find(
    (record) =>
      record.type === "pr.review-comment" &&
      (record.payload as Record<string, unknown>).body === "Root review comment",
  );
  assert.ok(rootComment);
  const nestedReply = firstRecords.find(
    (record) =>
      record.type === "pr.review-comment" &&
      (record.payload as Record<string, unknown>).body === "Nested durable reply",
  );
  assert.ok(nestedReply);
  assert.equal((nestedReply.payload as Record<string, unknown>).replyTo, rootComment.offset);
  const selectedLine = firstRecords.find(
    (record) =>
      record.type === "pr.review-comment" &&
      (record.payload as Record<string, unknown>).body === "Selected line needs a note",
  );
  assert.ok(selectedLine);
  assert.equal((selectedLine.payload as Record<string, unknown>).path, "docs/feature.ts");
  assert.equal(typeof (selectedLine.payload as Record<string, unknown>).line, "number");
  assert.equal(firstRecords.filter((record) => record.type === "pr.merged").length, 1);
  const secondRecords = await streamRecords(world, secondPrStream);
  assert.equal(secondRecords.filter((record) => record.type === "pr.closed").length, 1);

  const browserTraffic = [
    ...writer.network.slice(writerNetworkStart),
    ...follower.network.slice(followerNetworkStart),
    ...mobile.network,
  ];
  const writes = dispatchRequests(browserTraffic);
  assert.equal(writes.length, 8);
  const otherStateWrites = browserTraffic.filter((entry) => {
    if (entry.layer !== "browser" || entry.direction !== "request") return false;
    if (!new URL(entry.url).pathname.startsWith("/streams/")) return false;
    return entry.method === "POST" || entry.method === "PUT" || entry.method === "PATCH";
  });
  assert.equal(otherStateWrites.length, 0);
  await Promise.all([writer.settleNetwork(), follower.settleNetwork(), mobile.settleNetwork()]);
  writer.assertClean();
  follower.assertClean();
  mobile.assertClean();

  for (const entry of latencies)
    transcript.push(`STEP ${entry.step} latency_ms=${String(entry.ms)} OK`);
  transcript.push(
    `THREAD root=${rootComment.offset} reply=${nestedReply.offset} reply_to=${String((nestedReply.payload as Record<string, unknown>).replyTo)} OK`,
    `LINE path=${String((selectedLine.payload as Record<string, unknown>).path)} line=${String((selectedLine.payload as Record<string, unknown>).line)} OK`,
    `MERGE stream=${firstPrStream} count=1 OK`,
    `CLOSE stream=${secondPrStream} count=1 OK`,
    `MOBILE list_reducer=${mobileListValues[3]} detail_reducer=${mobileDetailValues[3]} width=390 OK`,
    `WRITE-AUDIT dispatches=${String(writes.length)} other_state_writes=0 OK`,
    "CONSOLE errors=0 page_errors=0 request_failures=0 OK",
    "Replay: N/A (installed replayio 1.8.2 exposes no mcp command) + mitigation: exact-head two-session Playwright oracle with serialized browser traffic, durable event replay, mobile parity, and console/page/request failure sweeps.",
    "E5_T09_BROWSER_OK",
  );
  await writeFile(resolve(evidence, "e5-t09-browser.txt"), `${transcript.join("\n")}\n`);
  await writeFile(
    resolve(evidence, "e5-t09-browser-network.json"),
    `${canonicalJson({
      writes: writes.map((entry) => ({
        method: entry.method,
        url: entry.url,
        body: decodedBody(entry),
      })),
      otherStateWrites,
    })}\n`,
  );
  process.stdout.write(`${transcript.join("\n")}\n`);
} finally {
  await Promise.allSettled([writer.close(), follower.close(), mobile.close()]);
  await browser.close();
  await world.close();
}
