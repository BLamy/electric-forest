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
import { canonicalJson, type Event } from "@eforest/protocol";
import { replayWithReducer, repoLabelsStreamId, requireReducer } from "@eforest/reducers";
import { chromium, type Locator } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T04-browser-dispatch-hook");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const proofReceiptPath = resolve(work, "e5-t04-empty-proof-receipt.json");
const subject = {
  id: "e5-t04-browser",
  email: "e5-t04-browser@canopy.test",
  password: "E5T04Browser1234!",
  name: "E5 T04 Browser",
};
const org = "maple";
const repo = "reading-room";
const labelStream = repoLabelsStreamId(org, repo);
const labelsPath = `/orgs/${org}/repos/${repo}/labels`;

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

async function replace(locator: Locator, value: string): Promise<void> {
  await locator.click();
  await locator.press("ControlOrMeta+A");
  await locator.pressSequentially(value);
}

async function counter(guarded: GuardedPage, name: string): Promise<number> {
  return Number(await guarded.page.getByTestId(`dispatches-${name}`).textContent());
}

async function streamRecords(world: {
  readonly streamUrl: string;
}): Promise<readonly StreamRecord[]> {
  return readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(labelStream)}`,
  });
}

async function board(
  platformUrl: string,
): Promise<{ readonly digest: string; readonly body: unknown }> {
  const response = await fetch(`${platformUrl}/api/repos/${org}/${repo}/board`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { readonly digest: string };
  assert.match(body.digest, /^[a-f0-9]{64}$/);
  return { digest: body.digest, body };
}

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
await world.seedPublicRepo({ org, project: "canopy", repo, branch: "main" });
const boardBefore = await board(world.platformUrl);
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const writer = await world.openPage(browser);
const follower = await world.openPage(browser);
let releaseTail: (() => void) | undefined;
let markTailBlocked: (() => void) | undefined;
let pauseTail = false;
const tailBlocked = (): Promise<void> =>
  new Promise((resolveBlocked) => {
    markTailBlocked = resolveBlocked;
  });

try {
  await writer.context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      pauseTail &&
      url.pathname.endsWith("/events") &&
      url.searchParams.get("stream") === "repo-labels" &&
      url.searchParams.get("live") === "1"
    ) {
      markTailBlocked?.();
      await new Promise<void>((resolveRelease) => {
        releaseTail = resolveRelease;
      });
    }
    await route.fallback();
  });

  await Promise.all([
    (async () => {
      await writer.page.goto(world.platformUrl);
      await loginWithFixture(writer.page);
      await writer.page.goto(`${world.platformUrl}${labelsPath}`);
    })(),
    (async () => {
      await follower.page.goto(world.platformUrl);
      await loginWithFixture(follower.page);
      await follower.page.goto(`${world.platformUrl}${labelsPath}`);
    })(),
  ]);
  await Promise.all([
    writer.page.getByTestId("labels-status").getByText("live", { exact: true }).waitFor(),
    follower.page.getByTestId("labels-status").getByText("live", { exact: true }).waitFor(),
  ]);
  assert.equal(
    await writer.page.getByTestId("label-management").getAttribute("data-ef-reducer"),
    "repo-labels",
  );
  assert.equal(await writer.page.getByTestId("labels-empty").isVisible(), true);
  await writer.page.evaluate(() => {
    let timestamp = 1_700_000_100_000;
    Date.now = () => ++timestamp;
  });

  const writerNetworkStart = writer.network.length;
  const followerNetworkStart = follower.network.length;
  let writerNavigations = 0;
  let followerNavigations = 0;
  writer.page.on("framenavigated", () => (writerNavigations += 1));
  follower.page.on("framenavigated", () => (followerNavigations += 1));

  pauseTail = true;
  const blocked = tailBlocked();
  await blocked;
  const beforeOffset = await writer.page
    .getByTestId("label-management")
    .getAttribute("data-ef-offset");
  const beforeDigest = await writer.page
    .getByTestId("label-management")
    .getAttribute("data-ef-digest");

  await replace(writer.page.getByTestId("label-create-id"), "bug");
  await replace(writer.page.getByTestId("label-create-name"), "Bug");
  await replace(writer.page.getByTestId("label-create-color"), "#d1242f");
  const acceptedAt = Date.now();
  await writer.page.getByTestId("label-create-submit").click();
  await writer.page.getByTestId("dispatches-confirmed").getByText("1", { exact: true }).waitFor();
  const confirmedOffset = await writer.page
    .getByTestId("label-management")
    .getAttribute("data-ef-confirmed-offset");
  assert.notEqual(confirmedOffset, "");
  assert.equal(
    await writer.page.getByTestId("label-management").getAttribute("data-ef-offset"),
    beforeOffset,
  );
  assert.equal(
    await writer.page.getByTestId("label-management").getAttribute("data-ef-digest"),
    beforeDigest,
  );
  assert.equal(
    await writer.page.getByTestId("label-row").count(),
    0,
    "severed-tail-replay-only-label-rows",
  );
  assert.equal(await counter(writer, "reconciled"), 0);

  await follower.page
    .locator('[data-testid="label-row"][data-label-id="bug"]')
    .waitFor({ timeout: 2_000 });
  const followerLatencyMs = Date.now() - acceptedAt;
  assert.ok(followerLatencyMs <= 2_000, `follower latency ${String(followerLatencyMs)}ms`);

  releaseTail?.();
  pauseTail = false;
  await writer.page
    .locator('[data-testid="label-row"][data-label-id="bug"]')
    .waitFor({ timeout: 2_000 });
  await writer.page.getByTestId("dispatches-reconciled").getByText("1", { exact: true }).waitFor();
  assert.equal(
    await writer.page.getByTestId("label-management").getAttribute("data-ef-offset"),
    confirmedOffset,
  );

  const bugRow = writer.page.locator('[data-testid="label-row"][data-label-id="bug"]');
  await replace(bugRow.getByTestId("label-rename-name"), "Defect");
  await bugRow.getByRole("button", { name: "Rename" }).click();
  await writer.page.getByTestId("dispatches-reconciled").getByText("2", { exact: true }).waitFor();
  await follower.page
    .getByTestId("label-name")
    .getByText("Defect", { exact: true })
    .waitFor({ timeout: 2_000 });

  await replace(bugRow.getByTestId("label-recolor-color"), "#8250df");
  await bugRow.getByRole("button", { name: "Recolor" }).click();
  await writer.page.getByTestId("dispatches-reconciled").getByText("3", { exact: true }).waitFor();

  const acceptedRecords = await streamRecords(world);
  assert.deepEqual(
    acceptedRecords.map((record) => record.type),
    ["label.created", "label.renamed", "label.recolored"],
  );
  const beforeRefusalBytes = canonicalJson(acceptedRecords);
  const beforeRefusalBoard = await board(world.platformUrl);
  const beforeRefusalDigest = await writer.page
    .getByTestId("label-management")
    .getAttribute("data-ef-digest");
  const beforeRefusalConfirmed = await counter(writer, "confirmed");

  await replace(writer.page.getByTestId("label-create-id"), "duplicate-name");
  await replace(writer.page.getByTestId("label-create-name"), "Defect");
  await writer.page.getByTestId("label-create-submit").click();
  const refusal = writer.page.getByTestId("dispatch-error");
  await refusal.waitFor();
  assert.equal(
    await refusal.getAttribute("data-code"),
    "label/duplicate-name",
    "typed-refusal-code",
  );
  assert.equal(await counter(writer, "refused"), 1);
  assert.equal(await counter(writer, "confirmed"), beforeRefusalConfirmed);
  const afterRefusalRecords = await streamRecords(world);
  assert.equal(afterRefusalRecords.length, acceptedRecords.length, "refusal-log-line-count");
  assert.equal(canonicalJson(afterRefusalRecords), beforeRefusalBytes, "refusal-log-byte-equality");
  assert.equal(
    await writer.page.getByTestId("label-management").getAttribute("data-ef-digest"),
    beforeRefusalDigest,
  );
  assert.equal((await board(world.platformUrl)).digest, beforeRefusalBoard.digest);

  const unauthenticatedAction: Event = {
    type: "label.created",
    payload: { v: 1, labelId: "unauthenticated", name: "Unauthenticated", color: "#000000" },
    ts: 99,
  };
  const unauthenticated = await fetch(`${world.platformUrl}/api/dispatch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-eforest-dispatch-receipt": "offset",
    },
    body: JSON.stringify({ streamId: labelStream, event: unauthenticatedAction }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(canonicalJson(await streamRecords(world)), beforeRefusalBytes);

  await Promise.all([writer.settleNetwork(), follower.settleNetwork()]);
  const writerRunNetwork = writer.network.slice(writerNetworkStart);
  const followerRunNetwork = follower.network.slice(followerNetworkStart);
  const writes = dispatchRequests([...writerRunNetwork, ...followerRunNetwork]);
  assert.equal(writes.length, 4);
  assert.deepEqual(
    writes.map((entry) => JSON.parse(decodedBody(entry)).event.type),
    ["label.created", "label.renamed", "label.recolored", "label.created"],
  );
  const otherWrites = [...writerRunNetwork, ...followerRunNetwork].filter(
    (entry) =>
      entry.layer === "browser" &&
      entry.direction === "request" &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method ?? "") &&
      new URL(entry.url).pathname !== "/api/dispatch",
  );
  assert.deepEqual(otherWrites, []);

  const writerRegion = writer.page.getByTestId("label-management");
  const followerRegion = follower.page.getByTestId("label-management");
  const writerOffset = await writerRegion.getAttribute("data-ef-offset");
  const followerOffset = await followerRegion.getAttribute("data-ef-offset");
  const writerDigest = await writerRegion.getAttribute("data-ef-digest");
  const followerDigest = await followerRegion.getAttribute("data-ef-digest");
  assert.equal(writerOffset, followerOffset);
  assert.equal(writerDigest, followerDigest);
  assert.equal(
    await writerRegion.getAttribute("data-ef-confirmed-offset"),
    writerOffset,
    "confirmed-offset-four-way-equality",
  );
  const replay = replayWithReducer(requireReducer("repo-labels", labelStream), acceptedRecords);
  assert.equal(replay.digest, writerDigest);
  assert.notEqual((await board(world.platformUrl)).digest, boardBefore.digest);
  assert.equal(writerNavigations, 0);
  assert.equal(followerNavigations, 0);
  writer.assertClean();
  follower.assertClean();

  await writeFile(
    resolve(evidence, "e5-t04-write-audit.txt"),
    [
      "E5-T04 browser write audit",
      "dispatch-posts=4 accepted=3 refused=1 other-state-writes=0",
      `event-types=${acceptedRecords.map((record) => record.type).join(",")}`,
      `offsets=${acceptedRecords.map((record) => record.offset).join(",")}`,
      "E5_T04_WRITE_AUDIT_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t04-refusal.txt"),
    [
      "E5-T04 typed refusal",
      "code=label/duplicate-name validator-status=409 web-envelope-status=200",
      `before-after-log-bytes-equal=${String(canonicalJson(await streamRecords(world)) === beforeRefusalBytes)}`,
      `digest=${String(beforeRefusalDigest)}`,
      `board-digest=${beforeRefusalBoard.digest}`,
      "unauthenticated-status=401 append=false",
      "E5_T04_REFUSAL_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t04-digests.txt"),
    [
      "E5-T04 convergence",
      `writer-offset=${String(writerOffset)}`,
      `follower-offset=${String(followerOffset)}`,
      `confirmed-offset=${String(await writerRegion.getAttribute("data-ef-confirmed-offset"))}`,
      `writer-digest=${String(writerDigest)}`,
      `follower-digest=${String(followerDigest)}`,
      `replay-digest=${replay.digest}`,
      `follower-latency-ms=${String(followerLatencyMs)}`,
      `board-before=${boardBefore.digest}`,
      `board-after=${(await board(world.platformUrl)).digest}`,
      "E5_T04_DIGESTS_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t04-session.events.jsonl"),
    `${acceptedRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  process.stdout.write(
    `E5_T04_BROWSER_OK accepted=3 refused=1 follower_latency_ms=${String(followerLatencyMs)} offset=${String(writerOffset)} digest=${String(writerDigest)}\n`,
  );
} finally {
  releaseTail?.();
  await Promise.allSettled([writer.close(), follower.close()]);
  await browser.close();
  await world.close();
}
