import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bootWorld,
  replayChromiumPath,
  type BrowserSubject,
  type WireObservation,
} from "@eforest/browser-verify";
import {
  appendDurableJson,
  createDurableJsonStream,
  readDurableJson,
  type StreamRecord,
} from "@eforest/client";
import { canonicalJson, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  FS_EVENT_VERSION,
  branchContentStreamPrefix,
  diffText,
  digestBytes,
  fileContentEvent,
} from "@eforest/streamfs";
import { chromium, type Locator, type Page, type Response } from "playwright-core";

export const LIVENESS_BOUND_MS = 5_000;

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T13-issue-to-merge");
const evidence = resolve(task, "evidence");
const sessionDirectory = resolve(evidence, "e5-t13-session");
const cli = resolve(root, "packages/cli/dist/src/bin.js");
const org = "maple";
const repo = "reading-room";
const project = "canopy";
const issueId = "causal-merge";
const prId = "causal-merge";
const feature = "feature-causal-merge";
const wikiSlug = "causal-capstone";
const fixPath = "capstone-fix.txt";
const targetAdvancePath = "integration-target";
const fixText = "E5-T13 merged through the real StreamFS branch.\n";
const wikiText =
  "# Causal capstone\n\nCausal capstone complete through the live wiki dispatch path.\n";
const attachmentBytes = Buffer.from(
  '{"task":"E5-T13","claim":"real causal browser negotiation"}\n',
  "utf8",
);
const replayReference = "https://app.replay.io/recording/e5-t13-causal-browser-capstone";

const streams = Object.freeze({
  issue: `issue:${org}/${repo}/${issueId}`,
  pr: `pr:${org}/${repo}/${prId}`,
  branch: `fs:${org}/${repo}:${feature}:meta`,
  main: `fs:${org}/${repo}:main:meta`,
  wiki: `fs:${org}/${repo}:wiki:meta`,
  evidence: `evidence:${org}/${repo}/pr/${prId}`,
});

const actorSubject: BrowserSubject = {
  id: "e5-t13-actor",
  email: "e5-t13-actor@canopy.test",
  password: "unused-real-session-actor",
  name: "E5 T13 Actor",
};
const witnessSubject: BrowserSubject = {
  id: "e5-t13-witness",
  email: "e5-t13-witness@canopy.test",
  password: "unused-real-session-witness",
  name: "E5 T13 Witness",
};

type SessionRole = "issue" | "pr" | "branch" | "wiki" | "attachment";

interface SurfaceCapture {
  readonly name: string;
  readonly stream: string;
  readonly offset: string;
  readonly digest: string;
}

interface TimelineEntry {
  readonly n: number;
  readonly name: string;
  readonly actorOffsets: readonly string[];
  readonly witnessedWithinMs: number;
  readonly surfaces: readonly SurfaceCapture[];
}

interface ActionReceipt {
  readonly offset: string;
  readonly relatedOffsets?: readonly string[];
}

interface NavigationWatch {
  readonly label: string;
  readonly page: Page;
  navigations(): number;
  documentRequests(): number;
}

interface DomStream extends SurfaceCapture {
  readonly role: SessionRole;
  readonly reducer: string;
  readonly head: string;
}

function normalizedSubject(subject: BrowserSubject): string {
  return subject.id.startsWith("auth0|") ? subject.id : `auth0|${subject.id}`;
}

async function replace(locator: Locator, value: string): Promise<void> {
  await locator.click();
  await locator.press("ControlOrMeta+A");
  await locator.pressSequentially(value);
}

function requestEventType(response: Response): string | undefined {
  const request = response.request();
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/dispatch") {
    return undefined;
  }
  try {
    const body = JSON.parse(request.postData() ?? "null") as {
      readonly event?: { readonly type?: unknown };
    } | null;
    return typeof body?.event?.type === "string" ? body.event.type : undefined;
  } catch {
    return undefined;
  }
}

async function uiDispatch(
  page: Page,
  eventType: string,
  trigger: () => Promise<void>,
): Promise<ActionReceipt> {
  const responsePromise = page.waitForResponse(
    (response) => requestEventType(response) === eventType,
    { timeout: LIVENESS_BOUND_MS },
  );
  await trigger();
  const response = await responsePromise;
  const body = (await response.json()) as { readonly offset?: unknown; readonly error?: unknown };
  assert.equal(response.status(), 202, `${eventType} dispatch status: ${canonicalJson(body)}`);
  assert.equal(typeof body.offset, "string", `${eventType} dispatch omitted offset`);
  return { offset: body.offset as string };
}

async function directDispatch(page: Page, streamId: string, event: Event): Promise<ActionReceipt> {
  const result = await page.evaluate(
    async ({ targetStream, action }) => {
      const response = await fetch("/api/dispatch", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-eforest-dispatch-receipt": "offset",
        },
        body: JSON.stringify({ streamId: targetStream, event: action }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    { targetStream: streamId, action: event },
  );
  assert.equal(result.status, 202, `dispatch ${event.type}: ${canonicalJson(result.body)}`);
  assert.ok(result.body !== null && typeof result.body === "object");
  const body = result.body as { readonly offset?: unknown; readonly forkOffset?: unknown };
  const offset = body.offset ?? (event.type === "fs.branch.fork" ? body.forkOffset : undefined);
  assert.equal(typeof offset, "string", `dispatch ${event.type} omitted its receipt offset`);
  return { offset: offset as string };
}

async function registerBranch(page: Page, branch: string): Promise<void> {
  const result = await page.evaluate(
    async ({ branchName, orgName, repoName }) => {
      const response = await fetch(
        `/api/repos/${encodeURIComponent(orgName)}/${encodeURIComponent(repoName)}/home/branches`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: branchName }),
        },
      );
      return { status: response.status, body: await response.text() };
    },
    { branchName: branch, orgName: org, repoName: repo },
  );
  assert.equal(result.status, 202, `branch registration failed: ${result.body}`);
}

function watchNoDocumentNavigation(page: Page, label: string): NavigationWatch {
  let navigations = 0;
  let documents = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents += 1;
  });
  return {
    label,
    page,
    navigations: () => navigations,
    documentRequests: () => documents,
  };
}

async function captureSurface(
  name: string,
  locator: Locator,
  attributes: {
    readonly stream?: string;
    readonly offset?: string;
    readonly digest?: string;
  } = {},
): Promise<SurfaceCapture> {
  const stream = attributes.stream ?? (await locator.getAttribute("data-ef-stream")) ?? "";
  const offset = await locator.getAttribute(attributes.offset ?? "data-ef-offset");
  const digest = await locator.getAttribute(attributes.digest ?? "data-ef-digest");
  assert.notEqual(stream, "", `${name} omitted stream`);
  assert.ok(offset !== null && offset !== "" && offset !== "-1", `${name} omitted live offset`);
  assert.match(digest ?? "", /^[a-f0-9]{64}$/, `${name} omitted canonical digest`);
  return { name, stream, offset: offset!, digest: digest! };
}

const timeline: TimelineEntry[] = [];

async function witnessedStep(
  name: string,
  act: () => Promise<ActionReceipt>,
  observe: () => Promise<readonly SurfaceCapture[]>,
): Promise<ActionReceipt> {
  const receipt = await act();
  const started = Date.now();
  let surfaces: readonly SurfaceCapture[];
  try {
    surfaces = await observe();
  } catch (error) {
    throw new Error(`witness-live-sync:${name}`, { cause: error });
  }
  const witnessedWithinMs = Date.now() - started;
  assert.ok(
    witnessedWithinMs <= LIVENESS_BOUND_MS,
    `${name} exceeded ${String(LIVENESS_BOUND_MS)}ms: ${String(witnessedWithinMs)}ms`,
  );
  timeline.push({
    n: timeline.length + 1,
    name,
    actorOffsets: [...(receipt.relatedOffsets ?? []), receipt.offset],
    witnessedWithinMs,
    surfaces,
  });
  return receipt;
}

async function waitLive(locator: Locator): Promise<void> {
  await locator.waitFor({ timeout: LIVENESS_BOUND_MS });
  await waitForAttribute(locator, "data-stream-status", "live");
}

async function waitForAttribute(locator: Locator, name: string, value: string): Promise<void> {
  const deadline = Date.now() + LIVENESS_BOUND_MS;
  while (Date.now() <= deadline) {
    if ((await locator.getAttribute(name)) === value) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(await locator.getAttribute(name), value, `${name} did not become ${value}`);
}

async function whoami(page: Page): Promise<{ readonly sub: string; readonly email: string }> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/whoami", { credentials: "same-origin" });
    return { status: response.status, body: (await response.json()) as unknown };
  });
  assert.equal(result.status, 200);
  const user = (result.body as { readonly user?: unknown }).user;
  assert.ok(user !== null && typeof user === "object");
  const candidate = user as { readonly sub?: unknown; readonly email?: unknown };
  assert.equal(typeof candidate.sub, "string");
  assert.equal(typeof candidate.email, "string");
  return { sub: candidate.sub as string, email: candidate.email as string };
}

function decodedBody(observation: WireObservation): string {
  return observation.bodyBase64 === null
    ? ""
    : Buffer.from(observation.bodyBase64, "base64").toString("utf8");
}

function dispatchInventory(observations: readonly WireObservation[]) {
  return observations.flatMap((entry) => {
    if (
      entry.layer !== "browser" ||
      entry.direction !== "request" ||
      entry.method !== "POST" ||
      new URL(entry.url).pathname !== "/api/dispatch"
    ) {
      return [];
    }
    const body = JSON.parse(decodedBody(entry)) as {
      readonly streamId: string;
      readonly event: { readonly type: string; readonly payload: unknown };
    };
    return [{ streamId: body.streamId, type: body.event.type, payload: body.event.payload }];
  });
}

function branchRegistrationInventory(observations: readonly WireObservation[]) {
  return observations.flatMap((entry) => {
    if (
      entry.layer !== "browser" ||
      entry.direction !== "request" ||
      entry.method !== "POST" ||
      !new URL(entry.url).pathname.endsWith("/home/branches")
    ) {
      return [];
    }
    return [JSON.parse(decodedBody(entry)) as { readonly name: string }];
  });
}

function parseReplayOutput(output: string) {
  const replayStreams = [
    ...output.matchAll(/^SESSION stream=(\S+) role=(\S+) head=(\S+) digest=([a-f0-9]{64}) OK$/gm),
  ].map((match) => ({
    stream: match[1]!,
    role: match[2]!,
    head: match[3]!,
    digest: match[4]!,
  }));
  const resolved = Number(/^LINKS resolved=(\d+) unresolved=0 OK$/m.exec(output)?.[1]);
  const composite = /^COMPOSITE digest=([a-f0-9]{64})$/m.exec(output)?.[1];
  assert.equal(replayStreams.length, 7, `expected seven replay streams:\n${output}`);
  assert.equal(resolved, 4, `expected four resolved causal links:\n${output}`);
  assert.match(composite ?? "", /^[a-f0-9]{64}$/);
  return { replayStreams, resolved, composite: composite! };
}

async function copySessionAliases(contentStream: string): Promise<void> {
  const aliases = [
    [streams.issue, "e5-t13-issue-log.jsonl"],
    [streams.pr, "e5-t13-pr-log.jsonl"],
    [streams.branch, "e5-t13-branch-log.jsonl"],
    [streams.main, "e5-t13-main-log.jsonl"],
    [streams.wiki, "e5-t13-wiki-log.jsonl"],
    [streams.evidence, "e5-t13-evidence-stream.jsonl"],
    [contentStream, "e5-t13-content-stream.jsonl"],
  ] as const;
  for (const [stream, alias] of aliases) {
    const source = resolve(sessionDirectory, `${encodeURIComponent(stream)}.events.jsonl`);
    const target = resolve(evidence, alias);
    await copyFile(source, target);
    const bytes = await readFile(target);
    await writeFile(
      `${target}.sha256`,
      `${createHash("sha256").update(bytes).digest("hex")}  ${alias}\n`,
    );
  }
}

await mkdir(evidence, { recursive: true });
await rm(sessionDirectory, { recursive: true, force: true });

const world = await bootWorld({
  root,
  sessionTtlSeconds: 600,
  // Authorization has its own Epic 4 capstone. This browser oracle keeps two
  // real signed sessions while isolating the Epic 5 causal flow from the
  // namespace replay worker so concurrent live projections cannot turn a UI
  // liveness assertion into an unrelated authz-runtime failure.
  gatewayDecideAuthorization: (input) => ({
    allowed: true,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write",
    streamId: input.target.kind === "repo" ? input.target.streamId : "test",
  }),
  gatewayNamespaceViewReader: {
    viewFor: async (orgName) =>
      orgName === org
        ? {
            orgs: {
              [org]: {
                owner: normalizedSubject(actorSubject),
                projects: { [project]: { owner: normalizedSubject(actorSubject) } },
                repos: {
                  [repo]: {
                    owner: normalizedSubject(actorSubject),
                    project,
                    visibility: "public",
                  },
                },
              },
            },
          }
        : { orgs: {} },
  },
});
await world.seedPublicRepo({
  org,
  project,
  repo,
  branch: "main",
  events: [{ type: "fs.branch.genesis", payload: { v: 1, branch: "main" }, ts: 1 }],
});
await world.identity.ensureUser(normalizedSubject(actorSubject), actorSubject.email);
await world.identity.ensureUser(normalizedSubject(witnessSubject), witnessSubject.email);
await world.identity.createOrg(org, org, normalizedSubject(actorSubject));
await world.identity.grantMembership(org, normalizedSubject(witnessSubject), "admin");

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const actor = await world.openAuthenticatedPage(browser, actorSubject);
const witness = await world.openAuthenticatedPage(browser, witnessSubject);
const watched: NavigationWatch[] = [];
const httpFailures: string[] = [];
for (const guarded of [actor, witness]) {
  guarded.context.on("response", (response) => {
    if (response.status() >= 400) {
      httpFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
}

const issueBoardPath = `/orgs/${org}/repos/${repo}/issues`;
const issuePath = `${issueBoardPath}/${issueId}`;
const prListPath = `/orgs/${org}/repos/${repo}/pulls`;
const prPath = `${prListPath}/${prId}`;
const wikiPath = `/orgs/${org}/repos/${repo}/wiki/${wikiSlug}`;
let actorIssue: Page | undefined;
let witnessIssue: Page | undefined;
let witnessHome: Page | undefined;
let witnessFeature: Page | undefined;
let witnessMain: Page | undefined;
let witnessPrList: Page | undefined;
let actorPr: Page | undefined;
let witnessPr: Page | undefined;
let actorWiki: Page | undefined;
let witnessWiki: Page | undefined;

try {
  await Promise.all([
    actor.page.goto(`${world.platformUrl}${issueBoardPath}`),
    witness.page.goto(`${world.platformUrl}${issueBoardPath}`),
  ]);
  await Promise.all([
    waitLive(actor.page.getByTestId("issue-board")),
    waitLive(witness.page.getByTestId("issue-board")),
  ]);
  const [actorIdentity, witnessIdentity] = await Promise.all([
    whoami(actor.page),
    whoami(witness.page),
  ]);
  assert.deepEqual(actorIdentity, {
    sub: normalizedSubject(actorSubject),
    email: actorSubject.email,
  });
  assert.deepEqual(witnessIdentity, {
    sub: normalizedSubject(witnessSubject),
    email: witnessSubject.email,
  });
  assert.notEqual(actorIdentity.sub, witnessIdentity.sub);
  assert.notEqual(actor.context, witness.context);
  watched.push(watchNoDocumentNavigation(witness.page, "issue-board"));

  await replace(actor.page.getByTestId("issue-create-id"), issueId);
  await replace(actor.page.getByTestId("issue-create-title"), "Causal merge capstone");
  await replace(
    actor.page.getByTestId("issue-create-body"),
    "Close this exactly once from the real PR merge outcome.",
  );
  const opened = await witnessedStep(
    "issue-filed",
    () =>
      uiDispatch(actor.page, "issue.opened", () =>
        actor.page.getByTestId("issue-create-submit").click(),
      ),
    async () => {
      await witness.page
        .locator(`[data-testid="issue-card"][data-issue-id="${issueId}"]`)
        .waitFor({ timeout: LIVENESS_BOUND_MS });
      return [await captureSurface("issue-board", witness.page.getByTestId("issue-board"))];
    },
  );
  assert.ok(opened.offset);

  actorIssue = await actor.context.newPage();
  witnessIssue = await witness.context.newPage();
  await Promise.all([
    actorIssue.goto(`${world.platformUrl}${issuePath}`),
    witnessIssue.goto(`${world.platformUrl}${issuePath}`),
  ]);
  await Promise.all([
    waitLive(actorIssue.getByTestId("issue-detail")),
    waitLive(witnessIssue.getByTestId("issue-detail")),
  ]);
  watched.push(watchNoDocumentNavigation(witnessIssue, "issue-detail"));

  await actorIssue.getByTestId("issue-transition-to").selectOption("in-progress");
  await witnessedStep(
    "issue-in-progress",
    () =>
      uiDispatch(actorIssue!, "issue.state-changed", () =>
        actorIssue!.getByTestId("issue-transition-submit").click(),
      ),
    async () => {
      await Promise.all([
        witnessIssue!
          .getByTestId("issue-state")
          .getByText("in-progress", { exact: true })
          .waitFor({ timeout: LIVENESS_BOUND_MS }),
        witness.page
          .locator(
            `[data-testid="issue-column-in-progress"] [data-testid="issue-card"][data-issue-id="${issueId}"]`,
          )
          .waitFor({ timeout: LIVENESS_BOUND_MS }),
      ]);
      return [
        await captureSurface("issue-detail", witnessIssue!.getByTestId("issue-detail")),
        await captureSurface("issue-board", witness.page.getByTestId("issue-board")),
      ];
    },
  );

  witnessHome = await witness.context.newPage();
  await witnessHome.goto(`${world.platformUrl}/${org}/${repo}`);
  await waitLive(witnessHome.getByTestId("repo-branches-region"));
  watched.push(watchNoDocumentNavigation(witnessHome, "branch-catalog"));
  const mainRecords = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streams.main)}`,
  });
  const mainHead = mainRecords.at(-1)?.offset;
  if (typeof mainHead !== "string") throw new Error("main stream has no fork checkpoint");

  await witnessedStep(
    "branch-forked",
    async () => {
      const receipt = await directDispatch(actor.page, streams.branch, {
        type: "fs.branch.fork",
        payload: { v: 1, parentStreamId: streams.main, forkOffset: mainHead },
        ts: Date.now(),
      });
      await registerBranch(actor.page, feature);
      return receipt;
    },
    async () => {
      const row = witnessHome!.locator(`[data-testid="branch-row"][data-branch="${feature}"]`);
      await row.waitFor({ timeout: LIVENESS_BOUND_MS });
      assert.equal(
        await witnessHome!.getByTestId(`branch-parent-${feature}`).textContent(),
        streams.main,
      );
      assert.equal(
        await witnessHome!.getByTestId(`branch-fork-${feature}`).textContent(),
        mainHead,
      );
      return [
        await captureSurface("branch-catalog", witnessHome!.getByTestId("repo-branches-region"), {
          stream: `repo-home:${org}/${repo}:branches`,
          offset: "data-application-checkpoint",
          digest: "data-state-digest",
        }),
      ];
    },
  );

  witnessFeature = await witness.context.newPage();
  await witnessFeature.goto(`${world.platformUrl}/${org}/${repo}/tree/${feature}`);
  await waitLive(witnessFeature.getByTestId("tree-browser"));
  watched.push(watchNoDocumentNavigation(witnessFeature, "feature-tree"));
  witnessMain = await witness.context.newPage();
  await witnessMain.goto(`${world.platformUrl}/${org}/${repo}/tree/main`);
  await waitLive(witnessMain.getByTestId("tree-browser"));
  watched.push(watchNoDocumentNavigation(witnessMain, "main-tree"));
  const featureContent = `${branchContentStreamPrefix(`${org}/${repo}`, feature)}capstone-fix`;
  const emptyBytes = new Uint8Array();
  const emptyDigest = digestBytes(emptyBytes);
  const targetDigest = digestBytes(new TextEncoder().encode(fixText));
  const featureBeforeFix = await witnessFeature
    .getByTestId("tree-browser")
    .getAttribute("data-application-checkpoint");
  const mainBeforeAdvance = await witnessMain
    .getByTestId("tree-browser")
    .getAttribute("data-application-checkpoint");
  await witnessedStep(
    "fix-landed",
    async () => {
      const targetAdvanced = await directDispatch(actor.page, streams.main, {
        type: "fs.dir.create",
        payload: { v: FS_EVENT_VERSION, path: targetAdvancePath },
        ts: Date.now(),
      });
      const created = await directDispatch(actor.page, streams.branch, {
        type: "fs.file.create",
        payload: { v: FS_EVENT_VERSION, path: fixPath, contentStreamId: featureContent },
        ts: Date.now(),
      });
      const featureContentUrl = `${world.streamUrl}/streams/${encodeURIComponent(featureContent)}`;
      await createDurableJsonStream({ url: featureContentUrl });
      const initialContent = fileContentEvent(featureContent, emptyBytes, Date.now());
      await appendDurableJson(
        { url: featureContentUrl },
        { ...initialContent, offset: offsetForOrdinal(0) },
      );
      const initialized = await directDispatch(actor.page, streams.branch, {
        type: "fs.file.write",
        payload: {
          v: FS_EVENT_VERSION,
          path: fixPath,
          base: "BASE_NONE",
          contentSha256: emptyDigest,
          size: 0,
        },
        ts: Date.now(),
      });
      const patched = await directDispatch(actor.page, streams.branch, {
        type: "fs.file.patch",
        payload: {
          v: FS_EVENT_VERSION,
          path: fixPath,
          base: initialized.offset,
          baseDigest: emptyDigest,
          ops: diffText("", fixText),
          resultDigest: targetDigest,
        },
        ts: Date.now(),
      });
      return {
        offset: patched.offset,
        relatedOffsets: [targetAdvanced.offset, created.offset, initialized.offset],
      };
    },
    async () => {
      await Promise.all([
        witnessFeature!.waitForFunction(
          (before) =>
            document
              .querySelector('[data-testid="tree-browser"]')
              ?.getAttribute("data-application-checkpoint") !== before,
          featureBeforeFix,
          { timeout: LIVENESS_BOUND_MS },
        ),
        witnessMain!.waitForFunction(
          (before) =>
            document
              .querySelector('[data-testid="tree-browser"]')
              ?.getAttribute("data-application-checkpoint") !== before,
          mainBeforeAdvance,
          { timeout: LIVENESS_BOUND_MS },
        ),
      ]);
      await Promise.all([
        witnessFeature!.getByTestId("pierre-tree").waitFor(),
        witnessMain!.getByTestId("pierre-tree").waitFor(),
      ]);
      return [
        await captureSurface("feature-tree", witnessFeature!.getByTestId("tree-browser"), {
          offset: "data-application-checkpoint",
          digest: "data-state-digest",
        }),
        await captureSurface("main-tree-advanced", witnessMain!.getByTestId("tree-browser"), {
          offset: "data-application-checkpoint",
          digest: "data-state-digest",
        }),
      ];
    },
  );

  witnessPrList = await witness.context.newPage();
  await witnessPrList.goto(`${world.platformUrl}${prListPath}`);
  await waitLive(witnessPrList.getByTestId("pr-list"));
  watched.push(watchNoDocumentNavigation(witnessPrList, "pr-list"));
  await witnessedStep(
    "pr-opened",
    () =>
      directDispatch(actor.page, streams.pr, {
        type: "pr.opened",
        payload: {
          v: 1,
          sourceBranch: streams.branch,
          targetBranch: streams.main,
          forkOffset: mainHead,
          title: "Merge the causal capstone fix",
          body: "Real branch, review, evidence, merge, and close propagation.",
          author: actorSubject.email,
          closes: [{ entity: "issue", stream: streams.issue }],
        },
        ts: Date.now(),
      }),
    async () => {
      await Promise.all([
        witnessPrList!
          .locator(`[data-testid="pr-row"][data-pr-id="${prId}"]`)
          .waitFor({ timeout: LIVENESS_BOUND_MS }),
        witnessIssue!
          .getByTestId("issue-pr-backlinks")
          .getByText(`Pull request #${prId}`, { exact: true })
          .waitFor({ timeout: LIVENESS_BOUND_MS }),
      ]);
      return [
        await captureSurface("pr-list", witnessPrList!.getByTestId("pr-list")),
        await captureSurface("issue-detail", witnessIssue!.getByTestId("issue-detail")),
      ];
    },
  );

  actorPr = await actor.context.newPage();
  witnessPr = await witness.context.newPage();
  await Promise.all([
    actorPr.goto(`${world.platformUrl}${prPath}`),
    witnessPr.goto(`${world.platformUrl}${prPath}`),
  ]);
  await Promise.all([
    waitLive(actorPr.getByTestId("pr-detail")),
    waitLive(witnessPr.getByTestId("pr-detail")),
    waitLive(actorPr.getByTestId("evidence-region")),
    waitLive(witnessPr.getByTestId("evidence-region")),
  ]);
  watched.push(watchNoDocumentNavigation(witnessPr, "pr-detail-and-evidence"));

  const reviewBody = "Reviewed in the real authenticated actor context.";
  await replace(actorPr.getByLabel("Pull request comment"), reviewBody);
  await witnessedStep(
    "review-commented",
    () =>
      uiDispatch(actorPr!, "pr.review-comment", () =>
        actorPr!.locator(".pr-comment-form").getByRole("button", { name: "Comment" }).click(),
      ),
    async () => {
      await witnessPr!.getByText(reviewBody, { exact: true }).waitFor({
        timeout: LIVENESS_BOUND_MS,
      });
      return [await captureSurface("pr-detail", witnessPr!.getByTestId("pr-detail"))];
    },
  );

  await witnessedStep(
    "pr-approved",
    () =>
      uiDispatch(witnessPr!, "pr.approved", () =>
        witnessPr!
          .locator(".pr-merge-panel")
          .getByRole("button", { name: "Approve", exact: true })
          .click(),
      ),
    async () => {
      await actorPr!
        .getByText(`approved these changes as ${witnessSubject.email}`, { exact: true })
        .waitFor({
          timeout: LIVENESS_BOUND_MS,
        });
      await actorPr!.locator(".pr-merge-panel-approved").waitFor({ timeout: LIVENESS_BOUND_MS });
      return [await captureSurface("pr-detail", actorPr!.getByTestId("pr-detail"))];
    },
  );

  await witnessPr.getByTestId("attachment-file").setInputFiles({
    name: "e5-t13-session-log.jsonl",
    mimeType: "application/x-ndjson",
    buffer: attachmentBytes,
  });
  await witnessPr.getByTestId("attachment-kind").selectOption("event-log");
  await replace(witnessPr.getByTestId("attachment-replay-url"), replayReference);
  await replace(witnessPr.getByTestId("attachment-replay-title"), "E5-T13 causal browser run");
  const attachmentReceipt = await witnessedStep(
    "evidence-attached",
    async () => {
      const attached = await uiDispatch(witnessPr!, "evidence.attached", () =>
        witnessPr!.getByTestId("attachment-upload-submit").click(),
      );
      const linked = await uiDispatch(witnessPr!, "evidence.linked", () =>
        witnessPr!.getByTestId("attachment-replay-submit").click(),
      );
      return { offset: linked.offset, relatedOffsets: [attached.offset] };
    },
    async () => {
      const contentRow = actorPr!
        .getByTestId("attachment-row")
        .filter({ has: actorPr!.getByText("e5-t13-session-log.jsonl", { exact: true }) });
      await contentRow.waitFor({ timeout: LIVENESS_BOUND_MS });
      await waitForAttribute(contentRow, "data-ef-hash-verified", "true");
      await actorPr!
        .getByTestId("attachment-link")
        .filter({ hasText: replayReference })
        .waitFor({ timeout: LIVENESS_BOUND_MS });
      return [
        await captureSurface("pr-evidence", actorPr!.getByTestId("evidence-region")),
        await captureSurface("evidence-content", contentRow, {
          stream: (await contentRow.getAttribute("data-content-stream")) ?? "",
          offset: "data-content-offset",
          digest: "data-content-digest",
        }),
        await captureSurface("pr-evidence-linked", actorPr!.getByTestId("evidence-region")),
      ];
    },
  );
  assert.ok(attachmentReceipt.offset);

  const mainBeforeMerge = await witnessMain
    .getByTestId("tree-browser")
    .getAttribute("data-application-checkpoint");
  const merged = await witnessedStep(
    "pr-merged",
    () =>
      uiDispatch(actorPr!, "pr.merge", () =>
        actorPr!
          .locator(".pr-merge-panel")
          .getByRole("button", { name: "Merge", exact: true })
          .click(),
      ),
    async () => {
      await Promise.all([
        witnessPr!.locator(".pr-merge-panel-merged").waitFor({ timeout: LIVENESS_BOUND_MS }),
        witnessPr!.getByText("pr.link-closed", { exact: true }).waitFor({
          timeout: LIVENESS_BOUND_MS,
        }),
        witnessIssue!
          .getByTestId("issue-state")
          .getByText("done", { exact: true })
          .waitFor({ timeout: LIVENESS_BOUND_MS }),
        witness.page
          .locator(
            `[data-testid="issue-column-done"] [data-testid="issue-card"][data-issue-id="${issueId}"]`,
          )
          .waitFor({ timeout: LIVENESS_BOUND_MS }),
        witnessMain!.waitForFunction(
          (before) =>
            document
              .querySelector('[data-testid="tree-browser"]')
              ?.getAttribute("data-application-checkpoint") !== before,
          mainBeforeMerge,
          { timeout: LIVENESS_BOUND_MS },
        ),
      ]);
      return [
        await captureSurface("pr-detail", witnessPr!.getByTestId("pr-detail")),
        await captureSurface("issue-detail", witnessIssue!.getByTestId("issue-detail")),
        await captureSurface("issue-board", witness.page.getByTestId("issue-board")),
        await captureSurface("main-tree", witnessMain!.getByTestId("tree-browser"), {
          offset: "data-application-checkpoint",
          digest: "data-state-digest",
        }),
      ];
    },
  );

  const wikiGenesis = await directDispatch(actor.page, streams.wiki, {
    type: "fs.branch.genesis",
    payload: { v: 1, branch: "wiki" },
    ts: Date.now(),
  });
  actorWiki = await actor.context.newPage();
  await actorWiki.goto(`${world.platformUrl}/orgs/${org}/repos/${repo}/wiki`);
  await waitLive(actorWiki.getByTestId("wiki-index"));
  await replace(actorWiki.getByTestId("wiki-new-slug"), wikiSlug);
  const wikiCreated = await uiDispatch(actorWiki, "fs.file.create", () =>
    actorWiki!.getByRole("button", { name: "Create page", exact: true }).click(),
  );
  await actorWiki.getByTestId("wiki-editor").waitFor({ timeout: LIVENESS_BOUND_MS });
  await actorWiki.getByTestId("wiki-source").waitFor({ timeout: LIVENESS_BOUND_MS });

  witnessWiki = await witness.context.newPage();
  await witnessWiki.goto(`${world.platformUrl}${wikiPath}`);
  await waitLive(witnessWiki.getByTestId("wiki-page"));
  watched.push(watchNoDocumentNavigation(witnessWiki, "wiki-page"));
  await replace(actorWiki.getByTestId("wiki-source"), wikiText);
  await witnessedStep(
    "wiki-edited",
    async () => {
      const receipt = await uiDispatch(actorWiki!, "fs.file.patch", () =>
        actorWiki!.getByRole("button", { name: "Save patch", exact: true }).click(),
      );
      return {
        offset: receipt.offset,
        relatedOffsets: [wikiGenesis.offset, wikiCreated.offset],
      };
    },
    async () => {
      await witnessWiki!
        .getByText("Causal capstone complete through the live wiki dispatch path.", {
          exact: true,
        })
        .waitFor({ timeout: LIVENESS_BOUND_MS });
      return [
        await captureSurface("wiki-page", witnessWiki!.getByTestId("wiki-page"), {
          digest: "data-state-digest",
        }),
      ];
    },
  );

  const contentRow = witnessPr
    .getByTestId("attachment-row")
    .filter({ has: witnessPr.getByText("e5-t13-session-log.jsonl", { exact: true }) });
  const attachmentHash = (await contentRow.getByTestId("attachment-sha256").textContent())?.trim();
  const contentStream = await contentRow.getAttribute("data-content-stream");
  assert.equal(
    attachmentHash,
    createHash("sha256").update(attachmentBytes).digest("hex"),
    "rendered attachment hash",
  );
  assert.ok(contentStream?.startsWith(`evidence-content:${org}/${repo}/`));

  const domStreams: DomStream[] = [
    {
      ...(await captureSurface("issue", witnessIssue.getByTestId("issue-detail"))),
      role: "issue",
      reducer: "issue",
      head: (await witnessIssue.getByTestId("issue-detail").getAttribute("data-ef-offset"))!,
    },
    {
      ...(await captureSurface("pr", witnessPr.getByTestId("pr-detail"))),
      role: "pr",
      reducer: "pr",
      head: (await witnessPr.getByTestId("pr-detail").getAttribute("data-ef-offset"))!,
    },
    {
      ...(await captureSurface("branch", witnessFeature.getByTestId("tree-browser"), {
        offset: "data-application-checkpoint",
        digest: "data-state-digest",
      })),
      role: "branch",
      reducer: "streamfs",
      head: (await witnessFeature
        .getByTestId("tree-browser")
        .getAttribute("data-application-checkpoint"))!,
    },
    {
      ...(await captureSurface("main", witnessMain.getByTestId("tree-browser"), {
        offset: "data-application-checkpoint",
        digest: "data-state-digest",
      })),
      role: "branch",
      reducer: "streamfs",
      head: (await witnessMain
        .getByTestId("tree-browser")
        .getAttribute("data-application-checkpoint"))!,
    },
    {
      ...(await captureSurface("wiki", witnessWiki.getByTestId("wiki-page"), {
        digest: "data-state-digest",
      })),
      role: "wiki",
      reducer: "streamfs",
      head: (await witnessWiki.getByTestId("wiki-page").getAttribute("data-ef-offset"))!,
    },
    {
      ...(await captureSurface("evidence", witnessPr.getByTestId("evidence-region"))),
      role: "attachment",
      reducer: "evidence",
      head: (await witnessPr.getByTestId("evidence-region").getAttribute("data-ef-offset"))!,
    },
    {
      ...(await captureSurface("content", contentRow, {
        stream: contentStream!,
        offset: "data-content-offset",
        digest: "data-content-digest",
      })),
      role: "attachment",
      reducer: "evidence-content",
      head: (await contentRow.getAttribute("data-content-offset"))!,
    },
  ];
  assert.deepEqual(new Set(domStreams.map(({ stream }) => stream)).size, 7);

  await Promise.all([actor.settleNetwork(), witness.settleNetwork()]);
  const actorDispatches = dispatchInventory(actor.network);
  const witnessDispatches = dispatchInventory(witness.network);
  const actorBranchRegistrations = branchRegistrationInventory(actor.network);
  const witnessBranchRegistrations = branchRegistrationInventory(witness.network);
  assert.deepEqual(
    witnessDispatches.map(({ type }) => type),
    ["pr.approved", "content.chunk", "content.sealed", "evidence.attached", "evidence.linked"],
    "reviewer context must own only approval and evidence writes",
  );
  assert.deepEqual(actorBranchRegistrations, [{ name: feature }]);
  assert.deepEqual(witnessBranchRegistrations, []);
  assert.equal(
    actorDispatches.filter(({ type }) => type === "pr.merge").length,
    1,
    "one real pr.merge command request",
  );
  assert.equal(
    actorDispatches.filter(
      ({ streamId, type, payload }) =>
        streamId === streams.issue &&
        type === "issue.state-changed" &&
        (payload as { readonly to?: unknown }).to === "done",
    ).length,
    0,
    "actor must never dispatch the merge-driven issue close",
  );
  for (const watch of watched) {
    assert.equal(watch.navigations(), 0, `${watch.label} navigated after becoming a witness`);
    assert.equal(
      watch.documentRequests(),
      0,
      `${watch.label} issued a document request after becoming a witness`,
    );
  }
  assert.deepEqual(httpFailures, [], httpFailures.join("\n"));
  for (const guarded of [actor, witness]) {
    for (const entry of guarded.network) {
      if (entry.direction === "response") {
        assert.equal(entry.bodyError, undefined, `${entry.url}: ${entry.bodyError ?? ""}`);
      }
    }
    guarded.assertClean();
  }

  await Promise.all([
    actorPr.screenshot({ path: resolve(evidence, "e5-t13-actor-final.png"), fullPage: true }),
    witnessPr.screenshot({
      path: resolve(evidence, "e5-t13-witness-pr-final.png"),
      fullPage: true,
    }),
    witnessWiki.screenshot({
      path: resolve(evidence, "e5-t13-witness-wiki-final.png"),
      fullPage: true,
    }),
  ]);

  const captureOutput = execFileSync(
    process.execPath,
    [
      cli,
      "replay",
      "--session-dump",
      "--server",
      world.streamUrl,
      "--root",
      streams.pr,
      "--out",
      sessionDirectory,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 },
  );
  const replay = parseReplayOutput(captureOutput);
  const manifest = JSON.parse(
    await readFile(resolve(sessionDirectory, "session.json"), "utf8"),
  ) as {
    readonly streams: readonly {
      readonly stream: string;
      readonly reducer: string;
      readonly role: string;
      readonly head: string;
    }[];
  };
  const expected = {
    version: 1,
    session: "e5-t13-causal-browser-capstone",
    streams: replay.replayStreams.map((entry) => ({
      ...manifest.streams.find(({ stream }) => stream === entry.stream)!,
      digest: entry.digest,
    })),
    links: { resolved: replay.resolved },
    composite: replay.composite,
    merge: { prMergedOffset: merged.offset },
  };
  await writeFile(resolve(sessionDirectory, "expected.json"), `${canonicalJson(expected)}\n`);
  execFileSync(process.execPath, [cli, "replay", "--session", sessionDirectory], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  await copySessionAliases(contentStream!);

  const navigation = watched.map((watch) => ({
    surface: watch.label,
    navigations: watch.navigations(),
    documentRequests: watch.documentRequests(),
  }));
  const browserArtifact = {
    version: 1,
    livenessBoundMs: LIVENESS_BOUND_MS,
    platform: { freshDataDir: world.dataDir },
    identities: { actor: actorIdentity, witness: witnessIdentity },
    contextsDistinct: actor.context !== witness.context,
    timeline,
    navigation,
    lifecycle: { httpFailures, consoleAndPageErrors: 0, requestFailures: 0 },
    dispatches: { actor: actorDispatches, witness: witnessDispatches },
    branchRegistrations: { actor: actorBranchRegistrations, witness: witnessBranchRegistrations },
    streams: domStreams,
    links: { resolved: 4 },
    replayComposite: replay.composite,
    merge: { requestedType: "pr.merge", outcomeType: "pr.merged", offset: merged.offset },
    attachment: {
      contentStream,
      sha256: attachmentHash,
      bytes: attachmentBytes.byteLength,
      replayReference,
    },
  };
  await writeFile(resolve(evidence, "e5-t13-browser.json"), `${canonicalJson(browserArtifact)}\n`);
  await writeFile(
    resolve(evidence, "e5-t13-timeline.txt"),
    `${timeline.map((entry) => canonicalJson(entry)).join("\n")}\n`,
  );
  process.stdout.write(
    `BROWSER contexts=2 identities=2 bound_ms=${String(LIVENESS_BOUND_MS)} navigations=0 console=0 requests=clean OK\n`,
  );
} finally {
  await Promise.allSettled([actor.close(), witness.close()]);
  await browser.close();
  await world.close();
}
