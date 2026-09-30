/**
 * E5-T15 visual capstone: the web app on @brett_lamy/ui@2.0.0 + the owned github-clone /
 * discord-clone blocks, driven against the seeded E5-T14 preview world.
 *
 *   node --experimental-strip-types apps/web/test/visual-capstone.pw.ts
 *
 * Captures every product surface at 1440×900 and 390×844 into the E5-T15 task's
 * `evidence/actual/`, and asserts, in the browser that records the evidence (Replay
 * Chromium unless AGENT_BROWSER_EXECUTABLE_PATH says otherwise):
 *   - block structure per surface (global header, repo header + tabs, PR tabs, chat frame);
 *   - no block mock data on any route, including loading, empty, unknown-repo and
 *     platform-unreachable states, and seeded maple / reading-room names on every route;
 *   - at 390 px: no horizontal document scroll, code/diff panels scroll internally, and
 *     compact navigation is the package's NavigationStack / ChatShell by DOM lineage
 *     (push via links, pop via the package back control and browser history, deep links,
 *     the chat drawer), and a 1440 → 390 resize keeps the live projection;
 *   - reduced motion: a NavigationStack push lands with no intermediate frames;
 *   - keyboard: Tab / Shift+Tab reach the skip link, rail, sidebar, global header, repo
 *     tabs and PR tabs with a visible focus indicator; arrows move within each tab list;
 *   - every interactive element has an accessible name; palette contrast from the resolved
 *     CSS variables meets WCAG AA;
 *   - hostile Markdown dispatched into an issue body, a PR comment, a wiki page (saved from
 *     the editor) and a chat message renders only inside the Docstream adapter, with no
 *     active content or unsafe URL reaching the DOM;
 *   - zero console errors and page errors on the journey (the deliberately failing
 *     negative-state probes are accounted separately).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { chromium, type BrowserContext, type Page } from "playwright-core";

interface PreviewReady {
  readonly url: string;
  readonly subject: string;
}

interface Capture {
  readonly name: string;
  readonly route: string;
  readonly viewport: "desktop" | "mobile";
  readonly sha256: string;
}

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T15-bl-ui-2-rebuild");
const actual = resolve(task, "evidence/actual");
const transcriptPath = resolve(task, "evidence/e5-t15-browser.json");
const fixture = resolve(root, "apps/web/test/fixtures/e5-t14-preview-server.mjs");

const ORG = "maple";
const REPO = "reading-room";
const repoPath = `/${ORG}/${REPO}`;
const orgRepo = `/orgs/${ORG}/repos/${REPO}`;

/** Literal residue of the upstream blocks' mock data.ts files (github-clone, discord-clone). */
const MOCK_RESIDUE = [
  "acme",
  "orbit",
  "Maya Chen",
  "Alex Rivera",
  "12.4k",
  "#488",
  "#476",
  "Jobs enqueued inside a rolled-back transaction",
  "stitch",
];

const HOSTILE = [
  "Hostile corpus:",
  "",
  "[x](javascript:alert(1)) [y](//evil.example) [ref link][r] [vb](vbscript:msgbox(1))",
  "",
  "[r]: data:text/html,<script>alert(1)</script>",
  "",
  '<img src=x onerror="window.__pwned=1">',
  '<iframe srcdoc="<script>window.__pwned=2</script>"></iframe>',
  '<a href="vbscript:x">vb</a>',
  '<svg onload="window.__pwned=3"><circle r="4"></circle></svg>',
  '<a href="//evil.example/proto-relative">pr</a> <a href="JaVaScRiPt:alert(1)">mixed</a>',
  "",
  "**bold** and `code` survive.",
].join("\n");

function currentHead(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

async function startPreview(): Promise<{ child: ChildProcess; ready: PreviewReady }> {
  const child = spawn(process.execPath, [fixture], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", EF_PREVIEW_SESSION_TTL: "3600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
  const ready = await new Promise<PreviewReady>((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`preview timeout\n${stdout}\n${stderr}`)),
      120_000,
    );
    child.stdout?.on("data", () => {
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("E5_T14_READY "));
      if (line === undefined) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(line.slice("E5_T14_READY ".length)) as PreviewReady);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`preview exited ${String(code)}\n${stdout}\n${stderr}`));
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
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

/** Waits until no route or projection on the page is still loading or reconnecting. */
async function settle(page: Page, label: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let stable = 0;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(
      () =>
        document.querySelector('[data-testid="route-loading"]') !== null ||
        [...document.querySelectorAll("[data-stream-status]")].some((node) =>
          ["loading", "reconnecting"].includes(node.getAttribute("data-stream-status") ?? ""),
        ),
    );
    stable = pending ? 0 : stable + 1;
    if (stable >= 3) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`${label} did not settle`);
}

async function assertNoMock(page: Page, label: string, seeded: readonly string[]): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  for (const residue of MOCK_RESIDUE) {
    assert.equal(text.includes(residue), false, `${label} renders block mock residue "${residue}"`);
  }
  for (const token of seeded) {
    assert.ok(text.includes(token), `${label} does not render seeded "${token}"`);
  }
}

async function capture(
  page: Page,
  captures: Capture[],
  name: string,
  viewport: "desktop" | "mobile",
): Promise<void> {
  const bytes = await page.screenshot({
    path: resolve(actual, name),
    type: "jpeg",
    quality: 90,
    animations: "disabled",
  });
  captures.push({
    name,
    route: new URL(page.url()).pathname,
    viewport,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

/** The wide github frame: global header + repository header with its underline tabs. */
async function assertWideRepoFrame(page: Page, label: string): Promise<void> {
  assert.equal(await page.locator('[data-layout="wide"]').count(), 1, `${label} wide layout`);
  await page.getByRole("link", { name: "Electric Forest home" }).waitFor();
  await page.getByRole("navigation", { name: "Breadcrumb", exact: true }).waitFor();
  const tabs = page.getByRole("tablist", { name: "Repository" });
  for (const tab of ["Code", "Issues", "Pull requests", "Wiki", "Settings"]) {
    await tabs.getByRole("tab", { name: new RegExp(`^${tab}`) }).waitFor();
  }
}

/** Every chat surface sits inside the package ChatShell with its own trigger, sidebar and main. */
async function chatLineage(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const channel = document.querySelector('[data-testid="chat-channel"]');
    const shell = channel?.closest('[data-slot="chat-shell"]');
    return {
      shell: shell !== null && shell !== undefined,
      main: channel?.closest('[data-slot="chat-shell-main"]') !== null,
      trigger: shell?.querySelector('[data-slot="chat-shell-nav-trigger"]') !== null,
      sidebar: shell?.querySelector('[data-slot="chat-shell-sidebar"]') !== null,
    };
  });
}

/** Screens in the package NavigationStack that contain the given element. */
async function stackLineage(
  page: Page,
  selector: string,
): Promise<{ inStack: boolean; screens: number }> {
  return page.evaluate((target) => {
    const node = document.querySelector(target);
    const stack = node?.closest('[data-slot="navigation-stack"]');
    return {
      inStack:
        stack !== null && stack !== undefined && node?.closest('[data-slot="screen"]') !== null,
      screens:
        stack === null || stack === undefined
          ? 0
          : stack.querySelectorAll(':scope > [data-slot="screen"]').length,
    };
  }, selector);
}

/** A link on the top NavigationStack screen (lower screens stay mounted underneath it). */
function topScreenLink(page: Page, name: string) {
  return page
    .locator('[data-slot="navigation-stack"] > [data-slot="screen"]')
    .last()
    .getByRole("link", { name, exact: true })
    .first();
}

async function assertNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    widths.document <= 390,
    `${label} document scrolls horizontally: ${JSON.stringify(widths)}`,
  );
  assert.ok(widths.body <= 390, `${label} body scrolls horizontally: ${JSON.stringify(widths)}`);
}

/** True when a descendant (open shadow roots included) scrolls horizontally inside the panel. */
async function scrollsInternally(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const host = document.querySelector(target);
    if (host === null) return false;
    const stack: Element[] = [host];
    while (stack.length > 0) {
      const element = stack.pop()!;
      const style = getComputedStyle(element);
      if (
        ["auto", "scroll"].includes(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1
      ) {
        return true;
      }
      stack.push(...element.children);
      if (element.shadowRoot !== null) stack.push(...element.shadowRoot.children);
    }
    return false;
  }, selector);
}

function luminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: readonly number[], background: readonly number[]): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** Resolves CSS variables to opaque sRGB (alpha composited over --background). */
async function palette(page: Page, names: readonly string[]): Promise<Record<string, number[]>> {
  return page.evaluate((variables) => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const read = (name: string): number[] => {
      probe.style.color = `var(${name})`;
      const match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
      const parts = (match?.[1] ?? "0,0,0")
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const background = read("--background");
    const out: Record<string, number[]> = {};
    for (const name of variables) {
      const [r, g, b, a] = read(name) as [number, number, number, number];
      out[name] = [r, g, b].map((channel, index) => channel * a + background[index]! * (1 - a));
    }
    probe.remove();
    return out;
  }, names);
}

/** Interactive elements without an accessible name (visible, light-DOM only). */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [contenteditable="true"]';
    const named = (element: Element): boolean => {
      const label = element.getAttribute("aria-label")?.trim();
      if (label) return true;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (
        labelledBy &&
        labelledBy
          .split(/\s+/)
          .some((id) => (document.getElementById(id)?.textContent ?? "").trim() !== "")
      ) {
        return true;
      }
      if ((element as HTMLElement).innerText?.trim()) return true;
      if (element.getAttribute("title")?.trim()) return true;
      if (element.querySelector("img[alt]:not([alt=''])")) return true;
      if (element.querySelector("svg title")) return true;
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        if (element.labels !== null && [...element.labels].some((l) => l.textContent?.trim()))
          return true;
        if (element.getAttribute("placeholder")?.trim()) return true;
        if (
          element instanceof HTMLInputElement &&
          ["submit", "button", "reset"].includes(element.type) &&
          element.value.trim()
        )
          return true;
      }
      return false;
    };
    return [...document.querySelectorAll(selector)]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== "hidden" &&
          !element.closest("[aria-hidden='true'], [inert]")
        );
      })
      .filter((element) => !named(element))
      .map((element) => element.outerHTML.slice(0, 160));
  });
}

interface Focused {
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly testid: string;
  readonly list: string;
  readonly region: string;
  readonly visible: boolean;
}

async function focusedElement(page: Page): Promise<Focused> {
  return page.evaluate(() => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    if (element === null || element === document.body) {
      return { tag: "body", role: "", name: "", testid: "", list: "", region: "", visible: false };
    }
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== "none" && style.boxShadow !== "";
    const region = element.closest('[data-slot="chat-shell-sidebar"]')
      ? "sidebar"
      : element.closest('[aria-label="Workspaces"]')
        ? "rail"
        : element.closest('[aria-label="Breadcrumb"]') ||
            element.closest('[aria-label="Electric Forest home"]') ||
            element.getAttribute("aria-label") === "Electric Forest home"
          ? "global-header"
          : "";
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") ?? "",
      name: (element.getAttribute("aria-label") ?? (element as HTMLElement).innerText ?? "")
        .trim()
        .slice(0, 60),
      testid: element.getAttribute("data-testid") ?? "",
      list: element.closest('[role="tablist"]')?.getAttribute("aria-label") ?? "",
      region,
      visible: outline || ring,
    };
  });
}

async function dispatch(
  page: Page,
  streamId: string,
  event: { type: string; payload: unknown },
): Promise<void> {
  const result = await page.evaluate(
    async ({ streamId, event }) => {
      const response = await fetch("/api/dispatch", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-eforest-dispatch-receipt": "offset",
        },
        body: JSON.stringify({ streamId, event: { ...event, ts: Date.now() } }),
      });
      return { status: response.status, body: await response.text() };
    },
    { streamId, event },
  );
  assert.ok(
    result.status < 300,
    `dispatch ${event.type} → ${String(result.status)} ${result.body}`,
  );
}

/** Hostile Markdown reached the DOM only through the Docstream adapter, with nothing active. */
async function hostileProbe(page: Page, region: string): Promise<Record<string, unknown>> {
  return page.evaluate((selector) => {
    const regions = [...document.querySelectorAll(selector)];
    const containing = regions.filter((node) => node.textContent?.includes("Hostile corpus:"));
    const unsafe = containing.flatMap((node) => [
      ...node.querySelectorAll(
        'a[href^="javascript:" i], a[href^="data:" i], a[href^="vbscript:" i], a[href^="//"], [onerror], [onload], iframe, object, embed, script, svg[onload]',
      ),
    ]);
    const adapterWrapped = containing.every((node) =>
      [...node.querySelectorAll("*")]
        .filter(
          (child) => child.textContent?.includes("Hostile corpus:") && child.children.length === 0,
        )
        .every((leaf) => leaf.closest('[data-markdown-renderer="docstream"]') !== null),
    );
    const orphanMarkdownViews = [
      ...document.querySelectorAll('[data-slot="markdown-view"]'),
    ].filter((node) => node.closest('[data-markdown-renderer="docstream"]') === null).length;
    return {
      regions: containing.length,
      adapterWrapped,
      unsafe: unsafe.map((node) => node.outerHTML.slice(0, 120)),
      pwned: (window as unknown as { __pwned?: unknown }).__pwned ?? null,
      orphanMarkdownViews,
      boldSurvived: containing.some((node) => node.querySelector("strong") !== null),
    };
  }, region);
}

await rm(actual, { recursive: true, force: true });
await mkdir(actual, { recursive: true });
const { child, ready } = await startPreview();
const executablePath = replayChromiumPath();
const browser = await chromium.launch({ executablePath, headless: true });
const journeyConsole: string[] = [];
const journeyPageErrors: string[] = [];
const negativeConsole: string[] = [];
let negativePhase = false;
const record = (page: Page): void => {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    (negativePhase ? negativeConsole : journeyConsole).push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => journeyPageErrors.push(error.message));
};
const captures: Capture[] = [];
const report: Record<string, unknown> = {};
let context: BrowserContext | undefined;
let publicContext: BrowserContext | undefined;

try {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  record(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(new URL("/auth/login", ready.url).href);
  await loginWithFixture(page);

  /* ── 1440: every product surface, captured, with block structure and no mock residue ── */
  const desktop: readonly {
    name: string;
    path: string;
    ready: string;
    repoFrame?: boolean;
    seeded: readonly string[];
    after?: (page: Page) => Promise<void>;
  }[] = [
    {
      name: "00-personal-home.jpg",
      path: "/",
      ready: "registry-browser",
      seeded: ["Electric Forest"],
    },
    {
      name: "01-repo-list.jpg",
      path: `/organizations/${ORG}`,
      ready: "registry-browser",
      seeded: [REPO, ORG],
    },
    {
      name: "02-repo-home.jpg",
      path: repoPath,
      ready: "repository-home",
      repoFrame: true,
      seeded: ["README.md", "Electric Forest Reading Room"],
    },
    {
      name: "03-tree.jpg",
      path: `${repoPath}/tree/main`,
      ready: "tree-browser",
      repoFrame: true,
      seeded: ["apps", "packages"],
    },
    {
      name: "04-blob.jpg",
      path: `${repoPath}/blob/main/README.md`,
      ready: "file-viewer",
      repoFrame: true,
      seeded: ["README.md"],
    },
    {
      name: "05-history.jpg",
      path: `${repoPath}/history/main`,
      ready: "history-view",
      repoFrame: true,
      seeded: ["fs:maple/reading-room:main:meta"],
    },
    {
      name: "06-issues.jpg",
      path: `${orgRepo}/issues`,
      ready: "issue-board",
      repoFrame: true,
      seeded: ["visual-capstone", "docstream-policy"],
    },
    {
      name: "07-issue-detail.jpg",
      path: `${orgRepo}/issues/visual-capstone`,
      ready: "issue-detail",
      repoFrame: true,
      seeded: ["Match the supplied product references"],
    },
    {
      name: "08-pulls.jpg",
      path: `${orgRepo}/pulls`,
      ready: "pr-list",
      repoFrame: true,
      seeded: ["E5-T14: finish the visual product capstone"],
    },
    {
      name: "09-pr-activity.jpg",
      path: `${orgRepo}/pulls/60`,
      ready: "pr-detail",
      repoFrame: true,
      seeded: ["#60", "feature-product-shell"],
    },
    {
      name: "10-pr-commits.jpg",
      path: `${orgRepo}/pulls/60/commits`,
      ready: "pr-detail",
      repoFrame: true,
      seeded: ["#60"],
    },
    {
      name: "11-pr-checks.jpg",
      path: `${orgRepo}/pulls/60/checks`,
      ready: "pr-detail",
      repoFrame: true,
      seeded: ["#60"],
    },
    {
      name: "12-pr-changes.jpg",
      path: `${orgRepo}/pulls/60/changes`,
      ready: "pr-diff",
      repoFrame: true,
      seeded: ["README.md"],
      after: async (current) => {
        await current
          .locator('[data-testid="pr-diff"] [data-pierre-content-state="hydrated"]')
          .first()
          .waitFor({ timeout: 20_000 });
        assert.equal(
          await current
            .locator('[data-testid="pr-diff"] [data-tree-adapter="@pierre/trees"]')
            .count(),
          1,
        );
      },
    },
    {
      name: "13-wiki-page.jpg",
      path: `${orgRepo}/wiki/home`,
      ready: "wiki-page",
      repoFrame: true,
      seeded: ["Reading Room Wiki"],
    },
    {
      name: "14-wiki-editor.jpg",
      path: `${orgRepo}/wiki/home/edit`,
      ready: "wiki-editor",
      repoFrame: true,
      seeded: ["home.md"],
    },
    {
      name: "15-settings.jpg",
      path: `${orgRepo}/settings`,
      ready: "repository-settings",
      repoFrame: true,
      seeded: [REPO],
    },
    {
      name: "16-labels.jpg",
      path: `${orgRepo}/labels`,
      ready: "label-management",
      repoFrame: true,
      seeded: ["Labels"],
    },
    {
      name: "17-chat-run.jpg",
      path: `/chat/${ORG}/general`,
      ready: "chat-channel",
      seeded: ["general", "sol", "Worked for"],
      after: async (current) => {
        await current.getByTestId("run-accordion").first().waitFor();
        // Wide: the sidebar is docked; the drawer trigger exists only at compact widths.
        const lineage = await chatLineage(current);
        assert.deepEqual(lineage, { shell: true, main: true, trigger: false, sidebar: true });
      },
    },
    { name: "18-members.jpg", path: `/members/${ORG}`, ready: "members-page", seeded: ["sol"] },
  ];
  for (const surface of desktop) {
    await page.goto(new URL(surface.path, ready.url).href);
    await page.getByTestId(surface.ready).first().waitFor({ timeout: 30_000 });
    await settle(page, surface.path);
    if (surface.repoFrame === true) await assertWideRepoFrame(page, surface.path);
    await surface.after?.(page);
    await assertNoMock(page, `1440 ${surface.path}`, surface.seeded);
    await capture(page, captures, surface.name, "desktop");
  }
  // The PR tabs exist as the package TabView with all four tabs.
  await page.goto(new URL(`${orgRepo}/pulls/60`, ready.url).href);
  await settle(page, "pr");
  for (const tab of ["Activity", "Commits", "Checks", "Changes"]) {
    await page
      .getByRole("tablist", { name: "Pull request" })
      .getByRole("tab", { name: new RegExp(`^${tab}`) })
      .waitFor();
  }

  /* ── keyboard + visible focus with reduced motion on ── */
  await page.goto(new URL(`${orgRepo}/pulls/60`, ready.url).href);
  await settle(page, "pr keyboard");
  await page.locator("body").click({ position: { x: 700, y: 880 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const forward: Focused[] = [];
  for (let step = 0; step < 90; step += 1) {
    await page.keyboard.press("Tab");
    forward.push(await focusedElement(page));
  }
  const reached = {
    skipLink: forward.some((item) => item.name === "Skip to content"),
    rail: forward.some((item) => item.region === "rail" || item.list === "Workspaces"),
    sidebar: forward.some((item) => item.region === "sidebar"),
    globalHeader: forward.some((item) => item.region === "global-header"),
    repoTabs: forward.some((item) => item.list === "Repository" && item.role === "tab"),
    prTabs: forward.some((item) => item.list === "Pull request" && item.role === "tab"),
  };
  assert.deepEqual(
    reached,
    { skipLink: true, rail: true, sidebar: true, globalHeader: true, repoTabs: true, prTabs: true },
    JSON.stringify(forward.slice(0, 40)),
  );
  const invisible = forward.filter((item) => item.tag !== "body" && !item.visible);
  assert.deepEqual(invisible, [], "every keyboard focus stop shows a focus indicator");
  const before = await focusedElement(page);
  await page.keyboard.press("Shift+Tab");
  const back = await focusedElement(page);
  assert.notDeepEqual(back, before, "Shift+Tab moves focus backwards");
  // Arrows move within the repository tabs and the PR tabs (roving focus in the package TabView).
  const arrows: Record<string, string[]> = {};
  for (const list of ["Repository", "Pull request"]) {
    const selected = page
      .getByRole("tablist", { name: list })
      .locator('[role="tab"][aria-selected="true"]');
    await selected.focus();
    const seen = [(await focusedElement(page)).name];
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("ArrowRight");
      seen.push((await focusedElement(page)).name);
    }
    arrows[list] = seen;
    assert.ok(new Set(seen).size >= 3, `${list} arrows move focus: ${JSON.stringify(seen)}`);
    await page.goto(new URL(`${orgRepo}/pulls/60`, ready.url).href);
    await settle(page, "pr arrows");
  }
  report.keyboard = {
    reached,
    stops: forward.length,
    arrows,
    shiftTab: { from: before.name, to: back.name },
  };

  /* ── accessible names on every surface ── */
  const unnamed: Record<string, string[]> = {};
  for (const surface of desktop) {
    await page.goto(new URL(surface.path, ready.url).href);
    await page.getByTestId(surface.ready).first().waitFor({ timeout: 30_000 });
    await settle(page, surface.path);
    const missing = await unnamedControls(page);
    if (missing.length > 0) unnamed[surface.path] = missing;
  }
  assert.deepEqual(unnamed, {}, "every interactive element has an accessible name");

  /* ── WCAG AA contrast from the resolved palette ── */
  const colors = await palette(page, [
    "--background",
    "--card",
    "--popover",
    "--foreground",
    "--muted-foreground",
    "--tertiary-foreground",
    "--primary",
    "--primary-foreground",
    "--link",
    "--border",
    "--ring",
  ]);
  const ratio = (fg: string, bg: string): number =>
    Number(contrast(colors[fg]!, colors[bg]!).toFixed(2));
  const contrastReport: Record<string, number> = {};
  const contrastFailures: string[] = [];
  for (const bg of ["--background", "--card", "--popover"]) {
    for (const fg of ["--foreground", "--muted-foreground", "--tertiary-foreground"]) {
      contrastReport[`${fg} on ${bg}`] = ratio(fg, bg);
      if (ratio(fg, bg) < 4.5)
        contrastFailures.push(`${fg} on ${bg} is ${String(ratio(fg, bg))}:1 (< 4.5)`);
    }
  }
  contrastReport["--link on --background"] = ratio("--link", "--background");
  contrastReport["--primary-foreground on --primary"] = ratio("--primary-foreground", "--primary");
  contrastReport["--border on --background"] = ratio("--border", "--background");
  contrastReport["--ring on --background"] = ratio("--ring", "--background");
  const minimums: Record<string, number> = {
    "--link on --background": 4.5,
    "--primary-foreground on --primary": 4.5,
    "--border on --background": 3,
    "--ring on --background": 3,
  };
  for (const [pair, minimum] of Object.entries(minimums)) {
    if (contrastReport[pair]! < minimum)
      contrastFailures.push(`${pair} is ${String(contrastReport[pair])}:1 (< ${String(minimum)})`);
  }
  // Asserted at the end of the run so every later check still executes and is reported.
  report.contrastColors = colors;
  report.contrastFailures = contrastFailures;
  report.contrast = contrastReport;

  /* ── resize 1440 → 390 mid-session keeps the same document and the live projection ── */
  await page.goto(new URL(`${orgRepo}/pulls/60`, ready.url).href);
  await settle(page, "resize");
  const offsetWide = await page.getByTestId("pr-detail").getAttribute("data-ef-offset");
  await page.evaluate(
    () => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-layout="phone"]').waitFor();
  await settle(page, "resized");
  assert.equal(
    await page.evaluate(
      () => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true,
    ),
    true,
  );
  assert.equal(
    await page.getByTestId("pr-detail").first().getAttribute("data-ef-offset"),
    offsetWide,
  );
  assert.equal((await stackLineage(page, '[data-testid="pr-detail"]')).inStack, true);
  report.resize = { offset: offsetWide, sameDocument: true };

  /* ── 390: the same workflows through the package's compact navigation ── */
  const mobile: readonly {
    name: string;
    path: string;
    ready: string;
    seeded: readonly string[];
    stack: boolean;
    screens?: number;
  }[] = [
    {
      name: "20-mobile-repo-list.jpg",
      path: `/organizations/${ORG}`,
      ready: "registry-browser",
      seeded: [REPO],
      stack: true,
    },
    {
      name: "21-mobile-repo-home.jpg",
      path: repoPath,
      ready: "repository-home",
      seeded: ["README.md"],
      stack: true,
      screens: 1,
    },
    {
      name: "22-mobile-tree.jpg",
      path: `${repoPath}/tree/main/apps`,
      ready: "tree-browser",
      seeded: ["web"],
      stack: true,
    },
    {
      name: "23-mobile-blob.jpg",
      path: `${repoPath}/blob/main/apps/web/product.ts`,
      ready: "file-content",
      seeded: ["product.ts"],
      stack: true,
    },
    {
      name: "24-mobile-history.jpg",
      path: `${repoPath}/history/main`,
      ready: "history-view",
      seeded: ["fs:maple/reading-room:main:meta"],
      stack: true,
    },
    {
      name: "25-mobile-issues.jpg",
      path: `${orgRepo}/issues`,
      ready: "issue-board",
      seeded: ["visual-capstone"],
      stack: true,
    },
    {
      name: "26-mobile-issue.jpg",
      path: `${orgRepo}/issues/visual-capstone`,
      ready: "issue-detail",
      seeded: ["Match the supplied product references"],
      stack: true,
    },
    {
      name: "27-mobile-pulls.jpg",
      path: `${orgRepo}/pulls`,
      ready: "pr-list",
      seeded: ["E5-T14: finish the visual product capstone"],
      stack: true,
    },
    {
      name: "28-mobile-pr.jpg",
      path: `${orgRepo}/pulls/60`,
      ready: "pr-detail",
      seeded: ["#60"],
      stack: true,
    },
    {
      name: "29-mobile-pr-changes.jpg",
      path: `${orgRepo}/pulls/60/changes`,
      ready: "pr-diff",
      seeded: ["README.md"],
      stack: true,
    },
    {
      name: "30-mobile-wiki.jpg",
      path: `${orgRepo}/wiki/home`,
      ready: "wiki-page",
      seeded: ["Reading Room Wiki"],
      stack: true,
    },
    {
      name: "31-mobile-wiki-editor.jpg",
      path: `${orgRepo}/wiki/home/edit`,
      ready: "wiki-editor",
      seeded: ["home.md"],
      stack: true,
    },
    {
      name: "32-mobile-settings.jpg",
      path: `${orgRepo}/settings`,
      ready: "repository-settings",
      seeded: [REPO],
      stack: true,
    },
    {
      name: "33-mobile-labels.jpg",
      path: `${orgRepo}/labels`,
      ready: "label-management",
      seeded: ["Labels"],
      stack: true,
    },
    {
      name: "34-mobile-members.jpg",
      path: `/members/${ORG}`,
      ready: "members-page",
      seeded: ["sol"],
      stack: true,
    },
    {
      name: "35-mobile-chat.jpg",
      path: `/chat/${ORG}/general`,
      ready: "chat-channel",
      seeded: ["general", "Worked for"],
      stack: false,
    },
  ];
  const mobileLineage: Record<string, unknown> = {};
  for (const surface of mobile) {
    await page.goto(new URL(surface.path, ready.url).href);
    await page.getByTestId(surface.ready).first().waitFor({ timeout: 30_000 });
    await settle(page, `390 ${surface.path}`);
    if (surface.ready === "pr-diff") {
      await page
        .locator('[data-testid="pr-diff"] [data-pierre-content-state="hydrated"]')
        .first()
        .waitFor({ timeout: 20_000 });
    }
    await assertNoHorizontalScroll(page, `390 ${surface.path}`);
    await assertNoMock(page, `390 ${surface.path}`, surface.seeded);
    if (surface.stack) {
      const lineage = await stackLineage(page, `[data-testid="${surface.ready}"]`);
      assert.equal(
        lineage.inStack,
        true,
        `390 ${surface.path} renders inside the package NavigationStack`,
      );
      if (surface.screens !== undefined) assert.equal(lineage.screens, surface.screens);
      mobileLineage[surface.path] = lineage;
    } else {
      const lineage = await chatLineage(page);
      assert.deepEqual(lineage, { shell: true, main: true, trigger: true, sidebar: true });
      mobileLineage[surface.path] = lineage;
    }
    await capture(page, captures, surface.name, "mobile");
  }
  report.mobileLineage = mobileLineage;

  // Code and diff panels scroll inside themselves, never the document.
  await page.goto(new URL(`${orgRepo}/pulls/60/changes`, ready.url).href);
  await page
    .locator('[data-testid="pr-diff"] [data-pierre-content-state="hydrated"]')
    .first()
    .waitFor({ timeout: 20_000 });
  await settle(page, "390 diff");
  assert.equal(
    await scrollsInternally(page, '[data-testid="pr-diff"]'),
    true,
    "390 pr-diff scrolls internally",
  );
  await page.goto(new URL(`${repoPath}/blob/main/apps/web/product.ts`, ready.url).href);
  await page.getByTestId("file-content").first().waitFor();
  await settle(page, "390 blob");
  const blob = await page
    .getByTestId("file-content")
    .first()
    .evaluate((node) => ({
      overflowX: getComputedStyle(node).overflowX,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
  assert.ok(
    ["auto", "scroll"].includes(blob.overflowX),
    `file-content overflow-x ${blob.overflowX}`,
  );
  assert.ok(
    blob.scrollWidth > blob.clientWidth,
    `file-content long line scrolls: ${JSON.stringify(blob)}`,
  );
  const blobOverflow = blob;
  report.internalScroll = { prDiff: true, fileContentOverflowX: blobOverflow };

  /* ── NavigationStack push / pop (links, package back control, browser history, deep link) ── */
  await page.goto(new URL(repoPath, ready.url).href);
  await page.getByTestId("repository-home").waitFor();
  await settle(page, "390 push root");
  const screensAtRoot = (await stackLineage(page, '[data-testid="repository-home"]')).screens;
  // Sample the pushed screen's transform on every frame for ~40 frames. Reduced motion: the
  // screen goes from off-screen to its final position with no intermediate positions. The same
  // push with motion allowed is the sensitivity control (it must show intermediate frames).
  const installSampler = () =>
    page.evaluate(() => {
      const stack = document.querySelector('[data-slot="navigation-stack"]')!;
      const samples: string[] = [];
      (window as unknown as { __pushSamples: string[] }).__pushSamples = samples;
      const initial = stack.querySelectorAll(':scope > [data-slot="screen"]').length;
      const observer = new MutationObserver(() => {
        const screens = stack.querySelectorAll(':scope > [data-slot="screen"]');
        const top = screens[screens.length - 1] as HTMLElement | undefined;
        if (top === undefined || screens.length <= initial) return;
        observer.disconnect();
        let frames = 0;
        const sample = (): void => {
          samples.push(getComputedStyle(top).transform);
          frames += 1;
          if (frames < 40) requestAnimationFrame(sample);
        };
        sample();
      });
      observer.observe(stack, { childList: true });
    });
  const pushAndSample = async (): Promise<string[]> => {
    await installSampler();
    await topScreenLink(page, "README.md").click();
    await page.getByTestId("file-viewer").first().waitFor();
    await page.waitForFunction(
      () => (window as unknown as { __pushSamples: string[] }).__pushSamples.length >= 40,
    );
    return page.evaluate(() => (window as unknown as { __pushSamples: string[] }).__pushSamples);
  };
  const translateX = (matrix: string): number =>
    Number(/matrix\(([^)]+)\)/.exec(matrix)?.[1]?.split(",")[4] ?? 0);
  const pushSamples = await pushAndSample();
  const settledTransform = pushSamples.at(-1)!;
  const intermediate = pushSamples.filter((sample) => {
    const x = Math.abs(translateX(sample));
    return x > 0.5 && x < 380;
  });
  assert.equal(
    translateX(settledTransform),
    0,
    `pushed screen settles on-screen: ${settledTransform}`,
  );
  assert.deepEqual(
    intermediate,
    [],
    `reduced-motion push has intermediate frames: ${JSON.stringify(pushSamples)}`,
  );
  const screensAfterPush = (await stackLineage(page, '[data-testid="file-viewer"]')).screens;
  assert.ok(
    screensAfterPush > screensAtRoot,
    `push adds a screen (${String(screensAtRoot)} → ${String(screensAfterPush)})`,
  );
  // Pop with the package's own back control on the top screen.
  // The package back control is named for the previous screen (or "Back" when it is narrow).
  const screenLabels = await page
    .locator('[data-slot="navigation-stack"] > [data-slot="screen"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-screen-label") ?? ""));
  const previousTitle = screenLabels.at(-2) ?? "Back";
  const topScreen = page.locator('[data-slot="navigation-stack"] > [data-slot="screen"]').last();
  await topScreen
    .getByRole("button", {
      name: new RegExp(`^(${previousTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|Back)$`),
    })
    .first()
    .click();
  // The back control pops to the parent level's route (the stack is the URL's hierarchy).
  await page.waitForURL((url) => url.pathname === `${repoPath}/tree/main`);
  await page.getByTestId("tree-browser").first().waitFor();
  const afterBackControl = new URL(page.url()).pathname;
  // The exiting screen stays mounted (a ghost) until the package's exit timer clears it.
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-slot="navigation-stack"] > [data-slot="screen"]').length <
      count,
    screensAfterPush,
    { timeout: 5_000 },
  );
  const screensAfterPop = (await stackLineage(page, '[data-testid="tree-browser"]')).screens;
  assert.ok(
    screensAfterPop < screensAfterPush,
    `pop removes a screen (${String(screensAfterPush)} → ${String(screensAfterPop)})`,
  );
  // Push again from the tree, then pop with browser history.
  await topScreenLink(page, "README.md").click();
  await page.getByTestId("file-viewer").first().waitFor();
  await page.goBack();
  await page.getByTestId("tree-browser").first().waitFor();
  const afterHistoryBack = new URL(page.url()).pathname;
  assert.equal(afterHistoryBack, `${repoPath}/tree/main`);
  // Sensitivity control: the same push with motion allowed tweens through intermediate frames.
  await page.goto(new URL(repoPath, ready.url).href);
  await page.getByTestId("repository-home").waitFor();
  await settle(page, "390 motion control");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  const motionSamples = await pushAndSample();
  const motionIntermediate = motionSamples.filter((sample) => {
    const x = Math.abs(translateX(sample));
    return x > 0.5 && x < 380;
  }).length;
  assert.ok(
    motionIntermediate > 0,
    `motion-allowed push shows intermediate frames: ${JSON.stringify(motionSamples)}`,
  );
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  // Deep link straight to a nested route: the stack is built from the URL.
  await page.goto(new URL(`${repoPath}/blob/main/apps/web/product.ts`, ready.url).href);
  await page.getByTestId("file-viewer").first().waitFor();
  await settle(page, "390 deep link");
  const deepScreens = (await stackLineage(page, '[data-testid="file-viewer"]')).screens;
  assert.ok(deepScreens >= 2, `deep link builds a stack (${String(deepScreens)} screens)`);
  report.navigationStack = {
    screensAtRoot,
    screensAfterPush,
    screensAfterPop,
    reducedMotionDistinct: [...new Set(pushSamples)],
    settledTransform,
    motionAllowedIntermediateFrames: motionIntermediate,
    afterBackControl,
    afterHistoryBack,
    deepScreens,
  };

  /* ── ChatShell drawer at 390 (pointer and keyboard) ── */
  await page.goto(new URL(`/chat/${ORG}/general`, ready.url).href);
  await page.getByTestId("chat-channel").waitFor();
  await settle(page, "390 chat drawer");
  const sidebarVisible = () =>
    page.evaluate(() => {
      const sidebar = document.querySelector("[data-frame-sidebar]");
      if (sidebar === null) return false;
      const box = sidebar.getBoundingClientRect();
      return box.right > 40 && box.left < 390 && getComputedStyle(sidebar).visibility !== "hidden";
    });
  const focusInSidebar = () =>
    page.evaluate(
      () =>
        document.activeElement?.closest("[data-frame-sidebar]") !== null &&
        document.activeElement !== null,
    );
  const focusOnTrigger = () =>
    page.evaluate(
      () => document.activeElement?.getAttribute("data-slot") === "chat-shell-nav-trigger",
    );
  const closedBefore = !(await sidebarVisible());
  // Pointer: the package trigger opens the package drawer; focus moves into the sidebar.
  await page.locator('[data-slot="chat-shell-nav-trigger"]').click();
  await page.waitForFunction(() => {
    const box = document.querySelector("[data-frame-sidebar]")?.getBoundingClientRect();
    return box !== undefined && box.right > 40 && box.left < 390;
  });
  const focusMovedIn = await focusInSidebar();
  await capture(page, captures, "36-mobile-chat-drawer.jpg", "mobile");
  // Escape closes it and returns focus to the trigger.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const box = document.querySelector("[data-frame-sidebar]")?.getBoundingClientRect();
    return box === undefined || box.right <= 40;
  });
  const closedByEscape = !(await sidebarVisible());
  const focusReturned = await focusOnTrigger();
  // Keyboard only: Enter on the trigger opens it again, Tab moves within it, Enter follows a link.
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const box = document.querySelector("[data-frame-sidebar]")?.getBoundingClientRect();
    return box !== undefined && box.right > 40;
  });
  const openedByKeyboard = (await sidebarVisible()) && (await focusInSidebar());
  await page.locator("[data-frame-sidebar]").getByTestId("codebase-tab").focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname.startsWith(`/organizations/${ORG}`));
  await page.getByTestId("registry-browser").waitFor();
  await page.waitForFunction(() => {
    const box = document.querySelector("[data-frame-sidebar]")?.getBoundingClientRect();
    return box === undefined || box.right <= 40;
  });
  const closedOnNavigation = !(await sidebarVisible());
  report.chatDrawer = {
    closedBefore,
    focusMovedIn,
    closedByEscape,
    focusReturned,
    openedByKeyboard,
    navigatedFromDrawer: new URL(page.url()).pathname,
    closedOnNavigation,
  };
  assert.deepEqual(
    {
      closedBefore,
      focusMovedIn,
      closedByEscape,
      focusReturned,
      openedByKeyboard,
      closedOnNavigation,
    },
    {
      closedBefore: true,
      focusMovedIn: true,
      closedByEscape: true,
      focusReturned: true,
      openedByKeyboard: true,
      closedOnNavigation: true,
    },
  );

  /* ── negative states: loading, empty, unknown repo, unreachable platform ── */
  negativePhase = true;
  const negative: Record<string, string> = {};
  await page.setViewportSize({ width: 1440, height: 900 });
  // Loading: hold every projection request so the loading branches render.
  await page.route("**/api/repos/**", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
    await route.continue().catch(() => undefined);
  });
  await page.goto(new URL(repoPath, ready.url).href);
  await page.waitForTimeout(600);
  await assertNoMock(page, "loading repo home", []);
  negative.loading = "repo home while projections are held";
  await page.unroute("**/api/repos/**");
  // Empty repositories and empty sections.
  for (const path of [
    `/${ORG}/mobile-kit`,
    `/orgs/${ORG}/repos/mobile-kit/wiki`,
    `/orgs/${ORG}/repos/mobile-kit/labels`,
    `/orgs/${ORG}/repos/mobile-kit/issues`,
    `/orgs/${ORG}/repos/mobile-kit/pulls`,
  ]) {
    await page.goto(new URL(path, ready.url).href);
    await page.waitForTimeout(1_500);
    await assertNoMock(page, path, []);
    negative[path] = "empty";
  }
  // Unknown repository and unknown route.
  for (const path of [`/${ORG}/unknown-repo`, "/lost/deep/trail", `${orgRepo}/wiki/missing-page`]) {
    await page.goto(new URL(path, ready.url).href);
    await page.waitForTimeout(1_500);
    await assertNoMock(page, path, []);
    negative[path] = "unknown";
  }
  // Platform unreachable: every API request fails.
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.route("**/registry/**", (route) => route.abort("connectionrefused"));
  await page.goto(new URL(`${orgRepo}/pulls/60`, ready.url).href);
  await page.waitForTimeout(2_500);
  await assertNoMock(page, "platform unreachable", []);
  negative.unreachable = "every /api and /registry request aborted";
  await page.unroute("**/api/**");
  await page.unroute("**/registry/**");
  negativePhase = false;
  report.negative = negative;

  /* ── hostile Markdown on the four surfaces ── */
  await dispatch(page, `issue:${ORG}/${REPO}/hostile-markdown`, {
    type: "issue.opened",
    payload: { v: 1, title: "Hostile Markdown body", body: HOSTILE },
  });
  await dispatch(page, `pr:${ORG}/${REPO}/60`, {
    type: "pr.review-comment",
    payload: { v: 2, author: ready.subject, body: HOSTILE },
  });
  await dispatch(page, `chat:${ORG}/general`, {
    type: "chat.message.post",
    payload: { v: 1, id: "hostile-markdown", body: HOSTILE },
  });
  // The wiki page goes through the real create + editor save path.
  await page.goto(new URL(`${orgRepo}/wiki`, ready.url).href);
  await page.getByTestId("wiki-index").waitFor();
  await settle(page, "wiki index");
  await page.getByTestId("wiki-new-slug").fill("hostile-markdown");
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  await page.getByTestId("wiki-source").waitFor();
  await page.getByTestId("wiki-source").fill(HOSTILE);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForTimeout(1_000);
  const hostile: Record<string, Record<string, unknown>> = {};
  for (const [surface, path, region] of [
    ["issue-body", `${orgRepo}/issues/hostile-markdown`, '[data-testid="issue-detail"]'],
    ["pr-comment", `${orgRepo}/pulls/60`, '[data-testid="pr-detail"]'],
    ["wiki-page", `${orgRepo}/wiki/hostile-markdown`, '[data-testid="wiki-page"]'],
    ["chat-message", `/chat/${ORG}/general`, '[data-testid="chat-channel"]'],
  ] as const) {
    await page.goto(new URL(path, ready.url).href);
    await page.locator(region).first().waitFor({ timeout: 30_000 });
    await settle(page, `hostile ${surface}`);
    await page.getByText("Hostile corpus:").first().waitFor({ timeout: 15_000 });
    const probe = await hostileProbe(page, region);
    hostile[surface] = probe;
    assert.deepEqual(
      {
        adapterWrapped: probe.adapterWrapped,
        unsafe: probe.unsafe,
        pwned: probe.pwned,
        orphanMarkdownViews: probe.orphanMarkdownViews,
        boldSurvived: probe.boldSurvived,
      },
      { adapterWrapped: true, unsafe: [], pwned: null, orphanMarkdownViews: 0, boldSurvived: true },
      `${surface} hostile Markdown`,
    );
    if (surface === "pr-comment")
      await capture(page, captures, "37-hostile-pr-comment.jpg", "desktop");
  }
  report.hostileMarkdown = hostile;

  /* ── the public landing, signed out ── */
  publicContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const landing = await publicContext.newPage();
  record(landing);
  await landing.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await landing.goto(new URL("/", ready.url).href);
  await landing.getByTestId("public-site").waitFor();
  await landing.getByTestId("hero-login").waitFor();
  await assertNoMock(landing, "public landing", ["electric forest", "with the git ripped out."]);
  await capture(landing, captures, "19-public-landing.jpg", "desktop");
  await landing.setViewportSize({ width: 390, height: 844 });
  await landing.waitForTimeout(400);
  await assertNoHorizontalScroll(landing, "390 public landing");
  await capture(landing, captures, "38-mobile-public-landing.jpg", "mobile");

  assert.deepEqual(journeyConsole, [], "journey console errors");
  assert.deepEqual(journeyPageErrors, [], "journey page errors");
  await writeFile(
    transcriptPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceHead: currentHead(),
        browser: { executablePath, version: browser.version() },
        viewports: { desktop: [1440, 900], mobile: [390, 844] },
        reducedMotion: true,
        captures,
        ...report,
        journeyConsoleErrors: journeyConsole,
        journeyPageErrors,
        negativeStateConsoleErrors: negativeConsole,
      },
      null,
      2,
    )}\n`,
  );
  assert.deepEqual(report.contrastFailures, [], "WCAG AA palette contrast");
  process.stdout.write(
    `E5_T15_BROWSER_OK captures=${String(captures.length)} desktop=${String(captures.filter((c) => c.viewport === "desktop").length)} mobile=${String(captures.filter((c) => c.viewport === "mobile").length)} console=0 pageerrors=0 browser=${browser.version()}\n`,
  );
} finally {
  await context?.close().catch(() => undefined);
  await publicContext?.close().catch(() => undefined);
  await browser.close();
  await stopPreview(child);
}
