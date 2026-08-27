import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  browserSessionSecretForAttacks,
  bootWorld,
  replayChromiumPath,
  type GuardedPage,
  type WireObservation,
} from "@eforest/browser-verify";
import {
  appendDurableJson,
  createDurableJsonStream,
  headDurableJsonStream,
  readDurableJson,
  type StreamRecord,
} from "@eforest/client";
import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { SESSION_COOKIE, signedSessionCookie } from "@eforest/platform";
import {
  fileContentReducerDefinition,
  fileViewStreamId,
  replayWithReducer,
  streamFsReducerDefinition,
  type FileContentState,
} from "@eforest/reducers";
import {
  BASE_NONE,
  fileContentEvent,
  fileCreateEvent,
  fileWriteEvent,
  treeDigest,
  type FsTree,
} from "@eforest/streamfs";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  DISPOSABLE_CONTENT_STREAM,
  DISPOSABLE_UUID,
  HOME_BASE,
  HOME_CONTENT_STREAM,
  HOME_FULL_TARGET,
  HOME_PATCH_TARGET,
  HOME_REBASED_TARGET,
  HOME_STALE_TARGET,
  HOME_UUID,
  HOSTILE_CONTENT_STREAM,
  HOSTILE_MARKDOWN,
  WIKI_NOW,
  WIKI_ORG,
  WIKI_REPO,
  WIKI_STREAM,
  expectedWikiRecords,
} from "./wiki-fixture.ts";

const root = resolve(import.meta.dirname, "../../..");
const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live");
const evidence = resolve(task, "evidence");
const goldenPath = resolve(evidence, "e5-t08-golden.digest");
const auth0EmulatorModuleUrl = pathToFileURL(
  resolve(root, "packages/browser-verify/test/fixtures/auth0-emulator.mjs"),
).href;
const wikiPath = `/orgs/${WIKI_ORG}/repos/${WIKI_REPO}/wiki`;
const homePath = `${wikiPath}/home`;
const homeEditPath = `${homePath}/edit`;
const guidePath = `${wikiPath}/guide`;
const subject = {
  id: "e5-t08-browser",
  email: "e5-t08-browser@canopy.test",
  password: "E5T08Browser1234!",
  name: "E5 T08 Browser",
};
const encoder = new TextEncoder();

interface BrowserSignals {
  readonly console: Array<{ readonly page: string; readonly type: string; readonly text: string }>;
  readonly pageErrors: Array<{ readonly page: string; readonly message: string }>;
  readonly requestFailures: Array<{
    readonly page: string;
    readonly request: string;
    readonly error: string;
  }>;
}

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

function dispatchResponses(observations: readonly WireObservation[]): readonly WireObservation[] {
  return observations.filter(
    (entry) =>
      entry.layer === "browser" &&
      entry.direction === "response" &&
      new URL(entry.url).pathname === "/api/dispatch",
  );
}

function cleanRecord(record: StreamRecord): StreamRecord {
  const payload = { ...(record.payload as Readonly<Record<string, unknown>>) };
  delete (payload as Record<string, unknown>).actor;
  delete (payload as Record<string, unknown>).writer;
  return { offset: record.offset, type: record.type, payload, ts: record.ts };
}

async function replace(locator: Locator, text: string): Promise<void> {
  await locator.fill(text);
  assert.equal(await locator.inputValue(), text, "controlled input committed the replacement");
}

async function appendAtEnd(locator: Locator, suffix: string, expected: string): Promise<void> {
  await locator.focus();
  await locator.evaluate(
    (element) =>
      new Promise<void>((resolveFrame) => {
        requestAnimationFrame(() => {
          const input = element as HTMLTextAreaElement;
          input.setSelectionRange(input.value.length, input.value.length);
          requestAnimationFrame(() => resolveFrame());
        });
      }),
  );
  await locator.pressSequentially(suffix);
  assert.equal(
    await locator.inputValue(),
    expected,
    "controlled textarea committed keyboard input",
  );
}

async function withinLiveBudget(label: string, action: () => Promise<void>): Promise<number> {
  const started = Date.now();
  try {
    await action();
  } catch (error) {
    throw new Error(`wiki-live-sync:${label}`, { cause: error });
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 2_000, `wiki-live-sync:${label}:${String(elapsed)}ms`);
  return elapsed;
}

async function waitForAttribute(
  page: Page,
  testId: string,
  attribute: string,
  expected: string,
): Promise<void> {
  await page.waitForFunction(
    ({ selector, name, value }) => document.querySelector(selector)?.getAttribute(name) === value,
    { selector: `[data-testid="${testId}"]`, name: attribute, value: expected },
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  milliseconds = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function attachSignals(context: BrowserContext, signals: BrowserSignals): void {
  const attached = new WeakSet<Page>();
  const attach = (page: Page): void => {
    if (attached.has(page)) return;
    attached.add(page);
    const label = `page-${String(context.pages().indexOf(page) + 1)}`;
    page.on("console", (message) =>
      signals.console.push({ page: label, type: message.type(), text: message.text() }),
    );
    page.on("pageerror", (error) =>
      signals.pageErrors.push({ page: label, message: error.message }),
    );
    page.on("requestfailed", (request) =>
      signals.requestFailures.push({
        page: label,
        request: `${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search}`,
        error: request.failure()?.errorText ?? "unknown",
      }),
    );
  };
  context.on("page", attach);
  for (const page of context.pages()) attach(page);
}

async function installDeterminism(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ fixedNow, uuids }) => {
      Date.now = () => fixedNow;
      let uuidIndex = 0;
      Object.defineProperty(Crypto.prototype, "randomUUID", {
        configurable: true,
        value: () => uuids[uuidIndex++] ?? uuids.at(-1)!,
      });
      (globalThis as typeof globalThis & { __wikiPwned?: boolean }).__wikiPwned = false;
    },
    { fixedNow: WIKI_NOW, uuids: [HOME_UUID, DISPOSABLE_UUID] },
  );
}

async function streamRecords(world: {
  readonly streamUrl: string;
}): Promise<readonly StreamRecord[]> {
  return readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(WIKI_STREAM)}`,
  });
}

async function seedFullContent(
  world: { readonly streamUrl: string },
  contentStreamId: string,
  bytes: Uint8Array,
  ts: number,
): Promise<void> {
  const url = `${world.streamUrl}/streams/${encodeURIComponent(contentStreamId)}`;
  await createDurableJsonStream({ url });
  await appendDurableJson({ url }, fileContentEvent(contentStreamId, bytes, ts));
}

async function authenticatedJson(
  guarded: GuardedPage,
  platformUrl: string,
  path: string,
): Promise<unknown> {
  const cookies = await guarded.context.cookies(platformUrl);
  const response = await fetch(`${platformUrl}${path}`, {
    headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") },
  });
  assert.equal(response.status, 200, `authenticated GET ${path}`);
  return response.json();
}

function digestFacts(values: {
  readonly writer: string;
  readonly follower: string;
  readonly server: string;
  readonly replay: string;
  readonly golden: string;
}): void {
  assert.equal(values.writer, values.follower, "wiki-digest-parity:writer-follower");
  assert.equal(values.follower, values.server, "wiki-digest-parity:dom-server");
  assert.equal(values.server, values.replay, "wiki-digest-parity:server-replay");
  assert.equal(values.replay, values.golden, "wiki-digest-parity:replay-golden");
}

function sessionCookieValue(sessionId: string): string {
  const pair = signedSessionCookie(browserSessionSecretForAttacks(), sessionId, 60).split(
    ";",
    1,
  )[0];
  assert.ok(pair?.startsWith(`${SESSION_COOKIE}=`), "signed session cookie");
  return pair.slice(SESSION_COOKIE.length + 1);
}

function unexpectedRequestFailures(signals: BrowserSignals): BrowserSignals["requestFailures"] {
  return signals.requestFailures.filter(
    (entry) =>
      !(
        entry.error === "net::ERR_ABORTED" &&
        entry.request.startsWith("GET /api/repos/maple/reading-room/wiki/")
      ),
  );
}

await mkdir(evidence, { recursive: true });
const golden = (await readFile(goldenPath, "utf8")).trim();
assert.match(golden, /^[a-f0-9]{64}$/, "committed wiki golden digest");

const world = await bootWorld({ root, subject, auth0EmulatorModuleUrl });
await world.seedPublicRepo({ org: WIKI_ORG, project: "canopy", repo: WIKI_REPO, branch: "main" });
const browserSubject = subject.id.startsWith("auth0|") ? subject.id : `auth0|${subject.id}`;
const writerSessionId = "e5-t08-writer-session";
const followerSessionId = "e5-t08-follower-session";
await world.identity.login(browserSubject, subject.email, writerSessionId);
await world.identity.login(browserSubject, subject.email, followerSessionId);
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const writer = await world.openPage(browser);
const follower = await world.openPage(browser);
const installEmptyProofReceipt = async (context: BrowserContext): Promise<void> => {
  await context.route("**/__proof/e3-t02", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
};
await Promise.all([
  writer.context.addCookies([
    { name: SESSION_COOKIE, value: sessionCookieValue(writerSessionId), url: world.platformUrl },
  ]),
  follower.context.addCookies([
    { name: SESSION_COOKIE, value: sessionCookieValue(followerSessionId), url: world.platformUrl },
  ]),
  installEmptyProofReceipt(writer.context),
  installEmptyProofReceipt(follower.context),
]);
const writerSignals: BrowserSignals = { console: [], pageErrors: [], requestFailures: [] };
const followerSignals: BrowserSignals = { console: [], pageErrors: [], requestFailures: [] };
attachSignals(writer.context, writerSignals);
attachSignals(follower.context, followerSignals);
await Promise.all([installDeterminism(writer.context), installDeterminism(follower.context)]);

let followerView: Page | undefined;
let followerEditor: Page | undefined;
let hostileView: Page | undefined;
let releaseWriterTail: (() => void) | undefined;
let pauseWriterTail = false;
let genesisAttempts = 0;

try {
  const writerNetworkStart = writer.network.length;
  const followerNetworkStart = follower.network.length;

  let releaseGenesis: (() => void) | undefined;
  const bothGenesisAttempts = new Promise<void>((resolveBoth) => {
    releaseGenesis = resolveBoth;
  });
  const installGenesisBarrier = async (context: BrowserContext): Promise<void> => {
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/dispatch") {
        const body = JSON.parse(request.postData() ?? "{}") as {
          readonly event?: { readonly type?: string };
        };
        if (body.event?.type === "fs.branch.genesis") {
          genesisAttempts += 1;
          if (genesisAttempts === 2) releaseGenesis?.();
          await withTimeout(bothGenesisAttempts, "concurrent-wiki-genesis");
        }
      }
      await route.fallback();
    });
  };
  await Promise.all([
    installGenesisBarrier(writer.context),
    installGenesisBarrier(follower.context),
  ]);

  await Promise.all([
    writer.page.goto(`${world.platformUrl}${wikiPath}`),
    follower.page.goto(`${world.platformUrl}${wikiPath}`),
  ]);
  await Promise.all([
    writer.page.getByTestId("wiki-index").waitFor(),
    follower.page.getByTestId("wiki-index").waitFor(),
  ]);
  assert.equal(genesisAttempts, 2, "concurrent-first-open attempts");
  assert.equal(
    await writer.page.getByTestId("wiki-empty").textContent(),
    "This wiki has no pages yet.",
  );
  assert.equal(
    await follower.page.getByTestId("wiki-empty").textContent(),
    "This wiki has no pages yet.",
  );
  const genesisRecords = await streamRecords(world);
  assert.deepEqual(
    genesisRecords.map((record) => record.type),
    ["fs.branch.genesis"],
  );

  await replace(writer.page.getByTestId("wiki-new-slug"), "home");
  await writer.page.getByRole("button", { name: "Create page" }).click();
  await writer.page.getByTestId("wiki-editor").waitFor();
  const afterCreate = await streamRecords(world);
  assert.deepEqual(
    afterCreate.map((record) => record.type),
    ["fs.branch.genesis", "fs.file.create"],
  );
  assert.equal(
    (afterCreate[1]!.payload as { readonly contentStreamId: string }).contentStreamId,
    HOME_CONTENT_STREAM,
  );

  await seedFullContent(world, HOME_CONTENT_STREAM, encoder.encode(HOME_BASE), WIKI_NOW + 1);
  const initialWriteOffset = await world.appendApplication(
    WIKI_STREAM,
    fileWriteEvent(encoder.encode(HOME_BASE), "home.md", BASE_NONE, WIKI_NOW + 1),
  );
  assert.equal(initialWriteOffset, offsetForOrdinal(2));
  await writer.page.waitForFunction(
    (expected: string) =>
      (document.querySelector('[data-testid="wiki-source"]') as HTMLTextAreaElement)?.value ===
      expected,
    HOME_BASE,
  );
  await waitForAttribute(writer.page, "wiki-editor", "data-editor-base", offsetForOrdinal(2));
  await follower.page.locator('[data-testid="wiki-page-row"][data-page-path="home.md"]').waitFor();

  const followerViewPage = await follower.context.newPage();
  const followerEditorPage = await follower.context.newPage();
  followerView = followerViewPage;
  followerEditor = followerEditorPage;
  await Promise.all([
    followerViewPage.goto(`${world.platformUrl}${homePath}`),
    followerEditorPage.goto(`${world.platformUrl}${homeEditPath}`),
  ]);
  await Promise.all([
    followerViewPage
      .getByTestId("wiki-markdown")
      .getByText("Line 090: stable wiki proof.")
      .waitFor(),
    followerEditorPage.waitForFunction(
      (expected: string) =>
        (document.querySelector('[data-testid="wiki-source"]') as HTMLTextAreaElement)?.value ===
        expected,
      HOME_BASE,
    ),
  ]);
  await appendAtEnd(
    followerEditorPage.getByTestId("wiki-source"),
    "A stale session B draft.\n",
    HOME_STALE_TARGET,
  );
  assert.equal(await followerEditorPage.getByTestId("wiki-source").inputValue(), HOME_STALE_TARGET);

  let followerViewNavigations = 0;
  let followerIndexNavigations = 0;
  followerViewPage.on("framenavigated", () => (followerViewNavigations += 1));
  follower.page.on("framenavigated", () => (followerIndexNavigations += 1));

  let markWriterTailBlocked: (() => void) | undefined;
  const writerTailBlocked = new Promise<void>((resolveBlocked) => {
    markWriterTailBlocked = resolveBlocked;
  });
  const writerTailReleased = new Promise<void>((resolveReleased) => {
    releaseWriterTail = resolveReleased;
  });
  await writer.context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      pauseWriterTail &&
      url.pathname === `/api/repos/${WIKI_ORG}/${WIKI_REPO}/wiki/events` &&
      url.searchParams.get("live") === "1"
    ) {
      markWriterTailBlocked?.();
      await writerTailReleased;
    }
    await route.fallback();
  });
  pauseWriterTail = true;
  await withTimeout(writerTailBlocked, "writer-tail-block");

  const writerEditor = writer.page.getByTestId("wiki-editor");
  const preSaveOffset = await writerEditor.getAttribute("data-ef-offset");
  const preSaveDigest = await writerEditor.getAttribute("data-tree-digest");
  const preSaveRevision = await writerEditor.getAttribute("data-page-revision");
  assert.equal(preSaveRevision, offsetForOrdinal(2));
  await appendAtEnd(
    writer.page.getByTestId("wiki-source"),
    "A live patch reached session B.\n",
    HOME_PATCH_TARGET,
  );
  assert.equal(await writer.page.getByTestId("wiki-source").inputValue(), HOME_PATCH_TARGET);

  const livePatchLatency = await withinLiveBudget("home-patch", async () => {
    await writer.page.getByRole("button", { name: "Save changes" }).click();
    await followerViewPage.getByText("A live patch reached session B.").waitFor();
  });
  await waitForAttribute(writer.page, "wiki-editor", "data-dispatches-confirmed", "1");
  const confirmedOffset = await writerEditor.getAttribute("data-ef-confirmed-offset");
  assert.equal(confirmedOffset, offsetForOrdinal(3));
  assert.equal(await writerEditor.getAttribute("data-saving-offset"), confirmedOffset);
  assert.equal(
    await writerEditor.getAttribute("data-ef-offset"),
    preSaveOffset,
    "no-optimistic-offset",
  );
  assert.equal(
    await writerEditor.getAttribute("data-tree-digest"),
    preSaveDigest,
    "no-optimistic-digest",
  );
  assert.equal(
    await writerEditor.getAttribute("data-page-revision"),
    preSaveRevision,
    "no-optimistic-revision",
  );
  assert.equal(await writerEditor.getAttribute("data-dispatches-reconciled"), "0");

  pauseWriterTail = false;
  releaseWriterTail?.();
  await waitForAttribute(writer.page, "wiki-editor", "data-saving-offset", "");
  await waitForAttribute(writer.page, "wiki-editor", "data-page-revision", offsetForOrdinal(3));
  await waitForAttribute(writer.page, "wiki-editor", "data-dispatches-reconciled", "1");
  assert.equal(followerViewNavigations, 0, "live page updated without navigation");
  assert.equal(followerIndexNavigations, 0, "live index updated without navigation");

  const beforeFenceRecords = await streamRecords(world);
  const beforeFenceBytes = canonicalJson(beforeFenceRecords);
  const beforeFenceReplay = replayWithReducer(
    streamFsReducerDefinition,
    beforeFenceRecords,
    WIKI_STREAM,
  );
  const beforeFenceOffset = beforeFenceRecords.at(-1)!.offset;
  const beforeFenceDigest = beforeFenceReplay.digest;
  const staleEditorOffset = await followerEditorPage
    .getByTestId("wiki-editor")
    .getAttribute("data-ef-offset");
  const staleEditorDigest = await followerEditorPage
    .getByTestId("wiki-editor")
    .getAttribute("data-tree-digest");
  assert.equal(staleEditorOffset, beforeFenceOffset);
  assert.equal(staleEditorDigest, beforeFenceDigest);

  await followerEditorPage.getByRole("button", { name: "Save changes" }).click();
  const staleRefusal = followerEditorPage.getByTestId("wiki-stale-refusal");
  await staleRefusal.waitFor();
  assert.match((await staleRefusal.textContent()) ?? "", /changed while you were editing/i);
  assert.equal(await followerEditorPage.getByTestId("wiki-source").inputValue(), HOME_STALE_TARGET);
  assert.equal(
    await followerEditorPage.getByTestId("wiki-editor").getAttribute("data-dispatches-refused"),
    "1",
  );
  assert.equal(
    await followerEditorPage.getByTestId("wiki-editor").getAttribute("data-dispatches-confirmed"),
    "0",
  );
  assert.equal(
    await followerEditorPage.getByTestId("wiki-editor").getAttribute("data-tree-digest"),
    beforeFenceDigest,
  );
  assert.equal(
    canonicalJson(await streamRecords(world)),
    beforeFenceBytes,
    "stale fence log bytes",
  );
  assert.equal(await followerViewPage.getByText("A live patch reached session B.").count(), 1);
  const stalePatchPosts = (): number =>
    dispatchRequests(follower.network.slice(followerNetworkStart)).filter(
      (entry) =>
        (JSON.parse(decodedBody(entry)) as { readonly event: { readonly type: string } }).event
          .type === "fs.file.patch",
    ).length;
  assert.equal(stalePatchPosts(), 1, "one pointer-triggered stale save request");
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const afterFenceRecords = await streamRecords(world);
  assert.equal(canonicalJson(afterFenceRecords), beforeFenceBytes, "no stale auto-retry");
  assert.equal(stalePatchPosts(), 1, "stale refusal has no automatic retry");
  await followerEditorPage.getByRole("button", { name: "Load latest" }).click();
  assert.equal(
    await followerEditorPage.getByTestId("wiki-source").inputValue(),
    HOME_PATCH_TARGET,
  );
  await staleRefusal.waitFor({ state: "detached" });

  await appendAtEnd(
    followerEditorPage.getByTestId("wiki-source"),
    "A reviewed patch landed from session B.\n",
    HOME_REBASED_TARGET,
  );
  await withinLiveBudget("home-rebased-patch", async () => {
    await followerEditorPage.getByRole("button", { name: "Save changes" }).click();
    await followerViewPage.getByText("A reviewed patch landed from session B.").waitFor();
  });
  await waitForAttribute(
    followerEditorPage,
    "wiki-editor",
    "data-page-revision",
    offsetForOrdinal(4),
  );
  await waitForAttribute(followerEditorPage, "wiki-editor", "data-saving-offset", "");
  await writer.page.waitForFunction(
    (expected: string) =>
      (document.querySelector('[data-testid="wiki-source"]') as HTMLTextAreaElement)?.value ===
      expected,
    HOME_REBASED_TARGET,
  );

  await replace(writer.page.getByTestId("wiki-source"), HOME_FULL_TARGET);
  const fullWriteLatency = await withinLiveBudget("home-full-write", async () => {
    await writer.page.getByRole("button", { name: "Save changes" }).click();
    await followerViewPage
      .getByText("Canonical full-write bytes came through the browser dispatch door.")
      .waitFor();
  });
  await waitForAttribute(writer.page, "wiki-editor", "data-page-revision", offsetForOrdinal(5));
  await followerEditorPage.waitForFunction(
    (expected: string) =>
      (document.querySelector('[data-testid="wiki-source"]') as HTMLTextAreaElement)?.value ===
      expected,
    HOME_FULL_TARGET,
  );
  assert.equal(await writer.page.getByTestId("wiki-source").inputValue(), HOME_FULL_TARGET);
  assert.equal(
    await followerEditorPage.getByTestId("wiki-source").inputValue(),
    HOME_FULL_TARGET,
    "follower replayed exact full-write bytes",
  );

  await writer.page
    .getByRole("navigation", { name: "Wiki editor breadcrumb" })
    .getByRole("link", { name: "home" })
    .click();
  await writer.page.getByTestId("wiki-page").waitFor();
  await replace(writer.page.getByTestId("wiki-rename-slug"), "guide");
  const renameLatency = await withinLiveBudget("home-rename", async () => {
    await writer.page.getByRole("button", { name: "Rename" }).click();
    await followerViewPage.getByTestId("wiki-page-missing").waitFor();
    await follower.page
      .locator('[data-testid="wiki-page-row"][data-page-path="guide.md"]')
      .waitFor();
  });
  await writer.page.waitForURL(`${world.platformUrl}${guidePath}`);
  await followerEditorPage.getByTestId("wiki-editor-missing").waitFor();
  assert.equal(followerViewPage.url(), `${world.platformUrl}${homePath}`, "old route stayed missing");
  assert.equal(
    await follower.page.locator('[data-testid="wiki-page-row"][data-page-path="home.md"]').count(),
    0,
    "old route disappeared from live index",
  );
  const liveNavigationCounts = {
    followerView: followerViewNavigations,
    followerIndex: followerIndexNavigations,
  };
  assert.deepEqual(liveNavigationCounts, { followerView: 0, followerIndex: 0 });
  await follower.page
    .locator('[data-testid="wiki-page-row"][data-page-path="guide.md"]')
    .getByRole("link", { name: "guide" })
    .click();
  await follower.page.getByTestId("wiki-page").waitFor();
  await Promise.all([
    writer.page
      .getByText("Canonical full-write bytes came through the browser dispatch door.")
      .waitFor(),
    follower.page
      .getByText("Canonical full-write bytes came through the browser dispatch door.")
      .waitFor(),
  ]);
  await writer.page
    .getByRole("navigation", { name: "Wiki breadcrumb" })
    .getByRole("link", { name: "Wiki" })
    .click();
  await follower.page
    .getByRole("navigation", { name: "Wiki breadcrumb" })
    .getByRole("link", { name: "Wiki" })
    .click();
  await writer.page.getByTestId("wiki-index").waitFor();
  await follower.page.getByTestId("wiki-index").waitFor();
  await replace(writer.page.getByTestId("wiki-new-slug"), "disposable");
  const createLatency = await withinLiveBudget("disposable-create", async () => {
    await writer.page.getByRole("button", { name: "Create page" }).click();
    await follower.page
      .locator('[data-testid="wiki-page-row"][data-page-path="disposable.md"]')
      .waitFor();
  });
  await writer.page.getByTestId("wiki-editor").waitFor();
  await writer.page
    .getByRole("navigation", { name: "Wiki editor breadcrumb" })
    .getByRole("link", { name: "disposable" })
    .click();
  await writer.page.getByTestId("wiki-page").waitFor();
  const deleteLatency = await withinLiveBudget("disposable-delete", async () => {
    await writer.page.getByTestId("wiki-delete").click();
    await follower.page
      .locator('[data-testid="wiki-page-row"][data-page-path="disposable.md"]')
      .waitFor({ state: "detached" });
  });
  await writer.page.getByTestId("wiki-index").waitFor();

  const hostileCreateOffset = await world.appendApplication(
    WIKI_STREAM,
    fileCreateEvent("hostile.md", HOSTILE_CONTENT_STREAM, WIKI_NOW + 2),
  );
  assert.equal(hostileCreateOffset, offsetForOrdinal(9));
  await seedFullContent(
    world,
    HOSTILE_CONTENT_STREAM,
    encoder.encode(HOSTILE_MARKDOWN),
    WIKI_NOW + 3,
  );
  const hostileWriteOffset = await world.appendApplication(
    WIKI_STREAM,
    fileWriteEvent(encoder.encode(HOSTILE_MARKDOWN), "hostile.md", BASE_NONE, WIKI_NOW + 3),
  );
  assert.equal(hostileWriteOffset, offsetForOrdinal(10));
  await follower.page
    .locator('[data-testid="wiki-page-row"][data-page-path="hostile.md"]')
    .waitFor();
  const hostileViewPage = await follower.context.newPage();
  hostileView = hostileViewPage;
  await hostileViewPage.goto(`${world.platformUrl}${wikiPath}/hostile`);
  const markdown = hostileViewPage.getByTestId("wiki-markdown");
  await markdown.getByText("Safe text survives.").waitFor();
  assert.equal(
    await hostileViewPage.evaluate(
      () => (globalThis as typeof globalThis & { __wikiPwned?: boolean }).__wikiPwned,
    ),
    false,
  );
  assert.equal(await markdown.locator("script,iframe,object,embed,svg,math,style").count(), 0);
  assert.equal(await markdown.locator("[onload],[onerror],[onclick],[srcdoc]").count(), 0);
  const renderedUrls = await markdown
    .locator("a[href],img[src]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute(element.tagName === "A" ? "href" : "src")),
    );
  assert.equal(
    renderedUrls.some((value) => /^(?:javascript|data|vbscript):/i.test(value ?? "")),
    false,
  );

  const homeContentRecords = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(HOME_CONTENT_STREAM)}`,
  });
  assert.equal(homeContentRecords.length, 2, "full-write staged one new content generation");
  const browserContentGeneration = { ...homeContentRecords[1] } as Record<string, unknown>;
  delete browserContentGeneration.offset;
  assert.deepEqual(
    browserContentGeneration,
    fileContentEvent(HOME_CONTENT_STREAM, encoder.encode(HOME_FULL_TARGET), WIKI_NOW),
    "browser full-write persisted exact canonical bytes before metadata",
  );
  const guideStreamId = fileViewStreamId(WIKI_ORG, WIKI_REPO, "wiki", "guide.md");
  const guideProjection = (await authenticatedJson(
    follower,
    world.platformUrl,
    `/api/repos/${WIKI_ORG}/${WIKI_REPO}/wiki/blob/guide.md?projection=1&reducer=file-content`,
  )) as { readonly events: readonly StreamRecord[] };
  const guideReplay = replayWithReducer(
    fileContentReducerDefinition,
    guideProjection.events,
    guideStreamId,
  ).state as FileContentState;
  assert.equal(guideReplay.text, HOME_FULL_TARGET, "renamed route replays exact full-write bytes");

  const fileStreamId = fileViewStreamId(WIKI_ORG, WIKI_REPO, "wiki", "hostile.md");
  const fileProjection = (await authenticatedJson(
    follower,
    world.platformUrl,
    `/api/repos/${WIKI_ORG}/${WIKI_REPO}/wiki/blob/hostile.md?projection=1&reducer=file-content`,
  )) as { readonly events: readonly StreamRecord[] };
  const fileReplay = replayWithReducer(
    fileContentReducerDefinition,
    fileProjection.events,
    fileStreamId,
  ).state as FileContentState;
  assert.equal(fileReplay.text, HOSTILE_MARKDOWN, "hostile bytes remain verbatim in replay");

  await Promise.all([
    writer.page.locator('[data-testid="wiki-page-row"][data-page-path="hostile.md"]').waitFor(),
    follower.page.locator('[data-testid="wiki-page-row"][data-page-path="guide.md"]').waitFor(),
  ]);
  const finalRecords = await streamRecords(world);
  const expectedRecords = expectedWikiRecords();
  assert.deepEqual(
    finalRecords.map(cleanRecord),
    expectedRecords,
    "deterministic accepted wiki log",
  );
  assert.deepEqual(
    finalRecords.map((record) => record.type),
    [
      "fs.branch.genesis",
      "fs.file.create",
      "fs.file.write",
      "fs.file.patch",
      "fs.file.patch",
      "fs.file.write",
      "fs.rename",
      "fs.file.create",
      "fs.file.delete",
      "fs.file.create",
      "fs.file.write",
    ],
  );

  const serverProjection = (await authenticatedJson(
    follower,
    world.platformUrl,
    `/api/repos/${WIKI_ORG}/${WIKI_REPO}/wiki/events?projection=1&reducer=streamfs`,
  )) as { readonly events: readonly StreamRecord[]; readonly checkpoint: string };
  const serverReplay = replayWithReducer(
    streamFsReducerDefinition,
    serverProjection.events,
    WIKI_STREAM,
  );
  const replay = replayWithReducer(streamFsReducerDefinition, finalRecords, WIKI_STREAM);
  const tree = replay.state as FsTree;
  assert.equal(treeDigest(tree), replay.digest);
  assert.ok(Object.hasOwn(tree.tombstones, "disposable.md"), "delete leaves a tombstone");
  assert.equal(Object.hasOwn(tree.files, "disposable.md"), false);
  const transportHead = await headDurableJsonStream({
    url: `${world.streamUrl}/streams/${encodeURIComponent(WIKI_STREAM)}`,
  });
  const serverCheckpoint = serverProjection.checkpoint;
  assert.equal(serverCheckpoint, finalRecords.at(-1)!.offset);
  assert.ok(transportHead.offset !== null, "durable transport reports a head offset");

  const writerIndex = writer.page.getByTestId("wiki-index");
  const followerIndex = follower.page.getByTestId("wiki-index");
  await waitForAttribute(writer.page, "wiki-index", "data-ef-offset", serverCheckpoint);
  await waitForAttribute(follower.page, "wiki-index", "data-ef-offset", serverCheckpoint);
  const writerDigest = (await writerIndex.getAttribute("data-tree-digest"))!;
  const followerDigest = (await followerIndex.getAttribute("data-tree-digest"))!;
  digestFacts({
    writer: writerDigest,
    follower: followerDigest,
    server: serverReplay.digest,
    replay: replay.digest,
    golden,
  });
  const expectedPagePaths = Object.keys(tree.files)
    .filter((path) => path.endsWith(".md") && !path.includes("/"))
    .sort();
  const domPagePaths = (
    await followerIndex
      .getByTestId("wiki-page-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-page-path")!))
  ).sort();
  assert.deepEqual(domPagePaths, expectedPagePaths, "index literal-equals replayed markdown files");

  const mutatedRecords = structuredClone(finalRecords) as StreamRecord[];
  const mutatedPayload = mutatedRecords[3]!.payload as Record<string, unknown>;
  const originalResultDigest = String(mutatedPayload.resultDigest);
  mutatedPayload.resultDigest = `${originalResultDigest[0] === "0" ? "1" : "0"}${originalResultDigest.slice(1)}`;
  const mutatedReplay = replayWithReducer(streamFsReducerDefinition, mutatedRecords, WIKI_STREAM);
  assert.notEqual(mutatedReplay.digest, replay.digest, "one-byte mutation changes replay digest");
  assert.throws(
    () =>
      digestFacts({
        writer: writerDigest,
        follower: followerDigest,
        server: serverReplay.digest,
        replay: mutatedReplay.digest,
        golden,
      }),
    /wiki-digest-parity:server-replay/,
    "wiki-causal-sensitivity:digest-parity",
  );

  const fullRecords = expectedRecords.map((record) => ({ ...record }));
  fullRecords[3] = {
    offset: offsetForOrdinal(3),
    ...fileWriteEvent(
      encoder.encode(HOME_PATCH_TARGET),
      "home.md",
      offsetForOrdinal(2),
      WIKI_NOW,
    ),
  };
  const fullReplay = replayWithReducer(streamFsReducerDefinition, fullRecords, WIKI_STREAM);
  assert.equal(fullReplay.digest, replay.digest, "patch/full metadata tree parity");
  const patchPayload = expectedRecords[3]!.payload;
  const fullPayload = fullRecords[3]!.payload;
  const patchWireBytes = Buffer.byteLength(canonicalJson(patchPayload));
  const fullWireBytes =
    Buffer.byteLength(canonicalJson(fullPayload)) + encoder.encode(HOME_PATCH_TARGET).byteLength;
  assert.ok(patchWireBytes < fullWireBytes, "canonical chooser patch wins on wire bytes");

  await Promise.all([writer.settleNetwork(), follower.settleNetwork()]);
  const browserNetwork = [
    ...writer.network.slice(writerNetworkStart),
    ...follower.network.slice(followerNetworkStart),
  ];
  const writes = dispatchRequests(browserNetwork);
  const writeBodies = writes.map(
    (entry) =>
      JSON.parse(decodedBody(entry)) as {
        readonly streamId: string;
        readonly event: {
          readonly type: string;
          readonly payload: Readonly<Record<string, unknown>>;
        };
        readonly contentEvent?: {
          readonly type: string;
          readonly payload: Readonly<Record<string, unknown>>;
          readonly ts: number;
        };
      },
  );
  assert.equal(writes.length, 10, "dispatch-only-browser-write-count");
  const browserWriteTypes = writeBodies.map((body) => body.event.type).sort();
  assert.deepEqual(browserWriteTypes, [
    "fs.branch.genesis",
    "fs.branch.genesis",
    "fs.file.create",
    "fs.file.create",
    "fs.file.delete",
    "fs.file.patch",
    "fs.file.patch",
    "fs.file.patch",
    "fs.file.write",
    "fs.rename",
  ]);
  assert.equal(
    writeBodies.every((body) => body.streamId === WIKI_STREAM),
    true,
  );
  const otherWrites = browserNetwork.filter(
    (entry) =>
      entry.layer === "browser" &&
      entry.direction === "request" &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method ?? "") &&
      new URL(entry.url).pathname !== "/api/dispatch",
  );
  assert.deepEqual(otherWrites, [], "dispatch-only-write-audit");
  const responseReasons = dispatchResponses(browserNetwork)
    .map((entry) => {
      const body = JSON.parse(decodedBody(entry)) as {
        readonly error?: { readonly reason?: string };
      };
      return body.error?.reason ?? "accepted";
    })
    .sort();
  assert.deepEqual(responseReasons, [
    "accepted",
    "accepted",
    "accepted",
    "accepted",
    "accepted",
    "accepted",
    "accepted",
    "accepted",
    "fs/branch-exists",
    "stale-base",
  ]);
  const followerPatchRequests = dispatchRequests(
    follower.network.slice(followerNetworkStart),
  ).filter(
    (entry) =>
      (JSON.parse(decodedBody(entry)) as { readonly event: { readonly type: string } }).event
        .type === "fs.file.patch",
  );
  assert.equal(followerPatchRequests.length, 2, "one stale attempt plus one human rebased save");
  const fullWriteRequests = writeBodies.filter((body) => body.event.type === "fs.file.write");
  assert.equal(fullWriteRequests.length, 1, "forced browser full-write dispatch count");
  assert.deepEqual(
    fullWriteRequests[0]!.contentEvent,
    fileContentEvent(HOME_CONTENT_STREAM, encoder.encode(HOME_FULL_TARGET), WIKI_NOW),
    "full-write request carries exact canonical content generation",
  );
  const renameRequests = writeBodies.filter((body) => body.event.type === "fs.rename");
  assert.equal(renameRequests.length, 1, "pointer rename dispatch count");
  assert.deepEqual(renameRequests[0]!.event.payload, {
    v: 2,
    from: "home.md",
    to: "guide.md",
  });

  assert.equal(writerSignals.console.filter((entry) => entry.type === "error").length, 0);
  assert.equal(followerSignals.console.filter((entry) => entry.type === "error").length, 0);
  assert.deepEqual(writerSignals.pageErrors, []);
  assert.deepEqual(followerSignals.pageErrors, []);
  assert.deepEqual(unexpectedRequestFailures(writerSignals), []);
  assert.deepEqual(unexpectedRequestFailures(followerSignals), []);

  await Promise.all([
    writeFile(
      resolve(evidence, "e5-t08-session.events.jsonl"),
      `${finalRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
    ),
    writeFile(
      resolve(evidence, "e5-t08-digests.txt"),
      [
        "E5-T08 DOM/server/replay/golden parity",
        `stream=${WIKI_STREAM}`,
        `projection-head-offset=${serverCheckpoint}`,
        `transport-head-offset=${String(transportHead.offset)}`,
        `writer-dom-digest=${writerDigest}`,
        `follower-dom-digest=${followerDigest}`,
        `server-projection-digest=${serverReplay.digest}`,
        `independent-replay-digest=${replay.digest}`,
        `committed-golden-digest=${golden}`,
        `page-paths=${expectedPagePaths.join(",")}`,
        "E5_T08_DIGEST_PARITY_OK",
        "",
      ].join("\n"),
    ),
    writeFile(
      resolve(evidence, "e5-t08-fence.txt"),
      [
        "E5-T08 stale-base fence",
        "refusal-class=validator-rejected",
        "refusal-reason=stale-base",
        `head-before=${beforeFenceOffset}`,
        `head-after=${afterFenceRecords.at(-1)!.offset}`,
        `digest-before=${beforeFenceDigest}`,
        `digest-after=${beforeFenceDigest}`,
        "log-bytes-before-after-equal=true",
        "draft-remained-unapplied=true",
        "automatic-retry-count=0",
        "E5_T08_FENCE_OK",
        "",
      ].join("\n"),
    ),
    writeFile(
      resolve(evidence, "e5-t08-write-audit.txt"),
      [
        "E5-T08 browser write audit",
        "browser-dispatch-posts=10 accepted=8 refused=2 other-state-writes=0",
        `browser-event-types=${browserWriteTypes.join(",")}`,
        "refusals=fs/branch-exists,stale-base",
        "accepted-log-events=11 browser-accepted=8 foreign-tool-accepted=3",
        "accepted-browser-edits=3 patch=2 full-write=1",
        "full-write-http-posts=1 content-event-in-same-request=true",
        "pointer-renames=1 rename-event=fs.rename old-route=missing new-route=guide",
        `accepted-event-types=${finalRecords.map((record) => record.type).join(",")}`,
        "E5_T08_WRITE_AUDIT_OK",
        "",
      ].join("\n"),
    ),
    writeFile(
      resolve(evidence, "e5-t08-patch-parity.txt"),
      [
        "E5-T08 patch/full-write parity",
        `patch-digest=${replay.digest}`,
        `full-write-digest=${fullReplay.digest}`,
        `patch-wire-bytes=${String(patchWireBytes)}`,
        `full-write-wire-bytes=${String(fullWireBytes)}`,
        "patch-wire-strictly-smaller=true",
        "browser-save-events=fs.file.patch,fs.file.patch,fs.file.write",
        "browser-full-write-content-generation=canonical-exact-bytes",
        "E5_T08_PATCH_PARITY_OK",
        "",
      ].join("\n"),
    ),
    writeFile(
      resolve(evidence, "e5-t08-browser-fallback.json"),
      `${JSON.stringify(
        {
          v: 1,
          candidateHead,
          replay: {
            status: "N/A",
            reason: "tools/replay/preflight.sh failed: unknown command mcp",
            mitigation:
              "focused production-runtime Playwright fallback with console and network interrogation",
          },
          sessions: 2,
          liveBudgetMs: 2_000,
          liveWithinBudget: livePatchLatency <= 2_000,
          fullWriteWithinBudget: fullWriteLatency <= 2_000,
          renameWithinBudget: renameLatency <= 2_000,
          createWithinBudget: createLatency <= 2_000,
          deleteWithinBudget: deleteLatency <= 2_000,
          navigationCounts: liveNavigationCounts,
          console: {
            writerErrors: 0,
            followerErrors: 0,
            pageErrors: 0,
            writerLog: writerSignals.console,
            followerLog: followerSignals.console,
            pageErrorLog: [...writerSignals.pageErrors, ...followerSignals.pageErrors],
            expectedCanceledWikiReads:
              writerSignals.requestFailures.length + followerSignals.requestFailures.length,
            requestFailureLog: [
              ...writerSignals.requestFailures,
              ...followerSignals.requestFailures,
            ],
            unexpectedRequestFailures: 0,
          },
          network: {
            dispatchPosts: writeBodies
              .map((body) => ({
                streamId: body.streamId,
                type: body.event.type,
                contentEvent: body.contentEvent?.type ?? null,
              }))
              .sort((left, right) => left.type.localeCompare(right.type)),
            responseReasons,
            requestCount: writes.length,
            responseCount: dispatchResponses(browserNetwork).length,
            responseLifecycle: dispatchResponses(browserNetwork).map((entry) => ({
              status: entry.status,
              reason: (() => {
                const body = JSON.parse(decodedBody(entry)) as {
                  readonly error?: { readonly reason?: string };
                };
                return body.error?.reason ?? "accepted";
              })(),
            })),
            otherStateWrites: 0,
          },
          fullWrite: {
            metadataOffset: offsetForOrdinal(5),
            contentStreamId: HOME_CONTENT_STREAM,
            canonicalContentEvents: homeContentRecords.length,
            exactBytes: guideReplay.text === HOME_FULL_TARGET,
            writerSourceExact: true,
            followerSourceExact: true,
          },
          rename: {
            metadataOffset: offsetForOrdinal(6),
            type: "fs.rename",
            oldPath: "home.md",
            oldRouteMissing: true,
            newPath: "guide.md",
            writerFollowerConverged: true,
          },
          assertions: {
            concurrentFirstOpenSingleGenesis: true,
            livePatch: true,
            threeAcceptedEdits: true,
            canonicalFullWrite: true,
            pointerRename: true,
            oldRouteMissing: true,
            staleRefusal: true,
            noOptimisticApply: true,
            dispatchOnly: true,
            hostileMarkdownInert: true,
            hostileBytesVerbatim: true,
            deleteTombstone: true,
            domServerReplayGoldenParity: true,
            causalSensitivity: true,
          },
        },
        null,
        2,
      )}\n`,
    ),
  ]);

  process.stdout.write(
    `E5_T08_BROWSER_FALLBACK_OK sessions=2 dispatches=10 accepted=8 refused=2 edits=3 rename=fs.rename head=${serverCheckpoint} digest=${replay.digest}\n`,
  );
} catch (error) {
  await Promise.allSettled([writer.settleNetwork(), follower.settleNetwork()]);
  const pageState = async (page: Page): Promise<unknown> =>
    page.isClosed()
      ? { closed: true }
      : {
          url: page.url(),
          text: (await page.locator("body").innerText()).slice(0, 2_000),
          testIds: await page
            .locator("[data-testid]")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid"))),
        };
  const wikiResponses = [...writer.network, ...follower.network]
    .filter(
      (entry) =>
        entry.direction === "response" &&
        new URL(entry.url).pathname.includes(`/${WIKI_ORG}/${WIKI_REPO}/wiki`),
    )
    .slice(-12)
    .map((entry) => ({
      path: `${new URL(entry.url).pathname}${new URL(entry.url).search}`,
      status: entry.status,
      body: decodedBody(entry).slice(0, 1_000),
    }));
  const errorResponses = [...writer.network, ...follower.network]
    .filter(
      (entry) =>
        entry.direction === "response" && entry.status !== undefined && entry.status >= 400,
    )
    .map((entry) => ({
      path: `${new URL(entry.url).pathname}${new URL(entry.url).search}`,
      status: entry.status,
    }));
  process.stderr.write(
    `E5_T08_BROWSER_DIAGNOSTIC ${JSON.stringify({
      genesisAttempts,
      pages: await Promise.all(
        [...writer.context.pages(), ...follower.context.pages()].map(pageState),
      ),
      signals: { writer: writerSignals, follower: followerSignals },
      errorResponses,
      wikiResponses,
    })}\n`,
  );
  throw error;
} finally {
  pauseWriterTail = false;
  releaseWriterTail?.();
  await Promise.allSettled([followerView?.close(), followerEditor?.close(), hostileView?.close()]);
  await Promise.allSettled([writer.close(), follower.close()]);
  await browser.close();
  await world.close();
}
process.exit(0);
