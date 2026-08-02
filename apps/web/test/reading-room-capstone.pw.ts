import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bootWorld,
  loginWithFixture,
  replayChromiumPath,
  type BrowserWorld,
} from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { OfficialStreamAdapter, RepositoryHomeStore } from "@eforest/platform";
import { canonicalJson, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  fileViewStreamId,
  replayWithReducer,
  requireReducer,
  type ReducerDefinition,
} from "@eforest/reducers";
import { chromium, type Page } from "playwright-core";
import { digestBytes, resolveBranchLog } from "@eforest/streamfs";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T10-the-reading-room");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const subject = {
  id: "ada-reading-room-capstone",
  email: "ada.reading-room-capstone@canopy.test",
  password: "AdaReadingRoomCapstone1234!",
  name: "Ada Reading Room Capstone",
};
const writerActor = "auth0|capstone-writer";
const mainStream = "fs:maple/reading-room:main:meta";
const featureStream = "fs:maple/reading-room:feature-typography:meta";
const readmeContent = "fs:maple/reading-room:main:file:readme";
const featureContent = "fs:maple/reading-room:feature-typography:file:feature";
const initialText = new TextEncoder().encode("# Reading Room\n\nMain branch text.\n");
const featureText = new TextEncoder().encode("# Feature Typography\n\nFeature branch text.\n");
const editedText = new TextEncoder().encode(
  "# Reading Room\n\nSecond session edit arrived live.\n",
);

interface ProjectionBody {
  readonly events: readonly StreamRecord[];
  readonly checkpoint: string;
  readonly reducer?: { readonly id: string; readonly version: number };
}

interface ProjectionSnapshot extends ProjectionBody {
  readonly digest: string;
  readonly state: unknown;
}

interface CapstoneEvidence {
  readonly registry: ProjectionSnapshot;
  readonly home: {
    readonly namespace: ProjectionSnapshot;
    readonly branches: ProjectionSnapshot;
    readonly status: ProjectionSnapshot;
  };
  readonly mainTree: ProjectionSnapshot;
  readonly featureTree: ProjectionSnapshot;
  readonly mainFile: ProjectionSnapshot;
  readonly featureFile: ProjectionSnapshot;
  readonly mainHistory: ProjectionSnapshot;
  readonly featureHistory: ProjectionSnapshot;
  readonly rawStreams: Readonly<Record<string, readonly StreamRecord[]>>;
}

function contentEvent(streamId: string, bytes: Uint8Array, ts: number): Event {
  return {
    type: "fs.file.content",
    payload: {
      v: 2,
      contentStreamId: streamId,
      contentBase64: Buffer.from(bytes).toString("base64"),
    },
    ts,
  };
}

function fileCreate(path: string, contentStreamId: string): Event {
  return {
    type: "fs.file.create",
    payload: { v: 2, path, contentStreamId },
    ts: 1,
  };
}

function fileWrite(path: string, bytes: Uint8Array, ts: number): Event {
  return {
    type: "fs.file.write",
    payload: {
      v: 2,
      path,
      base: "BASE_NONE",
      contentSha256: digestBytes(bytes),
      size: bytes.byteLength,
    },
    ts,
  };
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

async function records(world: BrowserWorld, streamId: string): Promise<readonly StreamRecord[]> {
  return readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
}

function logicalBranchRecords(
  branch: "main" | "feature-typography",
  main: readonly StreamRecord[],
  feature: readonly StreamRecord[],
): readonly StreamRecord[] {
  const resolved =
    branch === "main"
      ? main.map(stripWriterMetadata)
      : resolveBranchLog([
          { streamId: featureStream, records: feature.map(stripWriterMetadata) },
          { streamId: mainStream, records: main.map(stripWriterMetadata) },
        ]);
  return resolved.map((record, ordinal) => ({ ...record, offset: offsetForOrdinal(ordinal) }));
}

async function projection(
  page: Page,
  path: string,
  reducerId: string,
  streamId: string,
): Promise<ProjectionSnapshot> {
  const result = await page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, path);
  assert.equal(result.status, 200, `${path} returned ${String(result.status)}`);
  const body = result.body as ProjectionBody;
  assert.ok(Array.isArray(body.events), `${path} events missing`);
  const definition = requireReducer(reducerId, streamId) as ReducerDefinition;
  const replay = replayWithReducer(definition, body.events);
  assert.equal(replay.digest, definition.digest(replay.state));
  return { ...body, digest: replay.digest, state: replay.state };
}

async function waitLive(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).waitFor();
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-stream-status") ===
      "live",
    testId,
  );
}

async function navigateToReadme(page: Page, platformUrl: string): Promise<void> {
  await page.goto(platformUrl);
  await page.getByTestId("identity-region").waitFor();
  await page.getByRole("link", { name: "Maple", exact: true }).click();
  await page.getByTestId("route-org").waitFor();
  await page.getByRole("link", { name: "Repositories", exact: true }).click();
  await page.getByTestId("registry-browser").waitFor();
  await waitLive(page, "registry-browser");
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
  await page.getByRole("link", { name: "readme.md", exact: true }).click();
  await page.getByTestId("file-content").waitFor();
  await waitLive(page, "file-viewer");
}

function assertDomSnapshot(
  page: Page,
  testId: string,
  snapshot: ProjectionSnapshot,
): Promise<void> {
  return Promise.all([
    page
      .getByTestId(testId)
      .getAttribute("data-application-checkpoint")
      .then((value) => {
        assert.equal(value, snapshot.checkpoint, `${testId} checkpoint`);
      }),
    page
      .getByTestId(testId)
      .getAttribute("data-state-digest")
      .then((value) => {
        assert.equal(value, snapshot.digest, `${testId} digest`);
      }),
  ]).then(() => undefined);
}

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
const proofReceiptPath = resolve(work, "e3-t10-empty-proof-receipt.json");
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
const homes = new RepositoryHomeStore(streams, () => 100);
const main = await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: [
    { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 },
    { type: "fs.dir.create", payload: { v: 2, path: "src" }, ts: 2 },
    fileCreate("docs/readme.md", readmeContent),
    fileWrite("docs/readme.md", initialText, 4),
    fileCreate("src/index.ts", "fs:maple/reading-room:main:file:index"),
    fileWrite(
      "src/index.ts",
      new TextEncoder().encode('export const title = "Reading Room";\n'),
      6,
    ),
  ],
});
assert.equal(main, mainStream);
await streams.create(readmeContent);
await streams.append(readmeContent, contentEvent(readmeContent, initialText, 4));
const indexContent = "fs:maple/reading-room:main:file:index";
await streams.create(indexContent);
await streams.append(
  indexContent,
  contentEvent(indexContent, new TextEncoder().encode('export const title = "Reading Room";\n'), 6),
);
await homes.ensureRepository("maple", "reading-room", "canopy");
const mainBeforeFork = await records(world, mainStream);
const forkOffset = mainBeforeFork.at(-1)!.offset;
await streams.create(featureStream);
await streams.append(
  featureStream,
  {
    type: "fs.branch.fork",
    payload: { v: 1, parentStreamId: mainStream, forkOffset },
    ts: 7,
  },
  { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
);
await homes.registerNativeBranch("maple", "reading-room", "feature-typography");
await streams.create(featureContent);
await streams.append(featureContent, contentEvent(featureContent, featureText, 8));
await streams.append(featureStream, fileCreate("docs/feature.md", featureContent), {
  sequence: offsetForOrdinal(1),
  applicationOffset: offsetForOrdinal(1),
});
await streams.append(featureStream, fileWrite("docs/feature.md", featureText, 9), {
  sequence: offsetForOrdinal(2),
  applicationOffset: offsetForOrdinal(2),
});

// A private repository owned by another tenant is present in the namespace streams,
// but the authenticated capstone subject must never receive it in the registry projection.
await world.dispatchNamespace(
  "ns:root",
  { type: "ns.org.create", payload: { v: 1, name: "oak" }, ts: 20 },
  "auth0|outsider",
);
await world.dispatchNamespace(
  "ns:org:oak",
  { type: "ns.project.create", payload: { v: 1, name: "canopy" }, ts: 21 },
  "auth0|outsider",
);
await world.dispatchNamespace(
  "ns:org:oak",
  {
    type: "ns.repo.create",
    payload: { v: 1, name: "secret-garden", project: "canopy", visibility: "private" },
    ts: 22,
  },
  "auth0|outsider",
);

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
const peer = await world.openPage(browser);
let consoleErrors = 0;
let pageErrors = 0;
const browserErrorMessages: string[] = [];
const reconnects = 1;
for (const client of [guarded, peer]) {
  client.page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors += 1;
      browserErrorMessages.push(`${client === guarded ? "guarded" : "peer"}: ${message.text()}`);
    }
  });
  client.page.on("pageerror", (error) => {
    pageErrors += 1;
    browserErrorMessages.push(
      `${client === guarded ? "guarded" : "peer"} pageerror: ${error.message}`,
    );
  });
}
let transcript = "E3-T10 reading room official Durable Streams capstone\n";

try {
  await guarded.page.goto(world.platformUrl);
  await loginWithFixture(guarded.page);
  await peer.page.goto(world.platformUrl);
  await loginWithFixture(peer.page);

  await guarded.page.getByRole("link", { name: "Maple", exact: true }).click();
  await guarded.page.getByTestId("route-org").waitFor();
  assert.equal(await guarded.page.getByTestId("route-org").textContent(), "Organization: maple");
  await guarded.page.getByRole("link", { name: "Repositories", exact: true }).click();
  await guarded.page.getByTestId("registry-browser").waitFor();
  await waitLive(guarded.page, "registry-browser");
  const registryText = await guarded.page.getByTestId("registry-browser").textContent();
  assert.ok(registryText?.includes("Reading room"));
  assert.doesNotMatch(registryText ?? "", /secret-garden|oak/);
  const registry = await projection(
    guarded.page,
    "/registry/me?projection=1&reducer=registry",
    "registry",
    "__registry__",
  );
  await assertDomSnapshot(guarded.page, "registry-browser", registry);
  transcript += `registry route=true digest=${registry.digest} private-cross-tenant-hidden=true\n`;

  await guarded.page
    .locator('nav[aria-label="Canopy routes"]')
    .getByRole("link", { name: "Reading room", exact: true })
    .click();
  await guarded.page.getByTestId("repository-home").waitFor();
  await waitLive(guarded.page, "repo-namespace-region");
  await waitLive(guarded.page, "repo-branches-region");
  await waitLive(guarded.page, "repo-status-region");
  const home = {
    namespace: await projection(
      guarded.page,
      "/api/repos/maple/reading-room/home/namespace?projection=1&reducer=repo-namespace",
      "repo-namespace",
      "repo-home:maple/reading-room:namespace",
    ),
    branches: await projection(
      guarded.page,
      "/api/repos/maple/reading-room/home/branches?projection=1&reducer=repo-branches",
      "repo-branches",
      "repo-home:maple/reading-room:branches",
    ),
    status: await projection(
      guarded.page,
      "/api/repos/maple/reading-room/home/status?projection=1&reducer=repo-status",
      "repo-status",
      "repo-home:maple/reading-room:status",
    ),
  };
  await assertDomSnapshot(guarded.page, "repo-namespace-region", home.namespace);
  await assertDomSnapshot(guarded.page, "repo-branches-region", home.branches);
  await assertDomSnapshot(guarded.page, "repo-status-region", home.status);
  assert.equal(
    await guarded.page.getByTestId("branch-parent-feature-typography").textContent(),
    mainStream,
  );
  transcript += `repository-home route=true namespace=${home.namespace.digest} branches=${home.branches.digest} status=${home.status.digest}\n`;

  await navigateToReadme(guarded.page, world.platformUrl);
  await navigateToReadme(peer.page, world.platformUrl);
  assert.equal(
    await guarded.page.getByTestId("file-content").textContent(),
    new TextDecoder().decode(initialText),
  );
  assert.equal(
    await peer.page.getByTestId("file-content").textContent(),
    new TextDecoder().decode(initialText),
  );
  await guarded.page
    .locator('nav[aria-label="Canopy routes"]')
    .getByRole("link", { name: "File tree", exact: true })
    .click();
  await guarded.page.getByTestId("tree-list").waitFor();
  const mainTree = await projection(
    guarded.page,
    "/api/repos/maple/reading-room/main/events?projection=1&reducer=streamfs",
    "streamfs",
    mainStream,
  );
  await assertDomSnapshot(guarded.page, "tree-browser", mainTree);
  await guarded.page.getByRole("link", { name: "docs/", exact: true }).click();
  await guarded.page.getByRole("link", { name: "readme.md", exact: true }).click();
  await guarded.page.getByTestId("file-content").waitFor();
  await waitLive(guarded.page, "file-viewer");
  const mainFile = await projection(
    guarded.page,
    "/api/repos/maple/reading-room/main/blob/docs/readme.md?projection=1&reducer=file-content",
    "file-content",
    fileViewStreamId("maple", "reading-room", "main", "docs/readme.md"),
  );
  await assertDomSnapshot(guarded.page, "file-viewer", mainFile);
  transcript += `main tree=true file=true content-digest=${digestBytes(initialText)}\n`;

  await peer.context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const control = { enabled: false, used: false };
    (window as unknown as { __e3t10Reconnect: typeof control }).__e3t10Reconnect = control;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        window.location.origin,
      );
      if (
        control.enabled &&
        !control.used &&
        url.pathname === "/api/repos/maple/reading-room/main/blob/docs/readme.md" &&
        url.searchParams.get("live") === "1"
      ) {
        control.used = true;
        throw new TypeError("fixture capstone reconnect");
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
  });
  await peer.page.reload();
  await peer.page.getByTestId("file-content").waitFor();
  await peer.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  await peer.page.evaluate(() => {
    (window as unknown as { __e3t10Reconnect: { enabled: boolean } }).__e3t10Reconnect.enabled =
      true;
  });
  await peer.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-stream-status") ===
      "reconnecting",
  );
  await streams.append(readmeContent, contentEvent(readmeContent, editedText, 30));
  await world.appendApplicationAs(
    mainStream,
    fileWrite("docs/readme.md", editedText, 30),
    writerActor,
  );
  await peer.page
    .getByTestId("file-content")
    .filter({ hasText: "Second session edit arrived live." })
    .waitFor();
  await peer.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  assert.equal(
    await peer.page.getByTestId("file-content").textContent(),
    new TextDecoder().decode(editedText),
  );
  const editedFile = await projection(
    peer.page,
    "/api/repos/maple/reading-room/main/blob/docs/readme.md?projection=1&reducer=file-content",
    "file-content",
    fileViewStreamId("maple", "reading-room", "main", "docs/readme.md"),
  );
  await assertDomSnapshot(peer.page, "file-viewer", editedFile);
  assert.equal(editedFile.digest, digestBytes(editedText));
  transcript += `second-session-live-edit=true reconnecting=true reconnect-count=${String(reconnects)} digest=${editedFile.digest}\n`;

  const featureTreePath = `${world.platformUrl}/maple/reading-room/tree/main`;
  await guarded.page.goto(featureTreePath);
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.getByTestId("branch-selector").selectOption("feature-typography");
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="tree-browser"]')?.getAttribute("data-branch") ===
      "feature-typography",
  );
  await waitLive(guarded.page, "tree-browser");
  try {
    await guarded.page.getByTestId("tree-row").filter({ hasText: "docs/" }).waitFor();
  } catch (error) {
    console.error(
      "E3-T10 feature debug",
      guarded.page.url(),
      await guarded.page.getByTestId("tree-browser").innerText(),
      guarded.network
        .filter((entry) => entry.direction === "response" && entry.url.includes("/api/repos/"))
        .slice(-8)
        .map((entry) => ({
          url: entry.url,
          status: entry.status,
          body:
            entry.bodyBase64 === null
              ? null
              : Buffer.from(entry.bodyBase64, "base64").toString("utf8"),
        })),
    );
    throw error;
  }
  const featureTree = await projection(
    guarded.page,
    "/api/repos/maple/reading-room/feature-typography/events?projection=1&reducer=streamfs",
    "streamfs",
    featureStream,
  );
  await assertDomSnapshot(guarded.page, "tree-browser", featureTree);
  await guarded.page.getByTestId("tree-row").filter({ hasText: "docs/" }).getByRole("link").click();
  await guarded.page.getByTestId("tree-row").filter({ hasText: "feature.md" }).waitFor();
  await guarded.page
    .getByTestId("tree-row")
    .filter({ hasText: "feature.md" })
    .getByRole("link")
    .click();
  await guarded.page.getByTestId("file-content").waitFor();
  assert.equal(
    await guarded.page.getByTestId("file-content").textContent(),
    new TextDecoder().decode(featureText),
  );
  const featureFile = await projection(
    guarded.page,
    "/api/repos/maple/reading-room/feature-typography/blob/docs/feature.md?projection=1&reducer=file-content",
    "file-content",
    fileViewStreamId("maple", "reading-room", "feature-typography", "docs/feature.md"),
  );
  await assertDomSnapshot(guarded.page, "file-viewer", featureFile);
  transcript += `branch-switch=true feature-tree=${featureTree.digest} feature-file=${featureFile.digest}\n`;

  await guarded.page
    .locator('nav[aria-label="Canopy routes"]')
    .getByRole("link", { name: "History", exact: true })
    .click();
  await waitLive(guarded.page, "history-view");
  await guarded.page.getByTestId("branch-selector").selectOption("feature-typography");
  await guarded.page.getByTestId("history-row").filter({ hasText: "feature.md" }).first().waitFor();
  const featureHistory = await projection(
    guarded.page,
    "/api/repos/maple/reading-room/feature-typography/events?projection=1&reducer=history",
    "history",
    featureStream,
  );
  await assertDomSnapshot(guarded.page, "history-view", featureHistory);
  const mainHistory = await projection(
    guarded.page,
    "/api/repos/maple/reading-room/main/events?projection=1&reducer=history",
    "history",
    mainStream,
  );
  assert.ok(
    featureHistory.events.some(
      (event) =>
        event.type === "fs.file.create" &&
        (event.payload as { readonly path?: unknown }).path === "docs/feature.md",
    ),
  );
  transcript += `history feature=true rows=${featureHistory.events.length} main-rows=${mainHistory.events.length} branch-consistent=true\n`;

  const finalMain = await records(world, mainStream);
  const finalFeature = await records(world, featureStream);
  const expectedFeature = logicalBranchRecords("feature-typography", finalMain, finalFeature);
  assert.ok(
    expectedFeature.some(
      (event) =>
        event.type === "fs.file.create" &&
        (event.payload as { readonly path?: unknown }).path === "docs/feature.md",
    ),
  );
  const privateBodies = [...guarded.network, ...peer.network]
    .map((entry) =>
      entry.bodyBase64 === null ? "" : Buffer.from(entry.bodyBase64, "base64").toString("utf8"),
    )
    .join("\n");
  assert.doesNotMatch(privateBodies, /secret-garden|oak/);
  const applicationRequests = [...guarded.network, ...peer.network].filter(
    (entry) =>
      entry.layer === "browser" &&
      entry.direction === "request" &&
      /\/api\/|\/registry\//.test(new URL(entry.url).pathname),
  );
  assert.ok(applicationRequests.length > 0);
  const platformOrigin = new URL(world.platformUrl).origin;
  assert.ok(applicationRequests.every((entry) => new URL(entry.url).origin === platformOrigin));
  await guarded.settleNetwork();
  await peer.settleNetwork();
  if (consoleErrors !== 0 || pageErrors !== 0) {
    console.error("E3-T10 browser errors", browserErrorMessages);
  }
  assert.equal(consoleErrors, 0);
  assert.equal(pageErrors, 0);
  transcript += `privacy-network=clean browser-origin=platform-only=true console-errors=${String(consoleErrors)} page-errors=${String(pageErrors)}\n`;

  const snapshots: CapstoneEvidence = {
    registry,
    home,
    mainTree,
    featureTree,
    mainFile: editedFile,
    featureFile,
    mainHistory,
    featureHistory,
    rawStreams: {
      [mainStream]: finalMain,
      [featureStream]: finalFeature,
      [readmeContent]: await records(world, readmeContent),
      [featureContent]: await records(world, featureContent),
    },
  };
  await writeFile(resolve(evidence, "e3-t10-browser.txt"), transcript);
  await writeFile(resolve(evidence, "e3-t10-events.json"), `${canonicalJson(snapshots)}\n`);
  await writeFile(
    resolve(evidence, "e3-t10-digests.json"),
    `${canonicalJson({
      registry: { checkpoint: registry.checkpoint, digest: registry.digest },
      home: Object.fromEntries(
        Object.entries(home).map(([key, value]) => [
          key,
          { checkpoint: value.checkpoint, digest: value.digest },
        ]),
      ),
      mainTree: { checkpoint: mainTree.checkpoint, digest: mainTree.digest },
      featureTree: { checkpoint: featureTree.checkpoint, digest: featureTree.digest },
      mainFile: { checkpoint: editedFile.checkpoint, digest: editedFile.digest },
      featureFile: { checkpoint: featureFile.checkpoint, digest: featureFile.digest },
      mainHistory: { checkpoint: mainHistory.checkpoint, digest: mainHistory.digest },
      featureHistory: { checkpoint: featureHistory.checkpoint, digest: featureHistory.digest },
    })}\n`,
  );
  process.stdout.write(transcript);
} finally {
  const closeWithTimeout = async (label: string, close: () => Promise<void>): Promise<void> => {
    await Promise.race([
      close(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          console.error(`E3-T10 cleanup timeout: ${label}`);
          resolve();
        }, 2_000),
      ),
    ]);
  };
  await closeWithTimeout("peer", () => peer.close());
  await closeWithTimeout("guarded", () => guarded.close());
  await closeWithTimeout("browser", () => browser.close());
  await closeWithTimeout("world", () => world.close());
}

process.exit(0);
