// E5-T15 browser fallback: the four named Replay QA journeys (J1-J4 in work/final/journeys/)
// driven headlessly in Replay Chromium against a freshly seeded preview world, because the
// Replay QA project is paused (budget_exhausted). Every step goes through the real UI
// (pointer/keyboard) and dispatch door; console errors, page errors and 5xx responses are
// collected per page. Writes a JSON transcript to argv[2].
//
//   node work/final/fallback-journeys.mjs <out.json>
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../../../../..");
const out = process.argv[2];
const browserPath =
  process.env.AGENT_BROWSER_EXECUTABLE_PATH ??
  resolve(homedir(), ".replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium");

const child = spawn(process.execPath, ["apps/web/test/fixtures/e5-t14-preview-server.mjs"], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "test", EF_PREVIEW_SESSION_TTL: "3600" },
  stdio: ["ignore", "pipe", "ignore"],
});
let buffered = "";
const ready = await new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error("preview timeout")), 120_000);
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const line = buffered.split("\n").find((l) => l.startsWith("E5_T14_READY "));
    if (line) {
      clearTimeout(timer);
      resolveReady(JSON.parse(line.slice("E5_T14_READY ".length)));
    }
  });
});
const BASE = ready.url;
const R = "/orgs/maple/repos/reading-room";
const MOCK = ["acme", "orbit", "Maya Chen", "Alex Rivera", "12.4k", "#488", "#476", "stitch"];
const HOSTILE =
  'Hostile [x](javascript:alert(1)) [y](//evil.example) [vb](vbscript:msgbox(1)) <img src=x onerror="window.__pwned=1"> <iframe srcdoc="<script>window.__pwned=2</script>"></iframe> <script>window.__pwned=3</script> **bold survives**';

const browser = await chromium.launch({ executablePath: browserPath });
const version = browser.version();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const problems = [];
const dialogs = [];
function watch(page, tag) {
  page.on("console", (m) => {
    if (m.type() === "error") problems.push({ step: current, tag, kind: "console", text: m.text() });
  });
  page.on("pageerror", (e) => problems.push({ step: current, tag, kind: "pageerror", text: String(e), stack: String(e.stack ?? "").slice(0, 1500) }));
  page.on("response", (r) => {
    if (r.status() === 404) problems.push({ step: current, tag, kind: "404-url", text: `${r.request().method()} ${r.url()}` });
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push({ step: current, tag, kind: "5xx", text: `${r.status()} ${r.url()}` });
  });
  page.on("dialog", (d) => {
    dialogs.push({ tag, type: d.type(), message: d.message() });
    void (d.type() === "confirm" ? d.accept() : d.dismiss());
  });
  return page;
}
const steps = [];
let current = "login";
async function step(journey, name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(`${journey} ${name}`)) return;
  const started = Date.now();
  current = `${journey} ${name}`;
  try {
    const detail = await fn();
    steps.push({ journey, name, ok: true, ms: Date.now() - started, detail: detail ?? null });
    console.log(`PASS ${journey} ${name}`);
  } catch (error) {
    steps.push({ journey, name, ok: false, ms: Date.now() - started, error: String(error).slice(0, 600) });
    console.log(`FAIL ${journey} ${name}: ${String(error).slice(0, 300)}`);
  }
}
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
async function noMock(page) {
  const text = await page.locator("body").innerText();
  const hits = MOCK.filter((m) => text.includes(m));
  expect(hits.length === 0, `mock residue ${hits.join(",")}`);
}
async function noHorizontalScroll(page) {
  const [sw, cw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(sw <= cw, `document scrolls horizontally ${sw} > ${cw}`);
}
async function go(page, path, testId) {
  await page.goto(BASE + path);
  await page.getByTestId(testId).first().waitFor({ timeout: 45_000 });
}
async function hostileInert(page, region) {
  return await page.evaluate((selector) => {
    const scope = document.querySelectorAll(selector);
    const last = scope[scope.length - 1];
    if (!last) return { found: false };
    const unsafe = [...last.querySelectorAll("a[href]")]
      .map((a) => a.getAttribute("href"))
      .filter((h) => /^\s*(javascript|vbscript|data):/i.test(h ?? ""));
    return {
      found: true,
      unsafe,
      imgs: last.querySelectorAll("img[onerror], img[src='x']").length,
      iframes: last.querySelectorAll("iframe").length,
      scripts: last.querySelectorAll("script").length,
      bold: [...last.querySelectorAll("strong, b")].some((b) => b.textContent === "bold survives"),
      pwned: window.__pwned ?? null,
    };
  }, region);
}

const A = watch(await context.newPage(), "A");
await A.goto(`${BASE}/auth/login`);
await A.locator("button", { hasText: ready.subject }).first().click();
await A.waitForURL((u) => u.origin === BASE && !u.pathname.startsWith("/auth"), { timeout: 30_000 });

/* ── J1 desktop walkthrough, merge watched by a second tab, chat ── */
await step("J1", "repo list + filter", async () => {
  await go(A, "/organizations/maple", "registry-browser");
  for (const r of ["docstream-demo", "forest-cli", "mobile-kit", "reading-room", "stream-lab"])
    await A.getByText(`maple/${r}`).first().waitFor();
  await A.getByPlaceholder("Find repository…").fill("read");
  await A.waitForTimeout(500);
  const visible = await A.getByText("maple/stream-lab").count();
  await A.getByPlaceholder("Find repository…").fill("");
  await noMock(A);
  return { streamLabVisibleWhileFiltered: visible };
});
await step("J1", "repo home via link", async () => {
  await A.getByText("maple/reading-room").first().click();
  await A.getByTestId("repository-home").waitFor({ timeout: 45_000 });
  for (const tab of ["Code", "Issues", "Pull requests", "Wiki", "Settings"])
    await A.getByRole("tab", { name: tab }).or(A.getByRole("link", { name: tab })).first().waitFor();
  await noMock(A);
  return { url: A.url() };
});
await step("J1", "tree, blob, history", async () => {
  await go(A, "/maple/reading-room/tree/main/apps", "tree-browser");
  await go(A, "/maple/reading-room/blob/main/apps/web/product.ts", "file-viewer");
  await A.getByText("Electric Forest").first().waitFor();
  await go(A, "/maple/reading-room/blob/main/README.md", "file-viewer");
  await go(A, "/maple/reading-room/history/main", "history-view");
  await noMock(A);
});
await step("J1", "issues list + detail", async () => {
  await go(A, `${R}/issues`, "issue-board");
  await go(A, `${R}/issues/visual-capstone`, "issue-detail");
  await A.getByTestId("issue-body").waitFor();
  await noMock(A);
});
await step("J1", "PR list, PR tabs by keyboard, Changes diff", async () => {
  await go(A, `${R}/pulls`, "pr-list");
  await A.waitForFunction(() => /4\s*Open/.test(document.querySelector('[data-testid="pr-list"]')?.textContent ?? ""), null, { timeout: 30_000 });
  const listText = await A.getByTestId("pr-list").innerText();
  expect(/4\s*Open/.test(listText) && /1\s*Closed/.test(listText), "expected 4 Open / 1 Closed");
  await go(A, `${R}/pulls/60`, "pr-detail");
  const activity = A.getByRole("tab", { name: /Activity/ });
  await activity.focus();
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    await A.keyboard.press("ArrowRight");
    seen.push(await A.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
  }
  await A.getByRole("tab", { name: /Changes/ }).click();
  await A.getByTestId("pr-diff").waitFor({ timeout: 45_000 });
  return { arrowFocus: seen };
});
await step("J1", "merge refused without evidence, attach Replay, merge seen live in tab B", async () => {
  const url = `${BASE}${R}/pulls/58`;
  await A.goto(url);
  const B = watch(await context.newPage(), "B");
  await B.goto(url);
  await A.getByText("Ready to merge").waitFor({ timeout: 45_000 });
  await B.getByText("Ready to merge").waitFor({ timeout: 45_000 });
  await A.getByRole("button", { name: "Merge", exact: true }).click();
  await A.getByRole("alert").filter({ hasText: "pr/merge-evidence-missing" }).waitFor({ timeout: 20_000 });
  await A.getByTestId("attachment-replay-url").fill(
    "https://app.replay.io/recording/5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  );
  await A.getByTestId("attachment-replay-submit").click();
  await B.getByText("5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  const linkLiveInB = (await B.getByText("5f0c1a2b", { exact: false }).count()) > 0;
  await A.waitForTimeout(1500);
  await A.getByRole("button", { name: "Merge", exact: true }).click();
  const t0 = Date.now();
  await B.getByText("merged this pull request").first().waitFor({ timeout: 30_000 });
  const convergedMs = Date.now() - t0;
  const bNavigations = await B.evaluate(() => performance.getEntriesByType("navigation").length);
  await B.getByRole("tab", { name: "Pull requests" }).or(B.getByRole("link", { name: "Pull requests" })).first().click();
  await B.getByTestId("pr-list").waitFor();
  await B.waitForFunction(() => /3\s*Open/.test(document.querySelector('[data-testid="pr-list"]')?.textContent ?? ""), null, { timeout: 20_000 });
  const listText = await B.getByTestId("pr-list").innerText();
  await B.close();
  return { convergedMs, linkLiveInB, bNavigations, list: listText.slice(0, 120) };
});
await step("J1", "chat: agent run accordion, message live in second tab both ways", async () => {
  await go(A, "/chat/maple/general", "chat-channel");
  const run = A.getByTestId("run-accordion").first();
  await run.waitFor({ timeout: 30_000 });
  await run.locator("button, summary, [role=button]").first().click();
  const C = watch(await context.newPage(), "C");
  await go(C, "/chat/maple/general", "chat-channel");
  const composerA = A.getByTestId("chat-composer").locator("[contenteditable=true]").first();
  await composerA.click();
  await A.keyboard.type("hello from journey **bold**");
  await A.keyboard.press("Enter");
  await C.getByText("hello from journey").first().waitFor({ timeout: 30_000 });
  const composerC = C.getByTestId("chat-composer").locator("[contenteditable=true]").first();
  await composerC.click();
  await C.keyboard.type("reply from tab two");
  await C.keyboard.press("Enter");
  await A.getByText("reply from tab two").first().waitFor({ timeout: 30_000 });
  await C.close();
  await noMock(A);
});

/* ── J2 compact 390: resize, NavigationStack push/pop, deep links, drawer ── */
await step("J2", "1440 -> 390 resize keeps the PR without reload", async () => {
  await go(A, `${R}/pulls/60`, "pr-detail");
  const before = await A.evaluate(() => performance.timeOrigin);
  await A.setViewportSize({ width: 390, height: 844 });
  await A.getByTestId("pr-detail").first().waitFor();
  const after = await A.evaluate(() => performance.timeOrigin);
  await noHorizontalScroll(A);
  expect(before === after, "document reloaded");
});
await step("J2", "push via taps, pop via package back and history", async () => {
  await go(A, "/organizations/maple", "registry-browser");
  await A.getByText("maple/reading-room").first().click();
  await A.getByTestId("repository-home").waitFor({ timeout: 45_000 });
  await go(A, "/maple/reading-room/tree/main", "tree-browser");
  const screens = () => A.locator('[data-slot="navigation-stack"] > [data-slot="screen"]').count();
  const atRoot = await screens();
  await A.locator('[data-slot="navigation-stack"] > [data-slot="screen"]').last().getByRole("link", { name: "apps", exact: true }).click();
  await A.waitForURL(/tree\/main\/apps/);
  const pushed = await screens();
  const labels = await A.locator('[data-slot="navigation-stack"] > [data-slot="screen"]').evaluateAll((n) => n.map((x) => x.getAttribute("data-screen-label") ?? ""));
  const previous = (labels.at(-2) ?? "Back").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await A.locator('[data-slot="navigation-stack"] > [data-slot="screen"]').last().getByRole("button", { name: new RegExp(`^(${previous}|Back)$`) }).first().click();
  await A.waitForURL((u) => u.pathname === "/maple/reading-room/tree/main");
  await A.waitForTimeout(1200);
  await A.locator('[data-slot="navigation-stack"] > [data-slot="screen"]').last().getByRole("link", { name: "apps", exact: true }).click();
  await A.waitForURL(/tree\/main\/apps/);
  await A.goBack();
  await A.waitForURL((u) => u.pathname === "/maple/reading-room/tree/main");
  await noHorizontalScroll(A);
  return { atRoot, pushed };
});
await step("J2", "deep links at 390 scroll code/diff internally", async () => {
  await go(A, "/maple/reading-room/blob/main/apps/web/product.ts", "file-viewer");
  await noHorizontalScroll(A);
  await go(A, `${R}/pulls/60/changes`, "pr-diff");
  await noHorizontalScroll(A);
});
await step("J2", "every repo surface reachable at 390", async () => {
  const visited = [];
  for (const [path, id] of [
    [`${R}/issues`, "issue-board"],
    [`${R}/issues/visual-capstone`, "issue-detail"],
    [`${R}/pulls`, "pr-list"],
    [`${R}/wiki/home`, "wiki-page"],
    [`${R}/labels`, "label-management"],
    [`${R}/settings`, "repository-settings"],
  ]) {
    await go(A, path, id);
    await noHorizontalScroll(A);
    visited.push(path);
  }
  await A.goto(`${BASE}/members/maple`);
  await A.getByText("Brett", { exact: false }).first().waitFor({ timeout: 30_000 });
  await noHorizontalScroll(A);
  return visited;
});
await step("J2", "chat drawer by pointer and keyboard", async () => {
  await go(A, "/chat/maple/general", "chat-channel");
  const trigger = A.locator('[data-slot="chat-shell-nav-trigger"]').first();
  await trigger.click();
  const drawer = A.locator('[data-slot="chat-shell-sidebar"]').first();
  await drawer.waitFor({ state: "visible" });
  await A.keyboard.press("Escape");
  await A.waitForTimeout(600);
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    await A.keyboard.press("Tab");
    reached = await A.evaluate(() => document.activeElement?.getAttribute("data-slot") === "chat-shell-nav-trigger");
  }
  expect(reached, "keyboard never reached the drawer trigger");
  await A.keyboard.press("Enter");
  await A.waitForTimeout(600);
  const focusInside = await A.evaluate(() => document.activeElement?.closest('[data-slot="chat-shell-sidebar"]') !== null);
  await A.keyboard.press("Escape");
  await A.waitForTimeout(600);
  const focusBack = await A.evaluate(() => document.activeElement?.getAttribute("data-slot") === "chat-shell-nav-trigger");
  expect(focusInside && focusBack, `focusInside=${focusInside} focusBack=${focusBack}`);
  return { focusInside, focusBack };
});
await step("J2", "public site pages at 390 and 1440", async () => {
  for (const path of ["/home", "/roadmap", "/docs"]) {
    await A.goto(BASE + path);
    await A.locator("main, [data-testid]").first().waitFor();
    await A.waitForTimeout(800);
    await noHorizontalScroll(A);
  }
  await A.setViewportSize({ width: 1440, height: 900 });
  await A.goto(`${BASE}/home`);
  await A.waitForTimeout(800);
});

/* ── J3 management, removal and refusal paths ── */
await step("J3", "label create, rename, recolor; converges in tab B", async () => {
  await go(A, `${R}/labels`, "label-management");
  await A.getByTestId("label-create-id").fill("qa-flaky");
  await A.getByTestId("label-create-name").fill("QA flaky");
  await A.getByTestId("label-create-submit").click();
  const row = A.locator('[data-testid="label-row"][data-label-id="qa-flaky"]');
  await row.waitFor({ timeout: 20_000 });
  await row.getByTestId("label-rename-name").fill("QA flaky tests");
  await row.getByTestId("label-rename-form").getByRole("button", { name: "Rename" }).click();
  await row.getByText("QA flaky tests").first().waitFor({ timeout: 20_000 });
  const colorBefore = await row.getByTestId("label-recolor-color").inputValue();
  await row.getByTestId("label-recolor-color").fill("#3366ff");
  await row.getByTestId("label-recolor-form").locator("button[type=submit]").click();
  await A.waitForTimeout(2000);
  const B = watch(await context.newPage(), "B");
  await go(B, `${R}/labels`, "label-management");
  const rowB = B.locator('[data-testid="label-row"][data-label-id="qa-flaky"]');
  await rowB.getByText("QA flaky tests").first().waitFor({ timeout: 20_000 });
  const colorB = await rowB.getByTestId("label-recolor-color").inputValue();
  const counters = await A.evaluate(() =>
    Object.fromEntries(["dispatches-sent", "dispatches-confirmed", "dispatches-reconciled", "dispatches-refused"].map((id) => [id, document.querySelector(`[data-testid="${id}"]`)?.textContent])),
  );
  await B.close();
  return { colorBefore, colorB, counters };
});
await step("J3", "issue create, add + remove label, close", async () => {
  await go(A, `${R}/issues`, "issue-board");
  await A.getByTestId("issue-create-id").fill("qa-journey-issue");
  await A.getByTestId("issue-create-title").fill("QA journey issue");
  await A.getByTestId("issue-create-body").fill("Created by **Replay QA**");
  await A.getByTestId("issue-create-submit").click();
  await A.waitForTimeout(1500);
  await go(A, `${R}/issues/qa-journey-issue`, "issue-detail");
  await A.getByTestId("issue-title").filter({ hasText: "QA journey issue" }).waitFor({ timeout: 20_000 });
  await A.getByTestId("issue-add-label-id").fill("qa-flaky");
  await A.getByTestId("issue-add-label-submit").click();
  await A.getByTestId("issue-label").first().waitFor({ timeout: 20_000 });
  await A.getByTestId("issue-remove-label").first().click();
  await A.waitForFunction(() => document.querySelectorAll('[data-testid="issue-label"]').length === 0, null, { timeout: 20_000 });
  await A.getByTestId("issue-close-submit").click();
  await A.waitForFunction(() => /closed/i.test(document.querySelector('[data-testid="issue-state"]')?.textContent ?? ""), null, { timeout: 20_000 });
  const types = await A.getByTestId("issue-event-type").allInnerTexts();
  return { types };
});
await step("J3", "wiki create + save through the editor", async () => {
  await go(A, `${R}/wiki`, "wiki-new-slug");
  await A.getByTestId("wiki-new-slug").fill("qa-journey");
  await A.getByRole("button", { name: "Create page" }).click();
  await A.waitForURL(/wiki\/qa-journey/, { timeout: 20_000 });
  await go(A, `${R}/wiki/qa-journey/edit`, "wiki-source");
  await A.getByTestId("wiki-source").fill("# QA journey\n\nSaved from the editor.\n");
  await A.getByRole("button", { name: "Save changes" }).click();
  await A.getByTestId("wiki-save-status").filter({ hasText: "Up to date" }).waitFor({ timeout: 20_000 });
});
await step("J3", "stale-edit refusal from a second tab", async () => {
  const B = watch(await context.newPage(), "B");
  await go(A, `${R}/wiki/qa-journey/edit`, "wiki-source");
  await go(B, `${R}/wiki/qa-journey/edit`, "wiki-source");
  // Both tabs hold unsaved drafts on the same base; A saves first, then B's save is stale.
  await B.getByTestId("wiki-source").fill("# QA journey\n\nTab B is stale.\n");
  await A.getByTestId("wiki-source").fill("# QA journey\n\nTab A wins.\n");
  await A.getByRole("button", { name: "Save changes" }).click();
  await A.getByTestId("wiki-save-status").filter({ hasText: "Up to date" }).waitFor({ timeout: 20_000 });
  await B.waitForTimeout(2000);
  await B.getByRole("button", { name: "Save changes" }).click();
  const refusal = B.getByTestId("wiki-stale-refusal");
  const appeared = await refusal.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const refusalText = appeared ? await refusal.innerText() : null;
  await go(A, `${R}/wiki/qa-journey`, "wiki-markdown");
  await A.getByTestId("wiki-markdown").getByText("Tab A wins").waitFor({ timeout: 20_000 }).catch(() => undefined);
  const pageText = await A.getByTestId("wiki-markdown").innerText();
  await B.close();
  expect(appeared && pageText.includes("Tab A wins") && !pageText.includes("Tab B is stale"), `refusal=${appeared} ${refusalText} page=${pageText.slice(0, 200)}`);
  return { refusalRendered: appeared, refusalText, pageKeepsA: true };
});
await step("J3", "wiki rename then delete", async () => {
  await go(A, `${R}/wiki/qa-journey`, "wiki-rename-slug");
  await A.getByTestId("wiki-rename-slug").fill("qa-journey-renamed");
  await A.getByRole("button", { name: "Rename", exact: true }).click();
  await A.waitForURL(/qa-journey-renamed/, { timeout: 20_000 });
  await A.getByTestId("wiki-delete").click();
  await A.waitForTimeout(2000);
  await go(A, `${R}/wiki`, "wiki-new-slug");
  const indexText = await A.locator("body").innerText();
  expect(!indexText.includes("qa-journey-renamed"), "deleted page still listed");
  return { url: A.url() };
});
await step("J3", "members roster + invite", async () => {
  await A.goto(`${BASE}/members/maple`);
  await A.getByText("Brett", { exact: false }).first().waitFor({ timeout: 30_000 });
  await A.getByTestId("add-member").click();
  await A.getByTestId("invite-email").fill("grace@example.test");
  await A.getByRole("button", { name: "Send invite" }).click();
  const result = await Promise.race([
    A.getByTestId("invite-result").waitFor({ timeout: 20_000 }).then(() => "result"),
    A.getByRole("alert").first().waitFor({ timeout: 20_000 }).then(async () => `alert:${await A.getByRole("alert").first().innerText()}`),
  ]);
  return { result };
});
await step("J3", "CLI token mint + revoke", async () => {
  await A.goto(`${BASE}/settings/cli-tokens`);
  const mint = A.locator('[data-testid="cli-token-mint"]');
  await mint.waitFor();
  const name = mint.locator('input[name="name"]');
  if ((await name.count()) > 0) await name.fill("qa-journey-token");
  await mint.locator('button[type="submit"], input[type="submit"]').first().click();
  await A.locator('[data-testid="cli-token-secret"]:not([hidden])').waitFor({ timeout: 20_000 });
  await A.locator('[data-testid="cli-token-list"] li').first().waitFor({ timeout: 20_000 });
  const before = await A.locator('[data-testid="cli-token-list"] li').count();
  await A.locator('[data-testid="cli-token-list"] li').last().getByRole("button", { name: "Revoke" }).click();
  await A.waitForTimeout(2000);
  const after = await A.locator('[data-testid="cli-token-list"] li').count();
  expect(after === before - 1, `revoke did not remove the grant ${before} -> ${after}`);
  return { before, after };
});
await step("J3", "negative routes", async () => {
  const seen = {};
  for (const path of ["/maple/unknown-repo", "/lost/deep/trail", "/maple/mobile-kit"]) {
    await A.goto(BASE + path);
    await A.waitForTimeout(3000);
    await noMock(A);
    seen[path] = (await A.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160);
  }
  return seen;
});

/* ── J4 hostile Markdown on four surfaces through the UI ── */
await step("J4", "issue body", async () => {
  await go(A, `${R}/issues`, "issue-board");
  await A.getByTestId("issue-create-id").fill("qa-hostile");
  await A.getByTestId("issue-create-title").fill("QA hostile");
  await A.getByTestId("issue-create-body").fill(HOSTILE);
  await A.getByTestId("issue-create-submit").click();
  await A.waitForTimeout(1500);
  await go(A, `${R}/issues/qa-hostile`, "issue-body");
  await A.getByTestId("issue-body").getByText("bold survives").waitFor({ timeout: 20_000 });
  const r = await hostileInert(A, '[data-testid="issue-body"]');
  expect(r.unsafe.length === 0 && r.iframes === 0 && r.scripts === 0 && r.pwned === null && r.bold, JSON.stringify(r));
  return r;
});
await step("J4", "PR comment", async () => {
  await go(A, `${R}/pulls/60`, "pr-detail");
  const box = A.getByRole("textbox", { name: "Pull request comment" }).or(A.locator('textarea[aria-label="Pull request comment"], [aria-label="Pull request comment"] textarea')).first();
  await box.fill(HOSTILE);
  await A.getByRole("button", { name: "Comment", exact: true }).click();
  await A.getByText("bold survives").last().waitFor({ timeout: 20_000 });
  const r = await A.evaluate(() => {
    const strong = [...document.querySelectorAll("strong, b")].filter((b) => b.textContent === "bold survives").pop();
    const region = strong?.closest("[data-docstream-blocks]")?.parentElement ?? strong?.parentElement;
    const unsafe = [...(region?.querySelectorAll("a[href]") ?? [])].map((a) => a.getAttribute("href")).filter((h) => /^\s*(javascript|vbscript|data):/i.test(h ?? ""));
    return { found: !!strong, unsafe, iframes: region?.querySelectorAll("iframe").length ?? -1, scripts: region?.querySelectorAll("script").length ?? -1, pwned: window.__pwned ?? null };
  });
  expect(r.found && r.unsafe.length === 0 && r.iframes === 0 && r.scripts === 0 && r.pwned === null, JSON.stringify(r));
  return r;
});
await step("J4", "wiki page saved from the editor", async () => {
  await go(A, `${R}/wiki`, "wiki-new-slug");
  await A.getByTestId("wiki-new-slug").fill("qa-hostile");
  await A.getByRole("button", { name: "Create page" }).click();
  await A.waitForURL(/wiki\/qa-hostile/, { timeout: 20_000 });
  await go(A, `${R}/wiki/qa-hostile/edit`, "wiki-source");
  await A.getByTestId("wiki-source").fill(HOSTILE);
  await A.getByRole("button", { name: "Save changes" }).click();
  await A.getByTestId("wiki-save-status").filter({ hasText: "Up to date" }).waitFor({ timeout: 20_000 });
  await go(A, `${R}/wiki/qa-hostile`, "wiki-markdown");
  await A.getByTestId("wiki-markdown").getByText("bold survives").waitFor({ timeout: 20_000 });
  const r = await hostileInert(A, '[data-testid="wiki-markdown"]');
  expect(r.unsafe.length === 0 && r.iframes === 0 && r.scripts === 0 && r.pwned === null && r.bold, JSON.stringify(r));
  return r;
});
await step("J4", "chat message typed into the composer", async () => {
  await go(A, "/chat/maple/general", "chat-channel");
  const composer = A.getByTestId("chat-composer").locator("[contenteditable=true]").first();
  await composer.click();
  await A.keyboard.type(HOSTILE);
  await A.keyboard.press("Enter");
  await A.getByTestId("chat-channel").getByText("bold survives").last().waitFor({ timeout: 30_000 });
  const r = await A.evaluate(() => {
    const strong = [...document.querySelectorAll('[data-testid="chat-channel"] strong, [data-testid="chat-channel"] b')].filter((b) => b.textContent === "bold survives").pop();
    const region = strong?.closest("[data-docstream-blocks]")?.parentElement ?? strong?.parentElement;
    const unsafe = [...(region?.querySelectorAll("a[href]") ?? [])].map((a) => a.getAttribute("href")).filter((h) => /^\s*(javascript|vbscript|data):/i.test(h ?? ""));
    return { found: !!strong, unsafe, iframes: region?.querySelectorAll("iframe").length ?? -1, scripts: region?.querySelectorAll("script").length ?? -1, pwned: window.__pwned ?? null };
  });
  expect(r.found && r.unsafe.length === 0 && r.iframes === 0 && r.scripts === 0 && r.pwned === null, JSON.stringify(r));
  return r;
});

/* Observation only (excluded from pass/fail): one multi-character text-input event carrying a
   complete `**bold**` pattern (what IME commit / dictation deliver) into the chat composer. */
const observation = { name: "chat composer bulk insertText (TipTap markInputRule)", pageErrors: [] };
{
  const O = await context.newPage();
  O.on("pageerror", (e) => observation.pageErrors.push(String(e)));
  await go(O, "/chat/maple/general", "chat-channel");
  await O.getByTestId("chat-composer").locator("[contenteditable=true]").first().click();
  await O.keyboard.insertText(HOSTILE);
  await O.waitForTimeout(1500);
  await O.close();
}

await browser.close();
child.kill("SIGTERM");
const EXPECTED = [
  (p) => p.step === "J3 negative routes" && (/404/.test(p.text) || (p.kind === "404-url" && p.text.includes("/unknown-repo/"))),
  (p) => p.step === "J3 stale-edit refusal from a second tab" && p.tag === "B" && /409/.test(p.text),
];
const expectedProblems = problems.filter((p) => EXPECTED.some((f) => f(p)));
const unexpected = problems.filter((p) => !EXPECTED.some((f) => f(p)));
const transcript = {
  schemaVersion: 1,
  browser: { executablePath: browserPath, version },
  base: BASE,
  steps,
  passed: steps.filter((s) => s.ok).length,
  failed: steps.filter((s) => !s.ok).length,
  unexpectedProblems: unexpected,
  expectedNegativeProblems: expectedProblems,
  dialogs,
  observation,
};
await writeFile(out, `${JSON.stringify(transcript, null, 2)}\n`);
console.log(
  `E5_T15_FALLBACK steps=${steps.length} passed=${transcript.passed} failed=${transcript.failed} unexpected=${unexpected.length} expectedNegative=${expectedProblems.length} dialogs=${dialogs.length}`,
);
process.exit(transcript.failed === 0 && unexpected.length === 0 ? 0 : 1);
