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
import { createDurableJsonStream, readDurableJson, type StreamRecord } from "@eforest/client";
import { canonicalJson } from "@eforest/protocol";
import {
  issueStreamId,
  replayWithReducer,
  repoIssueBoardStreamId,
  repoLabelsStreamId,
  requireReducer,
  type IssueBoard,
} from "@eforest/reducers";
import { chromium, type Locator, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T05-issues-ui-live");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const proofReceiptPath = resolve(work, "e5-t05-empty-proof-receipt.json");
const subject = {
  id: "e5-t05-browser",
  email: "e5-t05-browser@canopy.test",
  password: "E5T05Browser1234!",
  name: "E5 T05 Browser",
};
const org = "maple";
const repo = "reading-room";
const issueId = "live-issue";
const issueStream = issueStreamId(org, repo, issueId);
const boardStream = repoIssueBoardStreamId(org, repo);
const labelStream = repoLabelsStreamId(org, repo);
const boardPath = `/orgs/${org}/repos/${repo}/issues`;
const detailPath = `${boardPath}/${issueId}`;

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

async function withinLiveBudget(label: string, work: () => Promise<void>): Promise<number> {
  const started = Date.now();
  try {
    await work();
  } catch (error) {
    throw new Error(`watcher-live-sync:${label}`, { cause: error });
  }
  const latency = Date.now() - started;
  assert.ok(latency <= 2_000, `watcher-live-sync:${label}:${String(latency)}ms`);
  return latency;
}

async function streamRecords(world: { readonly streamUrl: string }, streamId: string) {
  return readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
}

async function authenticatedBoardAt(
  guarded: GuardedPage,
  platformUrl: string,
  offset: string,
): Promise<{ readonly board: IssueBoard; readonly digest: string }> {
  const cookies = await guarded.context.cookies(platformUrl);
  const response = await fetch(
    `${platformUrl}/api/repos/${org}/${repo}/board?at=${encodeURIComponent(offset)}`,
    { headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } },
  );
  assert.equal(response.status, 200);
  return response.json() as Promise<{ readonly board: IssueBoard; readonly digest: string }>;
}

async function boardCards(page: Page): Promise<Record<string, string[]>> {
  return Object.fromEntries(
    await Promise.all(
      ["open", "in-progress", "done", "closed", "wont-do"].map(async (state) => [
        state,
        await page
          .getByTestId(`issue-column-${state}`)
          .getByTestId("issue-card")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-issue-id")!),
          ),
      ]),
    ),
  );
}

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
await world.seedPublicRepo({ org, project: "canopy", repo, branch: "main" });
await createDurableJsonStream({
  url: `${world.streamUrl}/streams/${encodeURIComponent(labelStream)}`,
});
await world.appendApplication(labelStream, {
  type: "label.created",
  payload: { v: 1, labelId: "bug", name: "Bug", color: "#d1242f" },
  ts: 1,
});

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const writer = await world.openPage(browser);
const follower = await world.openPage(browser);
let writerDetail: Page | undefined;
let followerDetail: Page | undefined;

try {
  await Promise.all([
    (async () => {
      await writer.page.goto(world.platformUrl);
      await loginWithFixture(writer.page);
      await writer.page.goto(`${world.platformUrl}${boardPath}`);
    })(),
    (async () => {
      await follower.page.goto(world.platformUrl);
      await loginWithFixture(follower.page);
      await follower.page.goto(`${world.platformUrl}${boardPath}`);
    })(),
  ]);
  await Promise.all([
    writer.page.getByTestId("issue-board-status").getByText("live", { exact: true }).waitFor(),
    follower.page.getByTestId("issue-board-status").getByText("live", { exact: true }).waitFor(),
  ]);
  assert.equal(
    await writer.page.getByTestId("issue-board").getAttribute("data-ef-stream"),
    boardStream,
  );
  assert.equal(
    await writer.page.getByTestId("issue-board").getAttribute("data-ef-reducer"),
    "issue-board@1",
  );

  await writer.page.evaluate(() => {
    let timestamp = 1_700_000_200_000;
    Date.now = () => ++timestamp;
  });
  const writerNetworkStart = writer.network.length;
  const followerNetworkStart = follower.network.length;
  let writerBoardNavigations = 0;
  let followerBoardNavigations = 0;
  writer.page.on("framenavigated", () => (writerBoardNavigations += 1));
  follower.page.on("framenavigated", () => (followerBoardNavigations += 1));

  await replace(writer.page.getByTestId("issue-create-id"), issueId);
  await replace(writer.page.getByTestId("issue-create-title"), "Live issue");
  await replace(
    writer.page.getByTestId("issue-create-body"),
    "Follow this issue from two sessions.",
  );
  const createLatency = await withinLiveBudget("issue-opened", async () => {
    await writer.page.getByTestId("issue-create-submit").click();
    await follower.page.locator(`[data-testid="issue-card"][data-issue-id="${issueId}"]`).waitFor();
  });
  await writer.page.locator(`[data-testid="issue-card"][data-issue-id="${issueId}"]`).waitFor();

  writerDetail = await writer.context.newPage();
  followerDetail = await follower.context.newPage();
  await Promise.all([
    writerDetail.goto(`${world.platformUrl}${detailPath}`),
    followerDetail.goto(`${world.platformUrl}${detailPath}`),
  ]);
  await Promise.all([
    writerDetail.getByTestId("issue-detail-status").getByText("live", { exact: true }).waitFor(),
    followerDetail.getByTestId("issue-detail-status").getByText("live", { exact: true }).waitFor(),
  ]);
  assert.equal(await writerDetail.getByTestId("issue-title").textContent(), "Live issue");
  assert.equal(await followerDetail.getByTestId("issue-timeline-count").textContent(), "1");
  await writerDetail.evaluate(() => {
    let timestamp = 1_700_000_210_000;
    Date.now = () => ++timestamp;
  });
  let writerDetailNavigations = 0;
  let followerDetailNavigations = 0;
  writerDetail.on("framenavigated", () => (writerDetailNavigations += 1));
  followerDetail.on("framenavigated", () => (followerDetailNavigations += 1));

  const latencies = [createLatency];
  for (const [index, body] of ["First watcher comment", "Second watcher comment"].entries()) {
    await replace(writerDetail.getByTestId("issue-comment-id"), `comment-${String(index + 1)}`);
    await replace(writerDetail.getByTestId("issue-comment-body"), body);
    latencies.push(
      await withinLiveBudget(`comment-${String(index + 1)}`, async () => {
        await writerDetail!.getByTestId("issue-comment-submit").click();
        await followerDetail!
          .getByTestId("issue-timeline-count")
          .getByText(String(index + 2), { exact: true })
          .waitFor();
      }),
    );
  }

  await replace(writerDetail.getByTestId("issue-add-label-id"), "bug");
  latencies.push(
    await withinLiveBudget("label-added", async () => {
      await writerDetail!.getByTestId("issue-add-label-submit").click();
      await followerDetail!.locator('[data-testid="issue-label"][data-label-id="bug"]').waitFor();
    }),
  );
  assert.equal(await follower.page.locator('option[value="bug"]').textContent(), "Bug");

  latencies.push(
    await withinLiveBudget("label-removed", async () => {
      await writerDetail!.getByTestId("issue-remove-label").click();
      await followerDetail!
        .locator('[data-testid="issue-label"][data-label-id="bug"]')
        .waitFor({ state: "detached" });
    }),
  );

  for (const [index, nextState] of ["in-progress", "done"].entries()) {
    await writerDetail.getByTestId("issue-transition-to").selectOption(nextState);
    latencies.push(
      await withinLiveBudget(`state-${nextState}`, async () => {
        await writerDetail!.getByTestId("issue-transition-submit").click();
        await followerDetail!
          .getByTestId("issue-state")
          .getByText(nextState, { exact: true })
          .waitFor();
        await follower.page
          .locator(
            `[data-testid="issue-column-${nextState}"] [data-testid="issue-card"][data-issue-id="${issueId}"]`,
          )
          .waitFor();
      }),
    );
    await writerDetail
      .getByTestId("issue-dispatches-reconciled")
      .getByText(String(index + 5), { exact: true })
      .waitFor();
  }

  const beforeRefusalRecords = await streamRecords(world, issueStream);
  const beforeRefusalBytes = canonicalJson(beforeRefusalRecords);
  const beforeRefusalDigest = await followerDetail
    .getByTestId("issue-detail")
    .getAttribute("data-ef-digest");
  const beforeRefusalOffset = await followerDetail
    .getByTestId("issue-detail")
    .getAttribute("data-ef-offset");
  await writerDetail.getByTestId("issue-close-submit").evaluate((button) => {
    (button as HTMLButtonElement).disabled = false;
    (button as HTMLButtonElement).click();
  });
  const refusal = writerDetail.getByTestId("issue-dispatch-error");
  await refusal.waitFor();
  assert.equal(
    await refusal.getAttribute("data-code"),
    "issue/illegal-transition",
    "typed-illegal-transition-refusal",
  );
  assert.equal(canonicalJson(await streamRecords(world, issueStream)), beforeRefusalBytes);
  assert.equal(
    await followerDetail.getByTestId("issue-detail").getAttribute("data-ef-offset"),
    beforeRefusalOffset,
  );
  assert.equal(
    await followerDetail.getByTestId("issue-detail").getAttribute("data-ef-digest"),
    beforeRefusalDigest,
  );

  await Promise.all([writer.settleNetwork(), follower.settleNetwork()]);
  const writerRunNetwork = writer.network.slice(writerNetworkStart);
  const followerRunNetwork = follower.network.slice(followerNetworkStart);
  const writes = dispatchRequests([...writerRunNetwork, ...followerRunNetwork]);
  assert.equal(writes.length, 8);
  assert.deepEqual(
    writes.map((entry) => JSON.parse(decodedBody(entry)).event.type),
    [
      "issue.opened",
      "issue.commented",
      "issue.commented",
      "issue.labeled",
      "issue.unlabeled",
      "issue.state-changed",
      "issue.state-changed",
      "issue.closed",
    ],
  );
  const otherWrites = [...writerRunNetwork, ...followerRunNetwork].filter(
    (entry) =>
      entry.layer === "browser" &&
      entry.direction === "request" &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method ?? "") &&
      new URL(entry.url).pathname !== "/api/dispatch",
  );
  assert.deepEqual(otherWrites, []);

  const writerBoard = writer.page.getByTestId("issue-board");
  const followerBoard = follower.page.getByTestId("issue-board");
  const writerIssue = writerDetail.getByTestId("issue-detail");
  const followerIssue = followerDetail.getByTestId("issue-detail");
  const boardOffset = await followerBoard.getAttribute("data-ef-offset");
  const boardDigest = await followerBoard.getAttribute("data-ef-digest");
  const issueOffset = await followerIssue.getAttribute("data-ef-offset");
  const issueDigest = await followerIssue.getAttribute("data-ef-digest");
  assert.notEqual(boardOffset, null);
  assert.notEqual(boardDigest, null);
  assert.equal(await writerBoard.getAttribute("data-ef-offset"), boardOffset);
  assert.equal(await writerBoard.getAttribute("data-ef-digest"), boardDigest);
  assert.equal(await writerIssue.getAttribute("data-ef-offset"), issueOffset);
  assert.equal(await writerIssue.getAttribute("data-ef-digest"), issueDigest);
  const atOffset = await authenticatedBoardAt(follower, world.platformUrl, boardOffset!);
  assert.equal(atOffset.digest, boardDigest, "board-at-offset-parity");
  assert.deepEqual(
    await boardCards(follower.page),
    Object.fromEntries(
      Object.entries(atOffset.board.columns).map(([state, column]) => [state, column.issues]),
    ),
    "board-literal-equality",
  );
  const acceptedIssueRecords = await streamRecords(world, issueStream);
  const replay = replayWithReducer(
    requireReducer("issue", issueStream),
    acceptedIssueRecords,
    issueStream,
  );
  assert.equal(replay.digest, issueDigest);
  assert.equal(acceptedIssueRecords.length, 7);
  assert.equal((await streamRecords(world, boardStream)).length, 8);
  assert.equal(Math.max(...latencies) <= 2_000, true);
  assert.equal(writerBoardNavigations, 0);
  assert.equal(followerBoardNavigations, 0);
  assert.equal(writerDetailNavigations, 0);
  assert.equal(followerDetailNavigations, 0);
  writer.assertClean();
  follower.assertClean();

  await writeFile(
    resolve(evidence, "e5-t05-session.events.jsonl"),
    `${acceptedIssueRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  await writeFile(
    resolve(evidence, "e5-t05-write-audit.txt"),
    [
      "E5-T05 browser write audit",
      "dispatch-posts=8 accepted=7 refused=1 other-state-writes=0",
      `event-types=${acceptedIssueRecords.map((record) => record.type).join(",")}`,
      `offsets=${acceptedIssueRecords.map((record) => record.offset).join(",")}`,
      "E5_T05_WRITE_AUDIT_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t05-refusal.txt"),
    [
      "E5-T05 illegal transition refusal",
      "code=issue/illegal-transition",
      `before-after-log-bytes-equal=${String(canonicalJson(await streamRecords(world, issueStream)) === beforeRefusalBytes)}`,
      `offset-before-after=${String(beforeRefusalOffset)}`,
      `digest-before-after=${String(beforeRefusalDigest)}`,
      "E5_T05_REFUSAL_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t05-digests.txt"),
    [
      "E5-T05 two-session convergence",
      `board-stream=${boardStream}`,
      `board-offset=${String(boardOffset)}`,
      `writer-board-digest=${String(await writerBoard.getAttribute("data-ef-digest"))}`,
      `follower-board-digest=${String(boardDigest)}`,
      `endpoint-at-offset-digest=${atOffset.digest}`,
      `issue-stream=${issueStream}`,
      `issue-offset=${String(issueOffset)}`,
      `writer-issue-digest=${String(await writerIssue.getAttribute("data-ef-digest"))}`,
      `follower-issue-digest=${String(issueDigest)}`,
      `replay-issue-digest=${replay.digest}`,
      `latencies-ms=${latencies.join(",")}`,
      "E5_T05_DIGESTS_OK",
      "",
    ].join("\n"),
  );
  process.stdout.write(
    `E5_T05_BROWSER_OK accepted=7 refused=1 max_latency_ms=${String(Math.max(...latencies))} board_offset=${String(boardOffset)} issue_offset=${String(issueOffset)}\n`,
  );
} finally {
  await Promise.allSettled([writerDetail?.close(), followerDetail?.close()]);
  await Promise.allSettled([writer.close(), follower.close()]);
  await browser.close();
  await world.close();
}
