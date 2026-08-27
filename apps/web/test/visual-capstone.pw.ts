import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { chromium, type Locator, type Page } from "playwright-core";

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
  const observedRoute = new URL(page.url()).pathname;
  assert.equal(observedRoute, input.route, `${input.name} route drifted`);
  const bytes = await page.screenshot({
    path: resolve(actual, input.name),
    type: "jpeg",
    quality: 92,
    animations: "disabled",
  });
  captures.push({
    ...input,
    route: observedRoute,
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

async function assertPierreTreeLayout(tree: Locator, label: string): Promise<void> {
  await tree.waitFor();
  assert.equal(await tree.getAttribute("data-tree-density"), "default", `${label} density`);
  assert.equal(await tree.getAttribute("data-tree-icons"), "minimal", `${label} icons`);
  assert.equal(
    await tree.getAttribute("data-tree-layout-repair"),
    "overflow-measure-overlay",
    `${label} layout repair`,
  );
  const layout = await tree.locator("file-tree-container").evaluate((host) => {
    const root = host.shadowRoot;
    const search = root?.querySelector<HTMLElement>("[data-file-tree-search-container]");
    const rows = Array.from(
      root?.querySelectorAll<HTMLElement>('[role="tree"] [data-type="item"]') ?? [],
    )
      .map((row) => {
        const rect = row.getBoundingClientRect();
        const content = row.querySelector<HTMLElement>('[data-item-section="content"]');
        const visibleContent =
          content?.querySelector<HTMLElement>('[data-truncate-content="visible"]') ?? content;
        return {
          label: row.getAttribute("aria-label") ?? row.textContent?.trim() ?? "",
          rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
          content:
            visibleContent === null
              ? null
              : (() => {
                  const contentRect = visibleContent.getBoundingClientRect();
                  return { top: contentRect.top, bottom: contentRect.bottom };
                })(),
          icons: Array.from(row.querySelectorAll<SVGElement>('[data-item-section="icon"] svg')).map(
            (icon) => {
              const iconRect = icon.getBoundingClientRect();
              return { top: iconRect.top, bottom: iconRect.bottom };
            },
          ),
        };
      })
      .filter((row) => row.rect.height > 0)
      .sort((left, right) => left.rect.top - right.rect.top);
    return {
      searchBottom: search?.getBoundingClientRect().bottom ?? 0,
      rows,
    };
  });
  assert.ok(layout.rows.length >= 4, `${label} must render at least four rows`);
  assert.ok(layout.rows[0]!.rect.top >= layout.searchBottom, `${label} first row overlaps search`);
  assert.equal(
    layout.rows.some((row) => row.label.includes(" / ")),
    false,
    `${label} must not flatten path segments into crowded rows`,
  );
  for (let index = 0; index < layout.rows.length; index += 1) {
    const row = layout.rows[index]!;
    assert.ok(row.rect.height >= 28, `${label} row ${row.label} is too short`);
    if (index > 0) {
      assert.ok(
        row.rect.top >= layout.rows[index - 1]!.rect.bottom - 1,
        `${label} rows overlap at ${row.label}`,
      );
    }
    if (row.content !== null) {
      const contentDiagnostic = JSON.stringify({ row: row.rect, content: row.content });
      assert.ok(
        row.content.top >= row.rect.top - 1,
        `${label} content escapes ${row.label}: ${contentDiagnostic}`,
      );
      assert.ok(
        row.content.bottom <= row.rect.bottom + 1,
        `${label} content escapes ${row.label}: ${contentDiagnostic}`,
      );
    }
    for (const icon of row.icons) {
      const iconDiagnostic = JSON.stringify({ row: row.rect, icon });
      assert.ok(
        icon.top >= row.rect.top - 1,
        `${label} icon escapes ${row.label}: ${iconDiagnostic}`,
      );
      assert.ok(
        icon.bottom <= row.rect.bottom + 1,
        `${label} icon escapes ${row.label}: ${iconDiagnostic}`,
      );
    }
  }
}

await mkdir(actual, { recursive: true });
const { child, ready } = await startPreview();
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const requestFailures: string[] = [];
const mobileInteractions: string[] = [];
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
  const desktopRepositoryTree = page.getByTestId("pierre-tree");
  assert.equal(await page.locator('[data-tree-adapter="@pierre/trees"]').count(), 1);
  await assertPierreTreeLayout(desktopRepositoryTree, "desktop repository tree");
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
  const hydratedDiff = page.locator(
    '[data-testid="pr-diff"] [data-pierre-content-state="hydrated"]',
  );
  try {
    await hydratedDiff.waitFor({ timeout: 10_000 });
  } catch (error) {
    const diagnostics = await page
      .locator('[data-testid="pr-diff"] [data-pierre-content-state]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          state: node.getAttribute("data-pierre-content-state"),
          old: node.getAttribute("data-pierre-old-content"),
          next: node.getAttribute("data-pierre-new-content"),
        })),
      );
    throw new Error(`Pierre content did not hydrate: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
  assert.ok(Number(await hydratedDiff.getAttribute("data-pierre-rendered-lines")) >= 6);
  const pierreDiff = page.locator('[data-testid="pr-diff"] diffs-container pre');
  await pierreDiff.waitFor();
  try {
    await page.waitForFunction(
      () => {
        const rendered = document.querySelector('[data-testid="pr-diff"] diffs-container');
        const root = rendered?.shadowRoot;
        const text = root?.querySelector("pre")?.textContent?.trim() ?? "";
        return (
          text.includes("Electric Forest Reading Room") &&
          (root?.querySelectorAll("[data-line]").length ?? 0) >= 6 &&
          (rendered?.getBoundingClientRect().height ?? 0) > 120
        );
      },
      undefined,
      { timeout: 5_000 },
    );
  } catch (error) {
    const rendered = await page
      .locator('[data-testid="pr-diff"] diffs-container')
      .evaluate((host) => ({
        text: host.shadowRoot?.querySelector("pre")?.textContent?.trim() ?? "",
        lines: host.shadowRoot?.querySelectorAll("[data-line]").length ?? 0,
        height: host.getBoundingClientRect().height,
      }));
    throw new Error(`Pierre rows did not render: ${JSON.stringify(rendered)}`, {
      cause: error,
    });
  }
  await assertPierreTreeLayout(
    page.locator('[data-testid="pr-diff"] [data-testid="pierre-tree"]'),
    "changed-file tree",
  );
  await capture(page, captures, {
    name: "06-pr-changes-desktop.jpg",
    route: `${new URL(ready.prUrl).pathname}/changes`,
    viewport: "desktop",
  });

  await page.getByRole("tab", { name: /Activity/ }).click();
  const mergePanel = page.locator(".pr-merge-panel");
  const composer = page.getByRole("textbox", { name: "Pull request comment" });
  const activityScroller = page.locator(".pr-detail-main");
  await mergePanel.waitFor();
  await composer.waitFor();
  await activityScroller.evaluate((scroller) => {
    const panel = scroller.querySelector<HTMLElement>(".pr-merge-panel");
    if (panel === null) return;
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        panel.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        20,
    });
  });
  await page.waitForFunction(() => {
    const scroller = document
      .querySelector<HTMLElement>(".pr-detail-main")
      ?.getBoundingClientRect();
    const panel = document.querySelector<HTMLElement>(".pr-merge-panel")?.getBoundingClientRect();
    const form = document.querySelector<HTMLElement>(".pr-comment-form")?.getBoundingClientRect();
    return (
      scroller !== undefined &&
      panel !== undefined &&
      form !== undefined &&
      panel.top >= scroller.top &&
      panel.bottom < scroller.bottom &&
      form.top < scroller.bottom
    );
  });
  await capture(page, captures, {
    name: "07-pr-activity-desktop.jpg",
    route: new URL(ready.prUrl).pathname,
    viewport: "desktop",
  });
  assert.notEqual(
    captures.find((candidate) => candidate.name === "05-pr-detail-desktop.jpg")?.sha256,
    captures.find((candidate) => candidate.name === "07-pr-activity-desktop.jpg")?.sha256,
  );

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

  await page.goto(ready.pullsUrl);
  await waitLive(page, "pr-list");
  await assertMobile(page, "Pulls");
  const drawerTrigger = page.getByRole("button", { name: "Open repository navigation" });
  await drawerTrigger.focus();
  await drawerTrigger.click();
  const drawer = page.getByRole("dialog", { name: "Repository sections" });
  await drawer.waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), "true");
  assert.ok(await page.locator("[inert]").count());
  assert.equal(await drawer.evaluate((node) => node.contains(document.activeElement)), true);
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  assert.equal(await drawerTrigger.evaluate((node) => node === document.activeElement), true);
  mobileInteractions.push("side-drawer:escape-focus-restored");

  const newPrTrigger = page.getByRole("button", { name: "New", exact: true });
  await newPrTrigger.focus();
  await newPrTrigger.click();
  const credenza = page.getByRole("dialog", { name: "New pull request" });
  await credenza.waitFor();
  assert.equal(await credenza.getAttribute("aria-modal"), "true");
  assert.ok(await page.locator("[inert]").count());
  assert.equal(await credenza.evaluate((node) => node.contains(document.activeElement)), true);
  await page.keyboard.press("Escape");
  await credenza.waitFor({ state: "hidden" });
  assert.equal(await newPrTrigger.evaluate((node) => node === document.activeElement), true);
  mobileInteractions.push("credenza:escape-focus-restored");

  const prIndex = page.getByRole("listbox", { name: "Jump to pull request" });
  await prIndex.focus();
  await prIndex.press("End");
  assert.ok(await prIndex.getAttribute("aria-activedescendant"));
  mobileInteractions.push("index-bar:keyboard-jump");

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
  const conversationIndex = page.getByRole("listbox", { name: "Jump through Activity" });
  await conversationIndex.focus();
  await conversationIndex.press("Home");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-docstream-conversation-article") === "true",
  );
  mobileInteractions.push("conversation-index:keyboard-focus-jump");
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
  const mobileRepositoryTree = page.getByTestId("pierre-tree");
  await assertPierreTreeLayout(mobileRepositoryTree, "mobile repository tree");
  await capture(page, captures, {
    name: "13-mobile-code.jpg",
    route: new URL(ready.treeUrl).pathname,
    viewport: "mobile",
  });

  assert.equal(captures.length, 13);
  const terminalLongPolls = requestFailures.filter(
    (failure) =>
      /(?:\/events(?:\?|\s)|[?&](?:live|projection)=1(?:&|\s))/.test(failure) &&
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
        mobileInteractions,
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
