import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bootWorld,
  loginWithFixture,
  replayChromiumPath,
  type GuardedPage,
  type WireObservation,
} from "@eforest/browser-verify";
import { createDurableJsonStream, readDurableJson, type StreamRecord } from "@eforest/client";
import {
  ATTACHMENT_EVENT_VERSION,
  encodeCanonicalBase64,
  evidenceContentStreamId,
  evidenceStreamId,
  type EvidenceEntityRef,
} from "@eforest/evidence";
import { canonicalJson, sha256Hex } from "@eforest/protocol";
import { issueStreamId, replayWithReducer, requireReducer } from "@eforest/reducers";
import { chromium, type Download, type Page, type Request } from "playwright-core";

interface JsCoverageEntry {
  readonly url: string;
  readonly source?: string;
  readonly functions: readonly {
    readonly ranges: readonly {
      readonly count: number;
      readonly startOffset: number;
      readonly endOffset: number;
    }[];
  }[];
}

interface CssCoverageEntry {
  readonly url: string;
  readonly text?: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
}

interface BrowserCoverage {
  readonly js: readonly JsCoverageEntry[];
  readonly css: readonly CssCoverageEntry[];
}

interface FailedRequest {
  readonly surface: "issue" | "pr";
  readonly actor: "writer" | "follower";
  readonly method: string;
  readonly url: string;
  readonly errorText: string;
}

interface Surface {
  readonly actor: "writer" | "follower";
  readonly kind: "issue" | "pr";
  readonly guarded: GuardedPage;
  readonly failures: FailedRequest[];
  readonly networkStart: number;
}

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T11-evidence-ui");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const proofReceiptPath = resolve(work, "e5-t11-empty-proof-receipt.json");
const fixturePath = resolve(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T01-issue-event-model/evidence/golden-issue.jsonl",
);
const materialBrowserSources = [
  "apps/web/src/evidence/EvidencePanel.tsx",
  "apps/web/src/evidence/model.ts",
  "apps/web/src/evidence/useEvidence.ts",
  "apps/web/src/issues/IssueDetail.tsx",
  "apps/web/src/prs/PrDetail.tsx",
  "apps/web/src/styles.css",
] as const;
const subject = {
  id: "e5-t11-browser",
  email: "e5-t11-browser@canopy.test",
  password: "E5T11Browser1234!",
  name: "E5 T11 Browser",
};
const org = "maple";
const repo = "reading-room";
const issueId = "evidence-issue";
const prId = "evidence-pr";
const issueRef: EvidenceEntityRef = { org, repo, entityType: "issue", entityId: issueId };
const prRef: EvidenceEntityRef = { org, repo, entityType: "pr", entityId: prId };
const issueEvidenceStream = evidenceStreamId(issueRef);
const prEvidenceStream = evidenceStreamId(prRef);
const issuePath = `/orgs/${org}/repos/${repo}/issues/${issueId}`;
const prPath = `/orgs/${org}/repos/${repo}/pulls/${prId}`;
const replayIssueUrl = "https://app.replay.io/recording/e5-t11-issue";
const replayPrUrl = "https://app.replay.io/recording/e5-t11-pr";

function currentHead(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
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

function browserApiTranscript(
  surface: Surface,
): readonly Record<string, string | number | null | readonly (readonly [string, string])[]>[] {
  return surface.guarded.network
    .slice(surface.networkStart)
    .filter((entry) => entry.layer === "browser" && normalizedUrl(entry.url).startsWith("/api/"))
    .map((entry, sequence) => ({
      actor: surface.actor,
      surface: surface.kind,
      sequence,
      direction: entry.direction,
      url: normalizedUrl(entry.url),
      ...(entry.method === undefined ? {} : { method: entry.method }),
      ...(entry.status === undefined ? {} : { status: entry.status }),
      headers: entry.headers
        .filter(([name]) => !["authorization", "cookie", "set-cookie"].includes(name.toLowerCase()))
        .map(([name, value]) => [name.toLowerCase(), value] as const),
      bodyBase64: entry.bodyBase64,
    }));
}

function inFlightApiRequests(surface: Surface): readonly {
  readonly actor: "writer" | "follower";
  readonly surface: "issue" | "pr";
  readonly url: string;
  readonly count: number;
  readonly classification: "active-follow-long-poll";
}[] {
  const observations = surface.guarded.network
    .slice(surface.networkStart)
    .filter((entry) => entry.layer === "browser" && normalizedUrl(entry.url).startsWith("/api/"));
  const requests = new Map<string, number>();
  const responses = new Map<string, number>();
  for (const entry of observations) {
    const url = normalizedUrl(entry.url);
    const target = entry.direction === "request" ? requests : responses;
    target.set(url, (target.get(url) ?? 0) + 1);
  }
  const result: Array<{
    actor: "writer" | "follower";
    surface: "issue" | "pr";
    url: string;
    count: number;
    classification: "active-follow-long-poll";
  }> = [];
  for (const [url, count] of requests) {
    const pending = count - (responses.get(url) ?? 0);
    if (pending <= 0) continue;
    assert.match(url, /\/events(?:\?|$)/, `unclassified in-flight request: ${url}`);
    result.push({
      actor: surface.actor,
      surface: surface.kind,
      url,
      count: pending,
      classification: "active-follow-long-poll",
    });
  }
  return result;
}

function captureFailures(
  page: Page,
  actor: "writer" | "follower",
  surface: "issue" | "pr",
): FailedRequest[] {
  const failures: FailedRequest[] = [];
  page.on("requestfailed", (request: Request) => {
    failures.push({
      actor,
      surface,
      method: request.method(),
      url: normalizedUrl(request.url()),
      errorText: request.failure()?.errorText ?? "unknown request failure",
    });
  });
  return failures;
}

async function startCoverage(page: Page): Promise<void> {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.coverage.startCSSCoverage({ resetOnNavigation: false });
}

async function stopCoverage(page: Page): Promise<BrowserCoverage> {
  const css = await page.coverage.stopCSSCoverage();
  const js = await page.coverage.stopJSCoverage();
  return { js, css };
}

function mergeRanges(
  ranges: readonly { readonly start: number; readonly end: number }[],
): readonly { readonly start: number; readonly end: number }[] {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function inlineSources(source: string): readonly string[] {
  const match =
    /sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/.exec(
      source,
    );
  if (match === null) return [];
  const parsed = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as {
    readonly sources?: unknown;
  };
  return Array.isArray(parsed.sources)
    ? parsed.sources.filter((value): value is string => typeof value === "string")
    : [];
}

function coverageArtifact(
  recordedHead: string,
  runs: readonly {
    readonly actor: "writer" | "follower";
    readonly surface: "issue" | "pr";
    readonly coverage: BrowserCoverage;
  }[],
) {
  const materialSources = new Set<string>();
  const assets = runs.flatMap((run) =>
    run.coverage.js
      .filter((entry) => entry.source !== undefined && entry.url.includes("/assets/"))
      .map((entry) => {
        for (const source of inlineSources(entry.source!)) {
          const normalized = source.replaceAll("\\", "/");
          for (const material of materialBrowserSources) {
            if (normalized.endsWith(material.replace(/^apps\/web\//, ""))) {
              materialSources.add(material);
            }
          }
        }
        const ranges = mergeRanges(
          entry.functions.flatMap((fn) =>
            fn.ranges
              .filter((range) => range.count > 0)
              .map((range) => ({ start: range.startOffset, end: range.endOffset })),
          ),
        );
        return {
          actor: run.actor,
          surface: run.surface,
          path: new URL(entry.url).pathname,
          sha256: sha256Hex(new TextEncoder().encode(entry.source!)),
          hitBytes: ranges.reduce((sum, range) => sum + range.end - range.start, 0),
          totalBytes: entry.source!.length,
        };
      }),
  );
  const cssAssets = runs.flatMap((run) =>
    run.coverage.css
      .filter((entry) => entry.text !== undefined && entry.url.includes("/assets/"))
      .map((entry) => {
        for (const source of inlineSources(entry.text!)) {
          const normalized = source.replaceAll("\\", "/");
          for (const material of materialBrowserSources) {
            if (normalized.endsWith(material.replace(/^apps\/web\//, ""))) {
              materialSources.add(material);
            }
          }
        }
        return {
          actor: run.actor,
          surface: run.surface,
          path: new URL(entry.url).pathname,
          sha256: sha256Hex(new TextEncoder().encode(entry.text!)),
          coveredRanges: entry.ranges.length,
        };
      }),
  );
  assert.ok(assets.length > 0, "browser JS coverage contained no production assets");
  assert.ok(cssAssets.length > 0, "browser CSS coverage contained no production assets");
  const appStylesExecuted = runs.some((run) =>
    run.coverage.css.some(
      (entry) =>
        entry.text?.includes(".evidence-region") === true &&
        entry.text.includes(".pr-app") &&
        entry.ranges.length > 0,
    ),
  );
  assert.equal(appStylesExecuted, true, "app stylesheet had no executed browser coverage");
  materialSources.add("apps/web/src/styles.css");
  for (const source of materialBrowserSources) {
    assert.equal(materialSources.has(source), true, `source map omitted ${source}`);
  }
  return {
    schemaVersion: 1,
    recordedHead,
    materialSources: [...materialSources].sort(),
    assets,
    cssAssets,
    assertions: [
      "issue and PR evidence regions rendered from live reducers in two contexts",
      "content upload, hash verification, exact-byte download, and reference dispatch executed",
      "corrupted sealed content and hostile link defensive render paths executed",
    ],
  };
}

async function prepareSurface(
  surface: Surface,
  platformUrl: string,
  path: string,
  uuidSeed: number,
): Promise<Surface> {
  await surface.guarded.page.goto(platformUrl);
  await loginWithFixture(surface.guarded.page);
  await surface.guarded.page.addInitScript((seed: number) => {
    let sequence = 0;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: () => {
        sequence += 1;
        const suffix = (seed + sequence).toString(16).padStart(12, "0").slice(-12);
        return `00000000-0000-4000-8000-${suffix}`;
      },
    });
  }, uuidSeed);
  await startCoverage(surface.guarded.page);
  await surface.guarded.page.goto(`${platformUrl}${path}`);
  await surface.guarded.page
    .locator('[data-testid="evidence-region"][data-stream-status="live"]')
    .waitFor();
  const failures = captureFailures(surface.guarded.page, surface.actor, surface.kind);
  await surface.guarded.page.evaluate((seed: number) => {
    let timestamp = seed;
    Date.now = () => ++timestamp;
  }, 1_700_000_500_000 + uuidSeed);
  return {
    ...surface,
    failures,
    networkStart: surface.guarded.network.length,
  };
}

async function withinLiveBudget(label: string, work: () => Promise<void>): Promise<number> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("exceeded 2000 ms")), 2_000);
      }),
    ]);
  } catch (error) {
    throw new Error(`live-sync:${label}`, { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const latency = Date.now() - started;
  assert.ok(latency <= 2_000, `live-sync:${label}:${String(latency)}ms`);
  return latency;
}

async function uploadThroughUi(
  writer: Surface,
  follower: Surface,
  input: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array },
): Promise<{ readonly attachmentId: string; readonly latency: number }> {
  await writer.guarded.page.getByTestId("attachment-kind").selectOption("event-log");
  await writer.guarded.page.getByTestId("attachment-file").setInputFiles({
    name: input.name,
    mimeType: input.mediaType,
    buffer: Buffer.from(input.bytes),
  });
  const followerRow = follower.guarded.page
    .getByTestId("attachment-row")
    .filter({ hasText: input.name });
  const followerVerifiedRow = follower.guarded.page
    .locator('[data-testid="attachment-row"][data-ef-hash-verified="true"]')
    .filter({ hasText: input.name });
  const writerForm = writer.guarded.page.getByTestId("attachment-upload-form");
  let latency: number;
  try {
    latency = await withinLiveBudget(`${writer.kind}-content`, async () => {
      await writer.guarded.page.getByTestId("attachment-upload-submit").click();
      const outcome = await Promise.race([
        followerVerifiedRow.waitFor().then(() => ({ kind: "rendered" as const })),
        writerForm
          .getByRole("alert")
          .waitFor()
          .then(async () => ({
            kind: "refused" as const,
            message: await writerForm.getByRole("alert").innerText(),
          })),
      ]);
      if (outcome.kind === "refused") throw new Error(`upload refused: ${outcome.message}`);
    });
  } catch (error) {
    const api = writer.guarded.network
      .filter((entry) => normalizedUrl(entry.url).startsWith("/api/"))
      .slice(-12)
      .map((entry) => ({
        direction: entry.direction,
        method: entry.method,
        status: entry.status,
        url: normalizedUrl(entry.url),
      }));
    throw new Error(
      `upload diagnostics: form=${JSON.stringify(await writerForm.innerText())} api=${JSON.stringify(api)}`,
      { cause: error },
    );
  }
  const writerRow = writer.guarded.page
    .getByTestId("attachment-row")
    .filter({ hasText: input.name });
  await writer.guarded.page
    .locator('[data-testid="attachment-row"][data-ef-hash-verified="true"]')
    .filter({ hasText: input.name })
    .waitFor();
  assert.equal(
    await followerRow.getByTestId("attachment-sha256").textContent(),
    sha256Hex(input.bytes),
  );
  const attachmentId = await followerRow.getAttribute("data-attachment-id");
  assert.notEqual(attachmentId, null);
  return { attachmentId: attachmentId!, latency };
}

async function attachReferenceThroughUi(
  writer: Surface,
  follower: Surface,
  input: { readonly url: string; readonly title: string },
): Promise<number> {
  await writer.guarded.page.getByTestId("attachment-replay-url").fill(input.url);
  await writer.guarded.page.getByTestId("attachment-replay-title").fill(input.title);
  const followerRow = follower.guarded.page
    .getByTestId("attachment-row")
    .filter({ hasText: input.title });
  const latency = await withinLiveBudget(`${writer.kind}-reference`, async () => {
    await writer.guarded.page.getByTestId("attachment-replay-submit").click();
    await followerRow.waitFor();
  });
  assert.equal(await followerRow.getByTestId("attachment-link").getAttribute("href"), input.url);
  return latency;
}

async function readDownload(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

async function evidenceParity(
  world: { readonly streamUrl: string },
  streamId: string,
  writer: Surface,
  follower: Surface,
): Promise<{
  readonly records: readonly StreamRecord[];
  readonly offset: string;
  readonly digest: string;
}> {
  const records = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
  const replay = replayWithReducer(requireReducer("evidence", streamId), records, streamId);
  const writerRegion = writer.guarded.page.getByTestId("evidence-region");
  const followerRegion = follower.guarded.page.getByTestId("evidence-region");
  const offset = records.at(-1)?.offset ?? "-1";
  assert.equal(await writerRegion.getAttribute("data-ef-offset"), offset);
  assert.equal(await followerRegion.getAttribute("data-ef-offset"), offset);
  assert.equal(await writerRegion.getAttribute("data-ef-digest"), replay.digest);
  assert.equal(await followerRegion.getAttribute("data-ef-digest"), replay.digest);
  assert.equal(await writerRegion.getAttribute("data-ef-reducer"), "evidence");
  assert.equal(await followerRegion.getAttribute("data-ef-reducer"), "evidence");
  return { records, offset, digest: replay.digest };
}

async function pageDiagnostics(surface: Surface) {
  const console = (await surface.guarded.page.consoleMessages()).map((message, sequence) => ({
    actor: surface.actor,
    surface: surface.kind,
    sequence,
    type: message.type(),
    text: message.text(),
    url: message.location().url === "" ? "" : normalizedUrl(message.location().url),
  }));
  const pageErrors = (await surface.guarded.page.pageErrors()).map((error, sequence) => ({
    actor: surface.actor,
    surface: surface.kind,
    sequence,
    name: error.name,
    message: error.message,
  }));
  return { console, pageErrors };
}

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const recordedHead = currentHead();
const fixtureBytes = new Uint8Array(await readFile(fixturePath));
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const mainStream = await world.seedPublicRepo({ org, project: "canopy", repo, branch: "main" });
await world.identity.ensureUser(`auth0|${subject.id}`, subject.email);
await world.identity.createOrg(org, org, `auth0|${subject.id}`);
const sourceStream = `fs:${org}/${repo}:evidence-feature:meta`;
const issueStream = issueStreamId(org, repo, issueId);
const prStream = `pr:${org}/${repo}/${prId}`;
await Promise.all(
  [sourceStream, issueStream, prStream, issueEvidenceStream, prEvidenceStream].map((streamId) =>
    createDurableJsonStream({
      url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
    }),
  ),
);
await world.appendApplication(issueStreamId(org, repo, issueId), {
  type: "issue.opened",
  payload: { v: 1, title: "Evidence issue", body: "Prove the attachment UI." },
  ts: 1,
});
await world.appendApplication(`pr:${org}/${repo}/${prId}`, {
  type: "pr.opened",
  payload: {
    v: 1,
    sourceBranch: sourceStream,
    targetBranch: mainStream,
    forkOffset: "-1",
    title: "Evidence pull request",
    body: "Attach the browser proof.",
    author: subject.email,
  },
  ts: 2,
});

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guardedPages = await Promise.all([
  world.openPage(browser),
  world.openPage(browser),
  world.openPage(browser),
  world.openPage(browser),
]);
try {
  const bareSurfaces: Surface[] = [
    { actor: "writer", kind: "issue", guarded: guardedPages[0]!, failures: [], networkStart: 0 },
    { actor: "follower", kind: "issue", guarded: guardedPages[1]!, failures: [], networkStart: 0 },
    { actor: "writer", kind: "pr", guarded: guardedPages[2]!, failures: [], networkStart: 0 },
    { actor: "follower", kind: "pr", guarded: guardedPages[3]!, failures: [], networkStart: 0 },
  ];
  const surfaces = await Promise.all([
    prepareSurface(bareSurfaces[0]!, world.platformUrl, issuePath, 0x1000),
    prepareSurface(bareSurfaces[1]!, world.platformUrl, issuePath, 0x2000),
    prepareSurface(bareSurfaces[2]!, world.platformUrl, prPath, 0x3000),
    prepareSurface(bareSurfaces[3]!, world.platformUrl, prPath, 0x4000),
  ]);
  const [issueWriter, issueFollower, prWriter, prFollower] = surfaces as [
    Surface,
    Surface,
    Surface,
    Surface,
  ];

  const latencies: number[] = [];
  const issueUpload = await uploadThroughUi(issueWriter, issueFollower, {
    name: "golden-issue.jsonl",
    mediaType: "application/x-ndjson",
    bytes: fixtureBytes,
  });
  latencies.push(issueUpload.latency);
  latencies.push(
    await attachReferenceThroughUi(issueWriter, issueFollower, {
      url: replayIssueUrl,
      title: "Issue Replay proof",
    }),
  );

  const issueFollowerRow = issueFollower.guarded.page
    .getByTestId("attachment-row")
    .filter({ hasText: "golden-issue.jsonl" });
  const downloadPromise = issueFollower.guarded.page.waitForEvent("download");
  await issueFollowerRow.getByTestId("attachment-download").click();
  const downloadedBytes = await readDownload(await downloadPromise);
  assert.deepEqual(downloadedBytes, fixtureBytes, "downloaded bytes differ from source fixture");

  const actualCorruptBytes = new TextEncoder().encode("tampered evidence bytes\n");
  const corruptAttachmentId = "corrupt-fixture";
  const corruptContentStream = evidenceContentStreamId(org, repo, corruptAttachmentId);
  await createDurableJsonStream({
    url: `${world.streamUrl}/streams/${encodeURIComponent(corruptContentStream)}`,
  });
  await world.appendApplication(corruptContentStream, {
    type: "content.chunk",
    payload: {
      v: ATTACHMENT_EVENT_VERSION,
      seq: 0,
      bytes: encodeCanonicalBase64(actualCorruptBytes),
    },
    ts: 10,
  });
  await world.appendApplication(corruptContentStream, {
    type: "content.sealed",
    payload: {
      v: ATTACHMENT_EVENT_VERSION,
      sha256: sha256Hex(actualCorruptBytes),
      size: actualCorruptBytes.byteLength,
      chunks: 1,
    },
    ts: 11,
  });
  latencies.push(
    await withinLiveBudget("issue-corruption", async () => {
      await world.appendApplication(issueEvidenceStream, {
        type: "evidence.attached",
        payload: {
          v: ATTACHMENT_EVENT_VERSION,
          attachmentId: corruptAttachmentId,
          kind: "digest",
          name: "corrupt.txt",
          mediaType: "text/plain",
          size: actualCorruptBytes.byteLength,
          sha256: sha256Hex(new TextEncoder().encode("recorded trusted bytes\n")),
          contentStream: corruptContentStream,
        },
        ts: 12,
      });
      await issueFollower.guarded.page
        .locator(
          `[data-testid="attachment-row"][data-attachment-id="${corruptAttachmentId}"][data-ef-hash-verified="false"]`,
        )
        .getByRole("alert")
        .waitFor();
    }),
  );
  const corruptWriterRow = issueWriter.guarded.page.locator(
    `[data-testid="attachment-row"][data-attachment-id="${corruptAttachmentId}"]`,
  );
  await corruptWriterRow.getByRole("alert").waitFor();
  assert.equal(await corruptWriterRow.getAttribute("data-ef-hash-verified"), "false");

  const hostileAttachmentId = "hostile-link";
  latencies.push(
    await withinLiveBudget("issue-hostile-link", async () => {
      await world.appendApplication(issueEvidenceStream, {
        type: "evidence.linked",
        payload: {
          v: ATTACHMENT_EVENT_VERSION,
          attachmentId: hostileAttachmentId,
          kind: "replay-recording",
          url: "javascript:alert(1)",
          title: "Hostile reference",
        },
        ts: 13,
      });
      await issueFollower.guarded.page
        .locator(`[data-testid="attachment-row"][data-attachment-id="${hostileAttachmentId}"]`)
        .getByRole("alert")
        .waitFor();
    }),
  );
  const hostileRow = issueFollower.guarded.page.locator(
    `[data-testid="attachment-row"][data-attachment-id="${hostileAttachmentId}"]`,
  );
  assert.equal(await hostileRow.locator("a").count(), 0, "unsafe reference rendered a live link");

  const prUpload = await uploadThroughUi(prWriter, prFollower, {
    name: "pr-proof.jsonl",
    mediaType: "application/x-ndjson",
    bytes: fixtureBytes,
  });
  latencies.push(prUpload.latency);
  latencies.push(
    await attachReferenceThroughUi(prWriter, prFollower, {
      url: replayPrUrl,
      title: "PR Replay proof",
    }),
  );

  await Promise.all(surfaces.map((surface) => surface.guarded.settleNetwork()));
  await Promise.all(surfaces.map((surface) => surface.guarded.page.waitForTimeout(650)));
  await Promise.all(surfaces.map((surface) => surface.guarded.settleNetwork()));

  const issueParity = await evidenceParity(world, issueEvidenceStream, issueWriter, issueFollower);
  const prParity = await evidenceParity(world, prEvidenceStream, prWriter, prFollower);
  assert.ok(Math.max(...latencies) <= 2_000);

  const runNetwork = surfaces.flatMap((surface) =>
    surface.guarded.network.slice(surface.networkStart),
  );
  const writes = dispatchRequests(runNetwork);
  assert.deepEqual(
    writes.map((entry) => JSON.parse(decodedBody(entry)).event.type),
    [
      "content.chunk",
      "content.sealed",
      "evidence.attached",
      "evidence.linked",
      "content.chunk",
      "content.sealed",
      "evidence.attached",
      "evidence.linked",
    ],
  );
  const otherWrites = runNetwork.filter(
    (entry) =>
      entry.layer === "browser" &&
      entry.direction === "request" &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method ?? "") &&
      new URL(entry.url).pathname !== "/api/dispatch",
  );
  assert.deepEqual(otherWrites, []);

  const coverageRuns = await Promise.all(
    surfaces.map(async (surface) => ({
      actor: surface.actor,
      surface: surface.kind,
      coverage: await stopCoverage(surface.guarded.page),
    })),
  );
  const diagnostics = await Promise.all(surfaces.map(pageDiagnostics));
  for (const surface of surfaces) {
    assert.deepEqual(surface.failures, [], `${surface.actor}-${surface.kind} request failures`);
    surface.guarded.assertClean();
  }
  const transcript = {
    schemaVersion: 1,
    recordedHead,
    window: "post-authentication E5-T11 issue and PR evidence activity",
    network: surfaces.flatMap(browserApiTranscript),
    requestFailures: surfaces.flatMap((surface) => surface.failures),
    inFlightRequests: surfaces.flatMap(inFlightApiRequests),
    console: diagnostics.flatMap((entry) => entry.console),
    pageErrors: diagnostics.flatMap((entry) => entry.pageErrors),
  };
  assert.equal(transcript.requestFailures.length, 0);
  assert.equal(transcript.console.filter((entry) => entry.type === "error").length, 0);
  assert.equal(transcript.pageErrors.length, 0);
  const coverage = coverageArtifact(recordedHead, coverageRuns);

  await writeFile(
    resolve(evidence, "e5-t11-session.events.jsonl"),
    `${canonicalJson({ streamId: issueEvidenceStream, records: issueParity.records })}\n${canonicalJson({ streamId: prEvidenceStream, records: prParity.records })}\n`,
  );
  await writeFile(
    resolve(evidence, "e5-t11-browser-transcript.json"),
    `${canonicalJson(transcript)}\n`,
  );
  await writeFile(
    resolve(evidence, "e5-t11-browser-source-coverage.json"),
    `${canonicalJson(coverage)}\n`,
  );
  await writeFile(
    resolve(evidence, "e5-t11-digests.txt"),
    [
      "E5-T11 two-session evidence convergence",
      `issue-stream=${issueEvidenceStream}`,
      `issue-offset=${issueParity.offset}`,
      `issue-digest=${issueParity.digest}`,
      `pr-stream=${prEvidenceStream}`,
      `pr-offset=${prParity.offset}`,
      `pr-digest=${prParity.digest}`,
      `fixture-sha256=${sha256Hex(fixtureBytes)}`,
      `latencies-ms=${latencies.join(",")}`,
      "E5_T11_DIGESTS_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t11-byte-parity.txt"),
    [
      "E5-T11 exact-byte download",
      `source-bytes=${String(fixtureBytes.byteLength)}`,
      `downloaded-bytes=${String(downloadedBytes.byteLength)}`,
      `source-sha256=${sha256Hex(fixtureBytes)}`,
      `downloaded-sha256=${sha256Hex(downloadedBytes)}`,
      `attachment-id=${issueUpload.attachmentId}`,
      "E5_T11_BYTE_PARITY_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t11-hostile-link.txt"),
    [
      "E5-T11 hostile reference render",
      `attachment-id=${hostileAttachmentId}`,
      "recorded-url=javascript:alert(1)",
      "rendered-anchor-count=0",
      "visible-warning=true",
      "E5_T11_HOSTILE_LINK_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t11-write-audit.txt"),
    [
      "E5-T11 browser write audit",
      `dispatch-posts=${String(writes.length)}`,
      `event-types=${writes.map((entry) => JSON.parse(decodedBody(entry)).event.type).join(",")}`,
      `other-state-writes=${String(otherWrites.length)}`,
      "E5_T11_WRITE_AUDIT_OK",
      "",
    ].join("\n"),
  );
  await writeFile(
    resolve(evidence, "e5-t11-replay-fallback.txt"),
    [
      "Replay: N/A (preflight failed because installed replayio 1.8.2 exposes no mcp command)",
      "+ mitigation: exact-head four-context Playwright transcript with source coverage,",
      "request-failure and long-poll accounting, console/page-error sweeps, exact-byte",
      "download parity, hostile/corrupt paths, write audit, and independent stream replay.",
      "E5_T11_REPLAY_FALLBACK_OK",
      "",
    ].join("\n"),
  );

  process.stdout.write(
    `E5_T11_BROWSER_OK dispatches=${String(writes.length)} issue_events=${String(issueParity.records.length)} pr_events=${String(prParity.records.length)} max_latency_ms=${String(Math.max(...latencies))} failures=0 console_errors=0\n`,
  );
} finally {
  await Promise.allSettled(guardedPages.map((guarded) => guarded.close()));
  await browser.close();
  await world.close();
}
