import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone/work/code-personal",
);
await mkdir(output, { recursive: true });
const child = spawn(
  process.execPath,
  [resolve(root, "apps/web/test/fixtures/e5-t14-preview-server.mjs")],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});
const ready = await new Promise<{ url: string }>((resolveReady, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error(`Preview startup timed out: ${stderr}`)), 60000);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const line = buffer.split("\n").find((candidate) => candidate.startsWith("E5_T14_READY "));
    if (line === undefined) return;
    clearTimeout(timer);
    resolveReady(JSON.parse(line.slice("E5_T14_READY ".length)) as { url: string });
  });
  child.once("exit", () => {
    clearTimeout(timer);
    reject(new Error(`Preview exited: ${stderr}`));
  });
});
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const consoleErrors: string[] = [];
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
const dispatches: { streamId: string; type: string; status: number }[] = [];
page.on("response", (response) => {
  if (!response.url().endsWith("/api/dispatch")) return;
  const body = response.request().postDataJSON() as { streamId: string; event: { type: string } };
  dispatches.push({ streamId: body.streamId, type: body.event.type, status: response.status() });
});
const personal = "brett-4db7cf839332";
try {
  await page.goto(`${ready.url}/auth/login`);
  await page.getByRole("button", { name: /brett@electric-forest.test/ }).click();
  await page.getByTestId("personal-account-nav").waitFor();
  assert.equal(await page.getByTestId("registry-empty").innerText(), "No repositories yet.");
  const account = page.getByRole("button", { name: "brett · Personal account", exact: true });
  await account.waitFor();

  await page.getByTestId("registry-new").click();
  assert.equal(await page.getByTestId("new-repository-form").getAttribute("data-owner"), personal);
  await page.getByRole("textbox", { name: "Repository name", exact: true }).fill("first-repo");
  await page.getByRole("button", { name: "Create repository", exact: true }).click();
  await page.waitForURL(`**/${personal}/first-repo`);
  await page.getByTestId("tree-empty").waitFor();
  assert.match(await page.getByTestId("tree-empty").innerText(), /Your repository is ready/);
  assert.equal(await page.getByText("Authorized live projections", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("repo-visibility").innerText(), "Public");
  await page.screenshot({ path: resolve(output, "personal-empty.png"), fullPage: true });

  await account.click();
  await page.getByTestId("registry-new").click();
  await page.getByRole("textbox", { name: "Repository name", exact: true }).fill("second-repo");
  await page.getByRole("radio", { name: "Private", exact: true }).check();
  await page.getByRole("button", { name: "Create repository", exact: true }).click();
  await page.waitForURL(`**/${personal}/second-repo`);
  await page.getByTestId("tree-empty").waitFor();
  assert.equal(await page.getByTestId("repo-visibility").innerText(), "Private");
  assert.equal(dispatches.filter((entry) => entry.type === "ns.org.create").length, 1);
  assert.ok(
    dispatches.every((entry) => entry.status >= 200 && entry.status < 300),
    JSON.stringify(dispatches),
  );

  await page.getByRole("button", { name: "maple", exact: true }).click();
  await page.waitForURL("**/organizations/maple");
  await page.goto(`${ready.url}/maple/reading-room`);
  await page.getByTestId("repository-file-table").waitFor();
  await page
    .getByTestId("repository-readme")
    .getByRole("heading", { name: "Electric Forest Reading Room" })
    .waitFor();
  assert.deepEqual(
    await page
      .getByTestId("repository-file-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path"))),
    ["apps", "packages", "README.md", "package.json"],
  );
  const tree = page.getByTestId("tree-browser");
  assert.match((await tree.getAttribute("data-ef-digest")) ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    await tree.getAttribute("data-ef-offset"),
    await tree.getAttribute("data-session-checkpoint"),
  );
  assert.equal(
    await tree.getAttribute("data-ef-digest"),
    await tree.getAttribute("data-session-digest"),
  );
  await page.screenshot({ path: resolve(output, "code-desktop.png"), fullPage: true });
  await page
    .getByTestId("repository-file-row")
    .filter({ hasText: "apps" })
    .getByRole("link")
    .click();
  await page
    .getByTestId("repository-file-row")
    .filter({ hasText: "web" })
    .getByRole("link")
    .click();
  await page.getByRole("link", { name: "product.ts", exact: true }).click();
  await page.getByTestId("file-viewer").waitFor();
  await page.goto(`${ready.url}/maple/reading-room`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mobile-repository-shell").waitFor();
  await page
    .getByTestId("repository-readme")
    .getByRole("heading", { name: "Electric Forest Reading Room" })
    .waitFor();
  await page.screenshot({ path: resolve(output, "code-phone.png"), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await account.click();
  await page.getByTestId("registry-new").waitFor();
  await page.getByTestId("registry-empty").waitFor({ state: "hidden" });
  await page.screenshot({ path: resolve(output, "personal-phone.png"), fullPage: true });
  const retry = await context.newPage();
  const retryDispatches: { type: string; status: number }[] = [];
  retry.on("response", (response) => {
    if (response.url().endsWith("/api/dispatch"))
      retryDispatches.push({
        type: (response.request().postDataJSON() as { event: { type: string } }).event.type,
        status: response.status(),
      });
  });
  await retry.goto(ready.url);
  await retry.getByTestId("registry-new").click();
  await retry.getByRole("textbox", { name: "Repository name", exact: true }).fill("first-repo");
  await retry.getByTestId("new-repository-project").selectOption("__new__");
  await retry.getByRole("textbox", { name: "New group name", exact: true }).fill("retry-group");
  await retry.getByRole("button", { name: "Create repository", exact: true }).click();
  await retry.getByRole("alert").waitFor();
  assert.match(await retry.getByRole("alert").innerText(), /already.*use/);
  await retry.getByRole("textbox", { name: "Repository name", exact: true }).fill("recovered-repo");
  await retry.getByRole("button", { name: "Create repository", exact: true }).click();
  await retry.waitForURL(`**/${personal}/recovered-repo`);
  await retry.getByTestId("tree-empty").waitFor();
  assert.equal(retryDispatches.filter((entry) => entry.type === "ns.project.create").length, 1);
  await retry.goto(`${ready.url}/maple/no-such-repository`);
  await retry.getByRole("alert").waitFor();
  assert.equal(await retry.getByTestId("tree-empty").count(), 0);
  await retry.close();
  assert.deepEqual(consoleErrors, []);
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        dispatches,
        consoleErrors,
        personalNamespace: personal,
        browserEvidence:
          "Replay: N/A (Replay QA tools unavailable in this session) + mitigation: Playwright trace, screenshots, network assertions, DOM digest parity",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: personal provisioning, second repo, sidebar switching, code landing, README, nested file, mobile, zero console errors",
  );
} finally {
  await context.tracing.stop({ path: resolve(output, "trace.zip") });
  await browser.close();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await new Promise<void>((done) => {
    if (child.exitCode !== null) done();
    else child.once("exit", () => done());
  });
  clearTimeout(timer);
}
