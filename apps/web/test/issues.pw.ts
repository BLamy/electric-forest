import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

type CoverageRole = "writer-board" | "follower-board" | "writer-detail" | "follower-detail";
type CoverageStage = "initial" | "mutation";

interface CoverageRun {
  readonly role: CoverageRole;
  readonly stage: CoverageStage;
  readonly coverage: BrowserCoverage;
}

interface JsCoverageRequirement {
  readonly id: string;
  readonly kind: "js-source";
  readonly role: CoverageRole;
  readonly stage: CoverageStage;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

interface CssCoverageRequirement {
  readonly id: string;
  readonly kind: "css-rule";
  readonly role: CoverageRole;
  readonly stage: CoverageStage;
  readonly file: "apps/web/src/styles.css";
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly selector: string;
}

type CoverageRequirement = JsCoverageRequirement | CssCoverageRequirement;

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
const materialBrowserSources = [
  "apps/web/src/issues/IssueBoard.tsx",
  "apps/web/src/issues/IssueDetail.tsx",
  "apps/web/src/issues/useIssues.ts",
  "apps/web/src/route-pages.tsx",
  "apps/web/src/routes.tsx",
  "apps/web/src/styles.css",
] as const;
const coverageRequirements: readonly CoverageRequirement[] = [
  {
    id: "route.issue-board-writer",
    kind: "js-source",
    role: "writer-board",
    stage: "initial",
    file: "apps/web/src/route-pages.tsx",
    lineStart: 885,
    lineEnd: 912,
  },
  {
    id: "route.issue-board-follower",
    kind: "js-source",
    role: "follower-board",
    stage: "initial",
    file: "apps/web/src/route-pages.tsx",
    lineStart: 885,
    lineEnd: 912,
  },
  {
    id: "route.issue-detail-writer",
    kind: "js-source",
    role: "writer-detail",
    stage: "initial",
    file: "apps/web/src/route-pages.tsx",
    lineStart: 885,
    lineEnd: 912,
  },
  {
    id: "route.issue-detail-follower",
    kind: "js-source",
    role: "follower-detail",
    stage: "initial",
    file: "apps/web/src/route-pages.tsx",
    lineStart: 885,
    lineEnd: 912,
  },
  {
    id: "route.global-issues-link",
    kind: "js-source",
    role: "writer-board",
    stage: "initial",
    file: "apps/web/src/routes.tsx",
    lineStart: 150,
    lineEnd: 160,
  },
  {
    id: "board.writer-live-region",
    kind: "js-source",
    role: "writer-board",
    stage: "initial",
    file: "apps/web/src/issues/IssueBoard.tsx",
    lineStart: 21,
    lineEnd: 70,
  },
  {
    id: "board.follower-live-region",
    kind: "js-source",
    role: "follower-board",
    stage: "initial",
    file: "apps/web/src/issues/IssueBoard.tsx",
    lineStart: 21,
    lineEnd: 70,
  },
  {
    id: "board.create-dispatch",
    kind: "js-source",
    role: "writer-board",
    stage: "mutation",
    file: "apps/web/src/issues/IssueBoard.tsx",
    lineStart: 73,
    lineEnd: 83,
  },
  {
    id: "board.follower-label-filter",
    kind: "js-source",
    role: "follower-board",
    stage: "mutation",
    file: "apps/web/src/issues/IssueBoard.tsx",
    lineStart: 129,
    lineEnd: 143,
  },
  {
    id: "board.follower-columns-and-cards",
    kind: "js-source",
    role: "follower-board",
    stage: "mutation",
    file: "apps/web/src/issues/IssueBoard.tsx",
    lineStart: 154,
    lineEnd: 180,
  },
  {
    id: "detail.writer-live-region",
    kind: "js-source",
    role: "writer-detail",
    stage: "initial",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 41,
    lineEnd: 100,
  },
  {
    id: "detail.follower-live-region",
    kind: "js-source",
    role: "follower-detail",
    stage: "initial",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 41,
    lineEnd: 100,
  },
  {
    id: "detail.comment-dispatch",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 159,
    lineEnd: 168,
  },
  {
    id: "detail.label-dispatch",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 184,
    lineEnd: 190,
  },
  {
    id: "detail.unlabel-dispatch",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 120,
    lineEnd: 133,
  },
  {
    id: "detail.legal-transition-dispatch",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 202,
    lineEnd: 237,
  },
  {
    id: "detail.illegal-transition-submit",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 239,
    lineEnd: 259,
  },
  {
    id: "detail.illegal-refusal-render",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 137,
    lineEnd: 146,
  },
  {
    id: "detail.follower-label-render",
    kind: "js-source",
    role: "follower-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 120,
    lineEnd: 133,
  },
  {
    id: "detail.follower-state-render",
    kind: "js-source",
    role: "follower-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 111,
    lineEnd: 119,
  },
  {
    id: "detail.follower-timeline-render",
    kind: "js-source",
    role: "follower-detail",
    stage: "mutation",
    file: "apps/web/src/issues/IssueDetail.tsx",
    lineStart: 271,
    lineEnd: 285,
  },
  {
    id: "binding.issue-actions",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/useIssues.ts",
    lineStart: 42,
    lineEnd: 56,
  },
  {
    id: "binding.typed-refusal",
    kind: "js-source",
    role: "writer-detail",
    stage: "mutation",
    file: "apps/web/src/issues/useIssues.ts",
    lineStart: 58,
    lineEnd: 69,
  },
  {
    id: "binding.follower-board-hook",
    kind: "js-source",
    role: "follower-board",
    stage: "mutation",
    file: "apps/web/src/issues/useIssues.ts",
    lineStart: 76,
    lineEnd: 96,
  },
  {
    id: "binding.writer-create-hook",
    kind: "js-source",
    role: "writer-board",
    stage: "mutation",
    file: "apps/web/src/issues/useIssues.ts",
    lineStart: 98,
    lineEnd: 100,
  },
  {
    id: "binding.follower-issue-hook",
    kind: "js-source",
    role: "follower-detail",
    stage: "mutation",
    file: "apps/web/src/issues/useIssues.ts",
    lineStart: 102,
    lineEnd: 121,
  },
  {
    id: "style.issue-board",
    kind: "css-rule",
    role: "writer-board",
    stage: "initial",
    file: "apps/web/src/styles.css",
    lineStart: 622,
    lineEnd: 760,
    selector: ".issue-board",
  },
  {
    id: "style.issue-detail",
    kind: "css-rule",
    role: "writer-detail",
    stage: "initial",
    file: "apps/web/src/styles.css",
    lineStart: 622,
    lineEnd: 837,
    selector: ".issue-detail",
  },
  {
    id: "style.issue-labels",
    kind: "css-rule",
    role: "follower-detail",
    stage: "initial",
    file: "apps/web/src/styles.css",
    lineStart: 747,
    lineEnd: 805,
    selector: ".issue-labels",
  },
  {
    id: "style.issue-actions",
    kind: "css-rule",
    role: "writer-detail",
    stage: "initial",
    file: "apps/web/src/styles.css",
    lineStart: 658,
    lineEnd: 816,
    selector: ".issue-actions",
  },
  {
    id: "style.issue-timeline",
    kind: "css-rule",
    role: "follower-detail",
    stage: "initial",
    file: "apps/web/src/styles.css",
    lineStart: 731,
    lineEnd: 837,
    selector: ".issue-timeline",
  },
];

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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentHeadWithCleanProductSources(): string {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(head.status, 0, `${head.stdout}${head.stderr}`);
  const productDiff = spawnSync("git", ["diff", "--name-only", "HEAD", "--", ...materialBrowserSources], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(productDiff.status, 0, `${productDiff.stdout}${productDiff.stderr}`);
  assert.equal(productDiff.stdout.trim(), "", "material E5-T05 browser sources differ from HEAD");
  return head.stdout.trim();
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

function executedRanges(functions: JsCoverageEntry["functions"]): readonly {
  readonly start: number;
  readonly end: number;
}[] {
  const nestedRanges = functions.flatMap((fn) => fn.ranges);
  const points: Array<{
    readonly offset: number;
    readonly type: 0 | 1;
    readonly range: (typeof nestedRanges)[number];
  }> = [];
  for (const range of nestedRanges) {
    points.push({ offset: range.startOffset, type: 0, range });
    points.push({ offset: range.endOffset, type: 1, range });
  }
  points.sort((left, right) => {
    if (left.offset !== right.offset) return left.offset - right.offset;
    if (left.type !== right.type) return right.type - left.type;
    const leftLength = left.range.endOffset - left.range.startOffset;
    const rightLength = right.range.endOffset - right.range.startOffset;
    return left.type === 0 ? rightLength - leftLength : leftLength - rightLength;
  });

  const hitCountStack: number[] = [];
  const results: Array<{ start: number; end: number }> = [];
  let lastOffset = 0;
  for (const point of points) {
    if (
      hitCountStack.length > 0 &&
      lastOffset < point.offset &&
      hitCountStack[hitCountStack.length - 1]! > 0
    ) {
      const previous = results.at(-1);
      if (previous?.end === lastOffset) previous.end = point.offset;
      else results.push({ start: lastOffset, end: point.offset });
    }
    lastOffset = point.offset;
    if (point.type === 0) hitCountStack.push(point.range.count);
    else hitCountStack.pop();
  }
  return results.filter((range) => range.end - range.start > 1);
}

const base64Digits = new Map(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((digit, index) => [
    digit,
    index,
  ]),
);

function decodeVlq(segment: string): readonly number[] {
  const values: number[] = [];
  let encoded = 0;
  let shift = 0;
  for (const digit of segment) {
    const raw = base64Digits.get(digit);
    assert.notEqual(raw, undefined, `invalid source-map VLQ digit ${JSON.stringify(digit)}`);
    const continuation = (raw! & 32) !== 0;
    encoded += (raw! & 31) * 2 ** shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = encoded % 2 === 1;
    const magnitude = Math.floor(encoded / 2);
    values.push(negative ? -magnitude : magnitude);
    encoded = 0;
    shift = 0;
  }
  assert.equal(shift, 0, "unterminated source-map VLQ segment");
  return values;
}

function lineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function containsOffset(
  ranges: readonly { readonly start: number; readonly end: number }[],
  offset: number,
): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle]!;
    if (offset < range.start) high = middle - 1;
    else if (offset >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function materialSourceFor(sourceMapName: string): (typeof materialBrowserSources)[number] | undefined {
  const normalized = sourceMapName.replaceAll("\\", "/");
  return materialBrowserSources.find((file) =>
    normalized.endsWith(file.replace(/^apps\/web\//, "")),
  );
}

function inlineSourceMap(source: string): {
  readonly sources: readonly string[];
  readonly mappings: string;
} {
  const match =
    /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(
      source,
    );
  assert.notEqual(match, null, "browser bundle is missing its inline source map");
  const parsed = JSON.parse(Buffer.from(match![1]!, "base64").toString("utf8")) as {
    readonly version?: unknown;
    readonly sources?: unknown;
    readonly mappings?: unknown;
  };
  assert.equal(parsed.version, 3);
  assert.ok(Array.isArray(parsed.sources));
  assert.equal(typeof parsed.mappings, "string");
  return { sources: parsed.sources as readonly string[], mappings: parsed.mappings as string };
}

function jsHits(entries: readonly JsCoverageEntry[]): {
  readonly assets: readonly { readonly path: string; readonly sha256: string }[];
  readonly files: Readonly<Record<string, readonly number[]>>;
} {
  const hitLines = new Map<string, Set<number>>(
    materialBrowserSources
      .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
      .map((file) => [file, new Set<number>()]),
  );
  const assets = new Map<string, string>();

  for (const entry of entries) {
    if (entry.source === undefined || !entry.url.includes("/assets/")) continue;
    if (!entry.source.includes("sourceMappingURL=data:application/json")) continue;
    const url = new URL(entry.url);
    assets.set(url.pathname, sha256(entry.source));
    const sourceMap = inlineSourceMap(entry.source);
    const starts = lineStarts(entry.source);
    const ranges = executedRanges(entry.functions);
    let sourceIndex = 0;
    let originalLine = 0;
    let originalColumn = 0;

    for (const [generatedLine, encodedLine] of sourceMap.mappings.split(";").entries()) {
      let generatedColumn = 0;
      for (const segment of encodedLine.split(",")) {
        if (segment === "") continue;
        const values = decodeVlq(segment);
        generatedColumn += values[0] ?? 0;
        if (values.length < 4) continue;
        sourceIndex += values[1]!;
        originalLine += values[2]!;
        originalColumn += values[3]!;
        void originalColumn;
        const generatedStart = starts[generatedLine];
        if (generatedStart === undefined || !containsOffset(ranges, generatedStart + generatedColumn)) {
          continue;
        }
        const sourceName = sourceMap.sources[sourceIndex];
        if (sourceName === undefined) continue;
        const materialSource = materialSourceFor(sourceName);
        if (materialSource !== undefined) hitLines.get(materialSource)!.add(originalLine + 1);
      }
    }
  }

  return {
    assets: [...assets]
      .map(([path, digest]) => ({ path, sha256: digest }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    files: Object.fromEntries(
      [...hitLines].map(([file, lines]) => [file, [...lines].sort((left, right) => left - right)]),
    ),
  };
}

function cssHits(entries: readonly CssCoverageEntry[]): {
  readonly assets: readonly { readonly path: string; readonly sha256: string }[];
  readonly selectors: readonly string[];
} {
  const selectors = new Set(
    coverageRequirements
      .filter((requirement): requirement is CssCoverageRequirement => requirement.kind === "css-rule")
      .map((requirement) => requirement.selector),
  );
  const hitSelectors = new Set<string>();
  const assets = new Map<string, string>();
  for (const entry of entries) {
    if (entry.text === undefined || !entry.url.includes("/assets/")) continue;
    const url = new URL(entry.url);
    assets.set(url.pathname, sha256(entry.text));
    for (const selector of selectors) {
      let index = entry.text.indexOf(selector);
      while (index >= 0) {
        if (
          entry.ranges.some(
            (range) => index < range.end && index + selector.length > range.start,
          )
        ) {
          hitSelectors.add(selector);
          break;
        }
        index = entry.text.indexOf(selector, index + selector.length);
      }
    }
  }
  return {
    assets: [...assets]
      .map(([path, digest]) => ({ path, sha256: digest }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    selectors: [...hitSelectors].sort(),
  };
}

async function coverageManifest(recordedHead: string, coverageRuns: readonly CoverageRun[]) {
  const runs = coverageRuns.map((run) => ({
    role: run.role,
    stage: run.stage,
    js: jsHits(run.coverage.js),
    css: cssHits(run.coverage.css),
  }));
  const requirements = coverageRequirements.map((requirement) => {
    const run = runs.find(
      (candidate) => candidate.role === requirement.role && candidate.stage === requirement.stage,
    );
    assert.notEqual(run, undefined, `coverage run missing for ${requirement.id}`);
    const covered =
      requirement.kind === "js-source"
        ? (run!.js.files[requirement.file] ?? []).some(
            (line) => line >= requirement.lineStart && line <= requirement.lineEnd,
          )
        : run!.css.selectors.includes(requirement.selector);
    assert.equal(covered, true, `source-coverage:${requirement.id}`);
    return { ...requirement, covered };
  });
  const sourceFiles = await Promise.all(
    materialBrowserSources.map(async (path) => ({
      path,
      sha256: sha256(await readFile(resolve(root, path))),
    })),
  );
  return {
    schemaVersion: 1,
    recordedHead,
    sourceFiles,
    requirements,
    runs,
    summary: {
      materialSourceFiles: sourceFiles.length,
      requirementsCovered: requirements.filter((requirement) => requirement.covered).length,
      requirementsTotal: requirements.length,
    },
  };
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

function normalizedHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (["authorization", "cookie", "set-cookie"].includes(lower)) return "<redacted>";
  if (["date", "expires", "last-modified"].includes(lower)) return "<http-date>";
  if (lower === "host") return "<loopback-host>";
  if (lower === "origin") return "<platform-origin>";
  if (lower === "referer") return normalizedUrl(value);
  return value.replaceAll(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "<loopback-origin>");
}

function transcriptNetwork(actor: "writer" | "follower", observations: readonly WireObservation[]) {
  return observations
    .filter((entry) => entry.layer === "browser" && normalizedUrl(entry.url).startsWith("/api/"))
    .map((entry, sequence) => ({
      actor,
      sequence,
      direction: entry.direction,
      url: normalizedUrl(entry.url),
      ...(entry.method === undefined ? {} : { method: entry.method }),
      ...(entry.status === undefined ? {} : { status: entry.status }),
      headers: entry.headers.map(([name, value]) => [
        name.toLowerCase(),
        normalizedHeaderValue(name, value),
      ]),
      bodyBase64: entry.bodyBase64,
      ...(entry.bodyError === undefined ? {} : { bodyError: entry.bodyError }),
    }));
}

async function pageDiagnostics(
  actor: "writer" | "follower",
  surface: "board" | "detail",
  page: Page,
) {
  const console = (await page.consoleMessages()).map((message, sequence) => {
    const location = message.location();
    return {
      actor,
      surface,
      sequence,
      type: message.type(),
      text: message.text(),
      location: {
        url: location.url === "" ? "" : normalizedUrl(location.url),
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      },
    };
  });
  const pageErrors = (await page.pageErrors()).map((error, sequence) => ({
    actor,
    surface,
    sequence,
    name: error.name,
    message: error.message,
  }));
  return { console, pageErrors };
}

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const recordedHead = currentHeadWithCleanProductSources();
const coverageRuns: CoverageRun[] = [];
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
  await Promise.all([startCoverage(writer.page), startCoverage(follower.page)]);
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
  const [writerBoardInitial, followerBoardInitial] = await Promise.all([
    stopCoverage(writer.page),
    stopCoverage(follower.page),
  ]);
  coverageRuns.push(
    { role: "writer-board", stage: "initial", coverage: writerBoardInitial },
    { role: "follower-board", stage: "initial", coverage: followerBoardInitial },
  );
  await Promise.all([startCoverage(writer.page), startCoverage(follower.page)]);

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
  await Promise.all([startCoverage(writerDetail), startCoverage(followerDetail)]);
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
  const [writerDetailInitial, followerDetailInitial] = await Promise.all([
    stopCoverage(writerDetail),
    stopCoverage(followerDetail),
  ]);
  coverageRuns.push(
    { role: "writer-detail", stage: "initial", coverage: writerDetailInitial },
    { role: "follower-detail", stage: "initial", coverage: followerDetailInitial },
  );
  await Promise.all([startCoverage(writerDetail), startCoverage(followerDetail)]);
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

  const [writerBoardMutation, followerBoardMutation, writerDetailMutation, followerDetailMutation] =
    await Promise.all([
      stopCoverage(writer.page),
      stopCoverage(follower.page),
      stopCoverage(writerDetail),
      stopCoverage(followerDetail),
    ]);
  coverageRuns.push(
    { role: "writer-board", stage: "mutation", coverage: writerBoardMutation },
    { role: "follower-board", stage: "mutation", coverage: followerBoardMutation },
    { role: "writer-detail", stage: "mutation", coverage: writerDetailMutation },
    { role: "follower-detail", stage: "mutation", coverage: followerDetailMutation },
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
  const boardRecords = await streamRecords(world, boardStream);
  const boardReplay = replayWithReducer(
    requireReducer("issue-board@1", boardStream),
    boardRecords,
    boardStream,
  );
  assert.equal(replay.digest, issueDigest);
  assert.equal(boardReplay.digest, boardDigest);
  assert.deepEqual(boardReplay.state, atOffset.board);
  assert.equal(acceptedIssueRecords.length, 7);
  assert.equal(boardRecords.length, 8);
  assert.equal(boardRecords.at(-1)?.offset, boardOffset);
  assert.equal(Math.max(...latencies) <= 2_000, true);
  assert.equal(writerBoardNavigations, 0);
  assert.equal(followerBoardNavigations, 0);
  assert.equal(writerDetailNavigations, 0);
  assert.equal(followerDetailNavigations, 0);
  writer.assertClean();
  follower.assertClean();

  const diagnostics = await Promise.all([
    pageDiagnostics("writer", "board", writer.page),
    pageDiagnostics("follower", "board", follower.page),
    pageDiagnostics("writer", "detail", writerDetail),
    pageDiagnostics("follower", "detail", followerDetail),
  ]);
  const browserTranscript = {
    schemaVersion: 1,
    recordedHead,
    window: "post-authentication E5-T05 board/detail activity",
    network: [
      ...transcriptNetwork("writer", writerRunNetwork),
      ...transcriptNetwork("follower", followerRunNetwork),
    ],
    console: diagnostics.flatMap((entry) => entry.console),
    pageErrors: diagnostics.flatMap((entry) => entry.pageErrors),
  };
  assert.equal(
    browserTranscript.console.filter((entry) => entry.type === "error").length,
    0,
  );
  assert.equal(browserTranscript.pageErrors.length, 0);
  const sourceCoverage = await coverageManifest(recordedHead, coverageRuns);

  await writeFile(
    resolve(evidence, "e5-t05-session.events.jsonl"),
    `${acceptedIssueRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  await writeFile(
    resolve(evidence, "e5-t05-board-projection.events.jsonl"),
    `${boardRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  await writeFile(
    resolve(evidence, "e5-t05-browser-transcript.json"),
    `${canonicalJson(browserTranscript)}\n`,
  );
  await writeFile(
    resolve(evidence, "e5-t05-browser-source-coverage.json"),
    `${canonicalJson(sourceCoverage)}\n`,
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
