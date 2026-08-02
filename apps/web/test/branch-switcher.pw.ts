import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { OfficialStreamAdapter, RepositoryHomeStore } from "@eforest/platform";
import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { replayWithReducer, requireReducer } from "@eforest/reducers";
import { digestBytes, resolveBranchLog, treeDigest, type FsTree } from "@eforest/streamfs";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T08-branch-switcher");
const evidence = resolve(task, "evidence");
const subject = {
  id: "ada-branch-switcher",
  email: "ada.branch-switcher@canopy.test",
  password: "AdaBranchSwitcher1234!",
  name: "Ada Branch Switcher",
};
const mainContent = "fs:maple/reading-room:main:file:readme";
const branchContent = "fs:maple/reading-room:feature:file:1-feature";
const mainBytes = new TextEncoder().encode("main branch\n");
const branchBytes = new TextEncoder().encode("feature branch\n");

async function records(world: { readonly streamUrl: string }, streamId: string) {
  return readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
}

function branchStreamId(branch: string): string {
  return `fs:maple/reading-room:${branch}:meta`;
}

function stripWriterMetadata(record: StreamRecord): StreamRecord {
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    return record;
  }
  return {
    ...record,
    payload: Object.fromEntries(
      Object.entries(record.payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
  };
}

function logicalRecords(
  branch: string,
  main: readonly StreamRecord[],
  leaf: readonly StreamRecord[],
): readonly StreamRecord[] {
  const resolved =
    branch === "main"
      ? main
      : resolveBranchLog([
          { streamId: branchStreamId(branch), records: leaf.map(stripWriterMetadata) },
          { streamId: branchStreamId("main"), records: main.map(stripWriterMetadata) },
        ]);
  return resolved.map((record, ordinal) => ({ ...record, offset: offsetForOrdinal(ordinal) }));
}

const world = await bootWorld({
  root,
  subject,
  fixtureLogin: true,
  proofReceiptPath: resolve(task, "work/e3-t08-empty-proof-receipt.json"),
});
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
let consoleErrors = 0;
let pageErrors = 0;
let abortedRequests = 0;
guarded.page.on("console", (message) => {
  if (message.type() === "error") consoleErrors += 1;
});
guarded.page.on("pageerror", () => {
  pageErrors += 1;
});
guarded.page.on("requestfailed", (request) => {
  if (request.failure()?.errorText === "net::ERR_ABORTED") abortedRequests += 1;
});
const mainStream = await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: [
    { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 },
    {
      type: "fs.file.create",
      payload: { v: 2, path: "docs/readme.md", contentStreamId: mainContent },
      ts: 2,
    },
    {
      type: "fs.file.write",
      payload: {
        v: 2,
        path: "docs/readme.md",
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

let repositoryEventTime = 100;
const homes = new RepositoryHomeStore(streams, () => repositoryEventTime++);
await homes.ensureRepository("maple", "reading-room", "canopy");
const forkOffset = (await records(world, mainStream)).at(-1)!.offset;
const featureStream = branchStreamId("feature");
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
await homes.registerNativeBranch("maple", "reading-room", "feature");
await streams.create(branchContent);
await streams.append(branchContent, {
  type: "fs.file.content",
  payload: {
    v: 2,
    contentStreamId: branchContent,
    contentBase64: Buffer.from(branchBytes).toString("base64"),
  },
  ts: 6,
});
await streams.append(
  featureStream,
  {
    type: "fs.file.create",
    payload: { v: 2, path: "docs/feature.md", contentStreamId: branchContent },
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
      path: "docs/feature.md",
      base: "BASE_NONE",
      contentSha256: digestBytes(branchBytes),
      size: branchBytes.byteLength,
    },
    ts: 6,
  },
  { sequence: offsetForOrdinal(2), applicationOffset: offsetForOrdinal(2) },
);

const transcript: string[] = ["E3-T08 native-fork branch switcher browser proof"];
let holdFeatureBootstrap = false;
let releaseFeatureBootstrap!: () => void;
const featureBootstrapGate = new Promise<void>((resolveRelease) => {
  releaseFeatureBootstrap = resolveRelease;
});

await mkdir(evidence, { recursive: true });
await mkdir(resolve(task, "work"), { recursive: true });
await writeFile(resolve(task, "work/e3-t08-empty-proof-receipt.json"), "{}\n");

async function independent(branch: string) {
  const main = await records(world, mainStream);
  const leaf = await records(world, branchStreamId(branch));
  const logical = logicalRecords(branch, main, leaf);
  const replay = replayWithReducer(requireReducer("streamfs", branchStreamId(branch)), logical);
  return {
    checkpoint: logical.at(-1)?.offset ?? "-1",
    digest: replay.digest,
    tree: replay.state as FsTree,
    events: logical,
    source: { main, leaf },
  };
}

await guarded.page.route("**/api/repos/maple/reading-room/feature/events*", async (route) => {
  const url = new URL(route.request().url());
  if (holdFeatureBootstrap && url.searchParams.get("live") !== "1") {
    await featureBootstrapGate;
  }
  try {
    await route.fallback();
  } catch {
    // The route is expected to be aborted when the old branch is rebound.
  }
});

await guarded.page.addInitScript(() => {
  const originalFetch = window.fetch.bind(window);
  const control = { enabled: false, used: false };
  (window as unknown as { __e3t08Reconnect: typeof control }).__e3t08Reconnect = control;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
      window.location.origin,
    );
    if (
      control.enabled &&
      !control.used &&
      url.pathname.includes("/feature/events") &&
      url.searchParams.get("live") === "1"
    ) {
      control.used = true;
      throw new TypeError("fixture reconnect feature");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

try {
  await guarded.page.goto(world.platformUrl);
  await loginWithFixture(guarded.page);
  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="tree-browser"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  const mainInitial = await independent("main");
  const mainTree = guarded.page.getByTestId("tree-browser");
  assert.equal(await mainTree.getAttribute("data-branch"), "main");
  assert.equal(await mainTree.getAttribute("data-state-digest"), mainInitial.digest);
  assert.equal(await mainTree.getAttribute("data-fork-checkpoint"), "-1");
  assert.equal(
    await guarded.page.getByTestId("branch-selector").getAttribute("aria-label"),
    "Repository branch",
  );
  transcript.push(
    `main digest=${mainInitial.digest} checkpoint=${mainInitial.checkpoint} isolated=true`,
  );

  holdFeatureBootstrap = true;
  await guarded.page.getByTestId("branch-selector").selectOption("feature");
  await guarded.page.getByTestId("tree-loading").waitFor();
  await guarded.page.getByTestId("branch-selector").selectOption("main");
  releaseFeatureBootstrap();
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="tree-browser"]')?.getAttribute("data-branch") ===
      "main",
  );
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "feature.md" }).count(),
    0,
  );
  transcript.push("delayed-old-feature-frame ignored-after-rebind=true");

  holdFeatureBootstrap = false;
  await guarded.page.getByTestId("branch-selector").selectOption("feature");
  await guarded.page.getByRole("link", { name: "docs/", exact: true }).click();
  await guarded.page.getByTestId("tree-row").filter({ hasText: "feature.md" }).waitFor();
  const featureInitial = await independent("feature");
  const featureTree = guarded.page.getByTestId("tree-browser");
  assert.equal(await featureTree.getAttribute("data-branch"), "feature");
  assert.equal(await featureTree.getAttribute("data-parent-stream"), mainStream);
  assert.equal(await featureTree.getAttribute("data-fork-checkpoint"), forkOffset);
  assert.equal(await featureTree.getAttribute("data-head-checkpoint"), featureInitial.checkpoint);
  assert.equal(await featureTree.getAttribute("data-state-digest"), featureInitial.digest);
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "readme.md" }).count(),
    1,
  );
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "feature.md" }).count(),
    1,
  );
  transcript.push(
    `feature inherited=true branch-only=true digest=${featureInitial.digest} checkpoint=${featureInitial.checkpoint}`,
  );

  await guarded.page
    .getByTestId("tree-row")
    .filter({ hasText: "feature.md" })
    .getByRole("link")
    .click();
  await guarded.page.getByTestId("file-content").waitFor();
  assert.equal(await guarded.page.getByTestId("file-content").textContent(), "feature branch\n");
  assert.equal(
    await guarded.page.getByTestId("file-viewer").getAttribute("data-branch"),
    "feature",
  );
  assert.equal(
    await guarded.page.getByTestId("file-viewer").getAttribute("data-content-digest"),
    digestBytes(branchBytes),
  );
  transcript.push("blob feature branch-owned-content=true parent-bytes-not-leaked=true");

  await guarded.page.getByTestId("branch-selector").selectOption("main");
  await guarded.page.getByTestId("file-missing").waitFor();
  assert.equal(
    await guarded.page.getByTestId("file-viewer").getAttribute("data-file-identity"),
    "",
  );
  assert.equal(await guarded.page.getByTestId("file-content").count(), 0);
  transcript.push("branch-only-path-on-main missing=true stale-content=false");

  await guarded.page
    .getByTestId("file-breadcrumbs")
    .getByRole("link", { name: "File tree" })
    .click();
  await guarded.page.getByRole("link", { name: "docs/", exact: true }).click();
  await guarded.page
    .getByTestId("tree-row")
    .filter({ hasText: "readme.md" })
    .getByRole("link")
    .click();
  await guarded.page.getByTestId("file-content").waitFor();
  assert.equal(await guarded.page.getByTestId("file-content").textContent(), "main branch\n");

  await guarded.page.evaluate(() => {
    (window as unknown as { __e3t08Reconnect: { enabled: boolean } }).__e3t08Reconnect.enabled =
      true;
  });
  await world.appendApplication(featureStream, {
    type: "fs.dir.create",
    payload: { v: 2, path: "branch-live" },
    ts: 20,
  });
  await world.appendApplication(mainStream, {
    type: "fs.dir.create",
    payload: { v: 2, path: "main-live" },
    ts: 21,
  });
  await guarded.page
    .getByTestId("file-breadcrumbs")
    .getByRole("link", { name: "File tree" })
    .click();
  await guarded.page.getByTestId("branch-selector").selectOption("feature");
  await guarded.page.getByTestId("tree-row").filter({ hasText: "branch-live" }).waitFor();
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "main-live" }).count(),
    0,
  );
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="tree-browser"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  transcript.push(
    "feature-reconnect-after-write converged=true branch-live=true main-live-leaked=false",
  );

  await guarded.page.getByTestId("branch-selector").selectOption("main");
  await guarded.page.getByTestId("tree-row").filter({ hasText: "main-live" }).waitFor();
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "branch-live" }).count(),
    0,
  );
  await guarded.page.getByTestId("branch-selector").selectOption("feature");
  await guarded.page.getByTestId("tree-row").filter({ hasText: "branch-live" }).waitFor();
  transcript.push("rapid-switch-main-feature retained-checkpoint=true late-frame-isolated=true");

  const finalFeature = await independent("feature");
  await guarded.page.waitForFunction(
    ({ checkpoint, digest }) => {
      const node = document.querySelector('[data-testid="tree-browser"]');
      return (
        node?.getAttribute("data-head-checkpoint") === checkpoint &&
        node.getAttribute("data-state-digest") === digest
      );
    },
    { checkpoint: finalFeature.checkpoint, digest: finalFeature.digest },
  );
  await guarded.settleNetwork();
  assert.equal(consoleErrors, 0);
  assert.equal(pageErrors, 0);
  transcript.push(
    `final feature checkpoint=${finalFeature.checkpoint} digest=${finalFeature.digest} independent-replay=equal console-errors=${String(consoleErrors)} page-errors=${String(pageErrors)} expected-route-aborts=${String(abortedRequests)}`,
  );
  await writeFile(resolve(evidence, "e3-t08-browser.txt"), `${transcript.join("\n")}\n`);
  await writeFile(
    resolve(evidence, "e3-t08-digests.json"),
    `${canonicalJson({
      main: { checkpoint: mainInitial.checkpoint, digest: mainInitial.digest },
      feature: { checkpoint: featureInitial.checkpoint, digest: featureInitial.digest },
      finalFeature: { checkpoint: finalFeature.checkpoint, digest: finalFeature.digest },
      featureTreeDigest: treeDigest(finalFeature.tree),
    })}\n`,
  );
  await writeFile(
    resolve(evidence, "e3-t08-events.json"),
    `${canonicalJson({ feature: finalFeature.events, main: mainInitial.events })}\n`,
  );
  process.stdout.write(`${transcript.join("\n")}\n`);
} finally {
  await guarded.close();
  await browser.close();
  await world.close();
}

process.exit(0);
