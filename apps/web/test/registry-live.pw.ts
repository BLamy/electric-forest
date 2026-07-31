import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { canonicalJson, type Event } from "@eforest/protocol";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T04-repo-list-live");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const dumpPath = resolve(evidence, "e3-t04-authorized-registry.jsonl");
const transcriptPath = resolve(evidence, "e3-t04-browser.txt");
const digestPath = resolve(evidence, "e3-t04-digest.txt");
const subject = {
  id: "ada-registry",
  email: "ada.registry@canopy.test",
  password: "AdaRegistry1234!",
  name: "Ada Registry",
};

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
const proofReceiptPath = resolve(work, "e3-t04-empty-proof-receipt.json");
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
});
await world.dispatchNamespace(
  "ns:root",
  { type: "ns.org.create", payload: { v: 1, name: "oak" }, ts: 10 },
  "auth0|outsider",
);
await world.dispatchNamespace(
  "ns:org:oak",
  { type: "ns.project.create", payload: { v: 1, name: "secrets" }, ts: 11 },
  "auth0|outsider",
);

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const clients = [await world.openPage(browser), await world.openPage(browser)];
let transcript = "E3-T04 two-client live registry projection\n";
let forcedReconnect = false;
await clients[1]!.page.route("**/registry/me?*", async (route) => {
  const url = new URL(route.request().url());
  if (!forcedReconnect && url.searchParams.get("live") === "1") {
    forcedReconnect = true;
    await route.fulfill({ status: 204 });
    return;
  }
  await route.fallback();
});

async function waitForRepo(client: (typeof clients)[number], repo: string): Promise<void> {
  try {
    await client.page
      .locator(`[data-testid="repository-row"][data-repo="${repo}"]`)
      .waitFor({ state: "visible" });
  } catch (error) {
    await client.settleNetwork();
    const status = await client.page
      .getByTestId("registry-browser")
      .getAttribute("data-stream-status");
    const responses = client.network
      .filter(
        (entry) => entry.direction === "response" && new URL(entry.url).pathname === "/registry/me",
      )
      .map((entry) => ({
        status: entry.status,
        body:
          entry.bodyBase64 === null
            ? null
            : Buffer.from(entry.bodyBase64, "base64").toString("utf8"),
      }));
    throw new Error(
      `repo ${repo} not visible: streamStatus=${String(status)} responses=${JSON.stringify(responses)}`,
      { cause: error },
    );
  }
}

try {
  for (const client of clients) {
    await client.page.goto(world.platformUrl);
    await loginWithFixture(client.page);
    await client.page.getByRole("link", { name: "Repositories", exact: true }).click();
    await client.page.getByTestId("registry-browser").waitFor();
    await client.page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="registry-browser"]')
          ?.getAttribute("data-stream-status") === "live",
    );
    await waitForRepo(client, "reading-room");
  }

  const initial = clients[0]!.page.getByTestId("registry-browser");
  const initialCheckpoint = await initial.getAttribute("data-application-checkpoint");
  const initialDigest = await initial.getAttribute("data-state-digest");
  assert.equal(forcedReconnect, true);
  transcript += `bootstrap clients=2 checkpoint=${initialCheckpoint} digest=${initialDigest} reconnect=true\n`;

  await Promise.all([
    world.dispatchNamespace(
      "ns:org:oak",
      {
        type: "ns.repo.create",
        payload: {
          v: 1,
          name: "hidden-vault",
          project: "secrets",
          visibility: "private",
        },
        ts: 12,
      },
      "auth0|outsider",
    ),
    world.dispatchNamespace("ns:org:maple", {
      type: "ns.repo.create",
      payload: { v: 1, name: "new-leaf", project: "canopy", visibility: "private" },
      ts: 13,
    }),
  ]);

  await Promise.all(clients.map((client) => waitForRepo(client, "new-leaf")));
  for (const client of clients) {
    assert.equal(await client.page.getByText("hidden-vault").count(), 0);
    assert.equal(
      await client.page.evaluate(() => performance.getEntriesByType("navigation").length),
      1,
    );
  }

  const browserProjection = await clients[0]!.page.evaluate(async () => {
    const response = await fetch("/registry/me?projection=1&reducer=registry");
    if (!response.ok) throw new Error(`projection ${String(response.status)}`);
    return (await response.json()) as {
      readonly events: readonly Event[];
      readonly checkpoint: string;
    };
  });
  await writeFile(
    dumpPath,
    `${browserProjection.events.map((event) => canonicalJson(event)).join("\n")}\n`,
  );
  const replay = await run(
    process.execPath,
    [
      resolve(root, "packages/cli/dist/src/bin.js"),
      "replay",
      dumpPath,
      "--digest",
      "--reducer",
      resolve(root, "packages/platform/registry-reducer.mjs"),
    ],
    { cwd: root },
  );
  const cliDigest = replay.stdout.trim();
  const expectedLiveDigest = "660090db9949ddc8e0f247e4d7040114b00ace19a9f207fa1a57613c4c2415b2";
  const checkpoints = await Promise.all(
    clients.map((client) =>
      client.page.getByTestId("registry-browser").getAttribute("data-application-checkpoint"),
    ),
  );
  const digests = await Promise.all(
    clients.map((client) =>
      client.page.getByTestId("registry-browser").getAttribute("data-state-digest"),
    ),
  );
  assert.equal(new Set(checkpoints).size, 1);
  assert.equal(new Set(digests).size, 1);
  assert.equal(checkpoints[0], browserProjection.checkpoint);
  assert.equal(digests[0], cliDigest);
  assert.equal(cliDigest, expectedLiveDigest);
  assert.notEqual(checkpoints[0], initialCheckpoint);
  assert.notEqual(digests[0], initialDigest);

  await clients[1]!.page.getByRole("link", { name: "maple", exact: true }).click();
  assert.equal(
    await clients[1]!.page.getByTestId("route-org").textContent(),
    "Organization: maple",
  );
  const orgRows = await clients[1]!.page
    .locator('[data-testid="repository-row"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-repo")));
  assert.deepEqual(orgRows, ["new-leaf", "reading-room"]);

  const projectionBodies = clients
    .flatMap((client) => client.network)
    .filter(
      (entry) =>
        entry.direction === "response" &&
        new URL(entry.url).pathname === "/registry/me" &&
        entry.bodyBase64 !== null,
    )
    .map((entry) => Buffer.from(entry.bodyBase64!, "base64").toString("utf8"));
  assert.ok(projectionBodies.length > 0);
  assert.equal(
    projectionBodies.some((body) => body.includes("hidden-vault")),
    false,
  );
  assert.equal(
    projectionBodies.some((body) => body.includes("fs:oak/")),
    false,
  );
  assert.equal(
    projectionBodies.some((body) => body.includes("auth0|outsider")),
    false,
  );

  for (const client of clients) {
    await client.settleNetwork();
    const failedResponses = client.network
      .filter(
        (entry) =>
          entry.direction === "response" && entry.status !== undefined && entry.status >= 400,
      )
      .map((entry) => `${String(entry.status)} ${entry.url}`);
    assert.deepEqual(failedResponses, []);
    client.assertClean();
  }
  transcript += `live checkpoint=${checkpoints[0]} digest=${digests[0]} cli=equal reloads=0 clients=2\n`;
  transcript +=
    "private-leak hidden-vault=false fs:oak=false outsider=false org-sort=new-leaf,reading-room\n";
  transcript += "console-errors=0 page-errors=0 request-failures=0\n";
  await writeFile(transcriptPath, transcript);
  await writeFile(
    digestPath,
    `bootstrap=${initialDigest}\nlive=${digests[0]}\ncheckpoint=${checkpoints[0]}\ncli=${cliDigest}\n`,
  );
  process.stdout.write(transcript);
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await browser.close();
  await world.close();
}
// This is a standalone acceptance executable. All product processes, servers,
// pages, contexts, and runtime workers are closed above; terminate the runner
// explicitly so a host PTY cannot turn a completed proof into a false timeout.
process.exit(0);
