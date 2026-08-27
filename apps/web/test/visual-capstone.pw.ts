import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { chromium, type Page } from "playwright-core";

interface PreviewReady {
  readonly url: string;
  readonly repoUrl: string;
  readonly treeUrl: string;
  readonly fileUrl: string;
  readonly pullsUrl: string;
  readonly prUrl: string;
  readonly issuesUrl: string;
  readonly wikiUrl: string;
}

interface Capture {
  readonly name: string;
  readonly route: string;
  readonly viewport: "desktop" | "mobile";
  readonly sha256: string;
}

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone");
const actual = resolve(task, "evidence/actual");
const transcriptPath = resolve(task, "evidence/e5-t14-browser.json");
const fixture = resolve(root, "apps/web/test/fixtures/e5-t14-preview-server.mjs");

function currentHead(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

async function startPreview(): Promise<{
  readonly child: ChildProcess;
  readonly ready: PreviewReady;
}> {
  const child = spawn(process.execPath, [fixture], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const ready = await new Promise<PreviewReady>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`E5-T14 preview timeout\n${stdout}\n${stderr}`));
    }, 90_000);
    const inspect = (): void => {
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("E5_T14_READY "));
      if (line === undefined) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(line.slice("E5_T14_READY ".length)) as PreviewReady);
    };
    child.stdout?.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`E5-T14 preview exited ${String(code)}\n${stdout}\n${stderr}`));
    });
  });
  return { child, ready };
}

async function stopPreview(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function waitLive(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).waitFor();
  await page.waitForFunction((id) => {
    const node = document.querySelector(`[data-testid="${id}"]`);
    const status = node?.getAttribute("data-stream-status");
    return status === null || status === "live";
  }, testId);
}

async function capture(
  page: Page,
  captures: Capture[],
  input: { readonly name: string; readonly route: string; readonly viewport: "desktop" | "mobile" },
): Promise<void> {
  const bytes = await page.screenshot({
    path: resolve(actual, input.name),
    type: "jpeg",
    quality: 92,
    animations: "disabled",
  });
  captures.push({
    ...input,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function assertRepositoryTabs(page: Page): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Repository" });
  for (const label of ["Code", "Pull Requests", "Issues", "Wiki", "Settings"]) {
    await nav.getByRole("link", { name: label, exact: true }).waitFor();
  }
}

async function assertMobile(page: Page, activeLabel: string): Promise<void> {
  const shell = page.locator('[data-mobile-product-shell="@brett_lamy/ui@0.0.1"]');
  await shell.waitFor();
  assert.equal(await shell.getAttribute("data-mobile-refresh"), "NavigationStack.Screen.onRefresh");
  assert.equal(
    await shell.getAttribute("data-mobile-hide-chrome"),
    "NavigationStack.Screen.hideChromeOnScroll",
  );
  const nav = page.getByRole("navigation", { name: "Repository sections" });
  for (const label of ["Code", "Pulls", "Issues", "Wiki", "Settings"]) {
    await nav.getByText(label, { exact: true }).waitFor();
  }
  await nav.getByText(activeLabel, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.equal(await page.evaluate(() => document.body.scrollWidth), 390);
}

await mkdir(actual, { recursive: true });
const { child, ready } = await startPreview();
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const requestFailures: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("requestfailed", (request) =>
  requestFailures.push(
    `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
  ),
);
const captures: Capture[] = [];

try {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(ready.url);
  await loginWithFixture(page);

  await waitLive(page, "registry-browser");
  assert.equal(await page.locator('[data-product-shell="desktop"]').count(), 1);
  await capture(page, captures, {
    name: "01-registry-desktop.jpg",
    route: "/",
    viewport: "desktop",
  });

  await page.goto(ready.treeUrl);
  await waitLive(page, "tree-browser");
  await assertRepositoryTabs(page);
  assert.equal(await page.locator('[data-tree-adapter="@pierre/trees"]').count(), 1);
  await capture(page, captures, {
    name: "02-tree-desktop.jpg",
    route: new URL(ready.treeUrl).pathname,
    viewport: "desktop",
  });

  const pullsTab = page
    .getByRole("navigation", { name: "Repository" })
    .getByRole("link", { name: "Pull Requests", exact: true });
  await pullsTab.focus();
  await pullsTab.press("Enter");
  await waitLive(page, "pr-list");

  await page.goto(ready.fileUrl);
  await waitLive(page, "file-viewer");
  await page.locator('[data-markdown-renderer="docstream"]').waitFor();
  await capture(page, captures, {
    name: "03-markdown-file-desktop.jpg",
    route: new URL(ready.fileUrl).pathname,
    viewport: "desktop",
  });

  await page.goto(ready.pullsUrl);
  await waitLive(page, "pr-list");
  await assertRepositoryTabs(page);
  await capture(page, captures, {
    name: "04-pulls-list-desktop.jpg",
    route: new URL(ready.pullsUrl).pathname,
    viewport: "desktop",
  });

  await page.goto(ready.prUrl);
  await waitLive(page, "pr-detail");
  for (const label of ["Activity", "Commits", "Checks", "Changes"]) {
    await page.getByRole("tab", { name: new RegExp(label) }).waitFor();
  }
  await page.locator('[data-markdown-renderer="docstream"]').first().waitFor();
  await capture(page, captures, {
    name: "05-pr-detail-desktop.jpg",
    route: new URL(ready.prUrl).pathname,
    viewport: "desktop",
  });

  const changesTab = page.getByRole("tab", { name: /Changes/ });
  await changesTab.focus();
  await changesTab.press("Enter");
  await page.getByTestId("pr-diff").waitFor();
  await page.locator('[data-tree-adapter="@pierre/trees"]').waitFor();
  await capture(page, captures, {
    name: "06-pr-changes-desktop.jpg",
    route: `${new URL(ready.prUrl).pathname}/changes`,
    viewport: "desktop",
  });

  await page.getByRole("tab", { name: /Activity/ }).click();
  await page.getByText("Ready to merge", { exact: true }).waitFor();
  await capture(page, captures, {
    name: "07-pr-activity-desktop.jpg",
    route: `${new URL(ready.prUrl).pathname}/activity`,
    viewport: "desktop",
  });

  await page.getByRole("tab", { name: /Commits/ }).click();
  await capture(page, captures, {
    name: "08-pr-commits-desktop.jpg",
    route: `${new URL(ready.prUrl).pathname}/commits`,
    viewport: "desktop",
  });

  await page.getByRole("tab", { name: /Checks/ }).click();
  await capture(page, captures, {
    name: "09-pr-checks-desktop.jpg",
    route: `${new URL(ready.prUrl).pathname}/checks`,
    viewport: "desktop",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ready.issuesUrl);
  await waitLive(page, "issue-board");
  await assertMobile(page, "Issues");
  await capture(page, captures, {
    name: "10-mobile-issues.jpg",
    route: new URL(ready.issuesUrl).pathname,
    viewport: "mobile",
  });

  await page.goto(ready.wikiUrl);
  await waitLive(page, "wiki-page");
  await assertMobile(page, "Wiki");
  await page.locator('[data-markdown-renderer="docstream"]').waitFor();
  await capture(page, captures, {
    name: "11-mobile-wiki.jpg",
    route: new URL(ready.wikiUrl).pathname,
    viewport: "mobile",
  });

  await page.goto(ready.prUrl);
  await waitLive(page, "pr-detail");
  await assertMobile(page, "Pulls");
  await capture(page, captures, {
    name: "12-mobile-pr-activity.jpg",
    route: new URL(ready.prUrl).pathname,
    viewport: "mobile",
  });

  await page.goto(ready.treeUrl);
  await waitLive(page, "tree-browser");
  await assertMobile(page, "Code");
  await page.locator('[data-tree-adapter="@pierre/trees"]').waitFor();
  await capture(page, captures, {
    name: "13-mobile-code.jpg",
    route: new URL(ready.treeUrl).pathname,
    viewport: "mobile",
  });

  assert.equal(captures.length, 13);
  const terminalLongPolls = requestFailures.filter(
    (failure) =>
      /(?:\/events(?:\?|\s)|[?&]live=1(?:&|\s))/.test(failure) &&
      /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure),
  );
  const unexpectedRequestFailures = requestFailures.filter(
    (failure) => !terminalLongPolls.includes(failure),
  );
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedRequestFailures, []);
  await writeFile(
    transcriptPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceHead: currentHead(),
        viewports: { desktop: [1440, 900], mobile: [390, 844], deviceScaleFactor: 1 },
        reducedMotion: true,
        captures,
        adapters: {
          markdown: "@brett_lamy/docstream",
          diffs: "@pierre/diffs",
          trees: "@pierre/trees",
          desktop: "shadcn source",
          mobile: "@brett_lamy/ui@0.0.1",
        },
        repositoryTabs: ["Code", "Pull Requests", "Issues", "Wiki", "Settings"],
        prTabs: ["Activity", "Commits", "Checks", "Changes"],
        consoleErrors,
        pageErrors,
        requestFailures: unexpectedRequestFailures,
        terminalLongPolls,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write("E5_T14_BROWSER_OK captures=13 desktop=9 mobile=4 errors=0\n");
} finally {
  await context.close();
  await browser.close();
  await stopPreview(child);
}
