#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createPreviewRuntime, PREVIEW_README } from "../../packages/platform/dist/src/preview.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  fileContentInitialState,
  fileContentReducer,
} from "../../packages/reducers/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const task = resolve(root, ".eforest/tasks/epic-12-first-light/E12-T00-railway-preview");
const frozenReadme = await readFile(
  resolve(root, "packages/platform/fixtures/preview/README.md"),
  "utf8",
);
assert.equal(PREVIEW_README, frozenReadme);
const suppliedOrigin = process.argv[2];
const output = resolve(process.argv[3] ?? resolve(task, "work/browser"));
await mkdir(output, { recursive: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
let runtime;
let dataDir;
let origin = suppliedOrigin;
if (origin === undefined || origin === "local") {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  origin = `http://127.0.0.1:${port}`;
  dataDir = await mkdtemp(resolve(output, "data-"));
  runtime = await createPreviewRuntime({
    EF_DEPLOYMENT_MODE: "preview",
    EF_PREVIEW_AUTH: "fixture",
    EF_BUILD_REVISION: revision,
    EF_PUBLIC_ORIGIN: origin,
    EF_PREVIEW_DATA_DIR: dataDir,
    PORT: String(port),
  });
  await runtime.start();
}
const browser = await chromium.launch({
  executablePath:
    process.env.AGENT_BROWSER_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const consoleErrors = [];
const pageErrors = [];
const requestFailures = [];
const terminalLongPolls = [];
const network = [];
const timeline = [];
const captures = [];
const videos = [];
const contexts = [];
const start = performance.now();
const instrument = (page, role) => {
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ role, text: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push({ role, text: error.message }));
  page.on("requestfailed", (request) => {
    const failure = { role, url: request.url(), error: request.failure()?.errorText };
    if (
      /live=1|projection=1/.test(request.url()) &&
      /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure.error ?? "")
    )
      terminalLongPolls.push(failure);
    else requestFailures.push(failure);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    network.push({
      role,
      ms: Math.round(performance.now() - start),
      method: response.request().method(),
      path: `${url.pathname}${url.search}`,
      status: response.status(),
      ...(url.pathname === "/api/dispatch" ? { body: response.request().postData() } : {}),
    });
  });
};
const open = async (context, role) => {
  const page = await context.newPage();
  instrument(page, role);
  return page;
};
const step = (name, detail = {}) =>
  timeline.push({ name, ms: Math.round(performance.now() - start), ...detail });
const screenshot = async (page, name) => {
  const path = resolve(output, `${name}.png`);
  const bytes = await page.screenshot({ path, fullPage: true });
  captures.push({ name: `${name}.png`, sha256: createHash("sha256").update(bytes).digest("hex") });
};
const region = async (page, testId) => {
  const node = page.getByTestId(testId);
  await node.waitFor();
  await page.waitForFunction(
    (id) =>
      globalThis.document
        .querySelector(`[data-testid="${id}"]`)
        ?.getAttribute("data-stream-status") === "live",
    testId,
  );
  return {
    stream: await node.getAttribute("data-ef-stream"),
    offset: await node.getAttribute("data-ef-offset"),
    digest: await node.getAttribute("data-ef-digest"),
  };
};
const signIn = async (page, subject, path) => {
  await page.goto(`${origin}${path}`);
  await page.getByTestId("preview-notice").waitFor();
  assert.match(
    await page.getByTestId("preview-notice").innerText(),
    /PUBLIC PREVIEW.*DISPOSABLE DATA.*SHARED FIXTURE/,
  );
  await screenshot(page, `${subject}-notice`);
  step(`${subject}-notice-before-fixture-data`, { path });
  await page.getByTestId(`preview-login-${subject}`).click();
  await page.getByTestId("preview-banner").waitFor();
  assert.equal(await page.getByTestId("preview-banner").getAttribute("data-ef-mode"), "preview");
};
const proveChannel = async (context, pages, name) => {
  const response = await context.request.get(
    `${origin}/api/chat/preview/welcome?projection=1&reducer=chat-channel`,
  );
  assert.equal(response.status(), 200);
  const prefix = await response.json();
  assert.equal(prefix.events[0].offset, "0000000000000000_0000000000000000");
  const dumpPath = resolve(output, `${name}.jsonl`);
  await writeFile(dumpPath, `${prefix.events.map(canonicalJson).join("\n")}\n`);
  const cliDigest = execFileSync(
    process.execPath,
    [
      resolve(root, "packages/cli/dist/src/bin.js"),
      "replay",
      dumpPath,
      "--digest",
      "--reducer",
      resolve(root, "tools/verify/e12_t00_chat_reducer.mjs"),
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const states = [];
  for (const page of pages) {
    await page.waitForFunction(
      ({ checkpoint, digest }) => {
        const node = globalThis.document.querySelector('[data-testid="chat-channel"]');
        return (
          node?.getAttribute("data-ef-offset") === checkpoint &&
          node?.getAttribute("data-ef-digest") === digest
        );
      },
      { checkpoint: prefix.checkpoint, digest: cliDigest },
    );
    states.push(await region(page, "chat-channel"));
  }
  step(name, {
    dump: `${name}.jsonl`,
    offset: prefix.checkpoint,
    digest: cliDigest,
    eventCount: prefix.events.length,
    states,
  });
  return { prefix, cliDigest };
};
try {
  const buildResponse = await fetch(`${origin}/api/deployment`);
  assert.equal(buildResponse.status, 200);
  const build = await buildResponse.json();
  assert.equal(build.mode, "preview");
  assert.equal(build.agents, "off");
  assert.equal(build.integrations, "off");
  assert.equal(
    createHash("sha256").update(JSON.stringify(build.artifact.files)).digest("hex"),
    build.artifactDigest,
  );
  await writeFile(resolve(output, "deployment.json"), `${JSON.stringify(build, null, 2)}\n`);
  for (let index = 0; index < 2; index += 1)
    contexts.push(
      await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
        recordVideo: {
          dir: resolve(task, "work/browser-video"),
          size: { width: 1440, height: 1000 },
        },
      }),
    );
  const [adaContext, graceContext] = contexts;
  const ada = await open(adaContext, "ada");
  let grace = await open(graceContext, "grace");
  const videoPages = [
    { page: ada, name: "ada" },
    { page: grace, name: "grace-before-reconnect" },
  ];
  await signIn(ada, "ada", "/preview/forest/blob/main/README.md");
  await ada.getByTestId("file-content").waitFor();
  assert.match(await ada.getByTestId("file-content").innerText(), /Electric Forest preview/);
  const fileResponse = await adaContext.request.get(
    `${origin}/api/repos/preview/forest/main/blob/README.md?projection=1&reducer=file-content`,
  );
  assert.equal(fileResponse.status(), 200);
  const filePrefix = await fileResponse.json();
  await writeFile(
    resolve(output, "file.jsonl"),
    `${filePrefix.events.map(canonicalJson).join("\n")}\n`,
  );
  assert.equal(
    filePrefix.events.reduce(fileContentReducer, fileContentInitialState).text,
    frozenReadme,
  );
  const frozenDigest = createHash("sha256").update(frozenReadme).digest("hex");
  assert.equal(
    await ada.getByTestId("file-viewer").getAttribute("data-ef-offset"),
    filePrefix.checkpoint,
  );
  assert.equal(await ada.getByTestId("file-viewer").getAttribute("data-ef-digest"), frozenDigest);
  assert.equal(
    await ada.getByTestId("preview-banner").getAttribute("data-ef-build"),
    build.revision,
  );
  await screenshot(ada, "seeded-file");
  step("seeded-file-browsed", {
    bytesSha256: createHash("sha256").update(PREVIEW_README).digest("hex"),
    build: build.revision,
  });
  await signIn(grace, "grace", "/chat/preview/welcome");
  await ada.getByTestId("preview-banner").getByRole("link", { name: "Try live chat" }).click();
  await Promise.all([region(ada, "chat-channel"), region(grace, "chat-channel")]);
  const witnessNavigationCount = network.filter(
    (entry) => entry.role === "grace" && entry.path === "/chat/preview/welcome",
  ).length;
  const text = `Railway preview live acceptance ${Date.now()}`;
  const editor = ada.getByTestId("chat-composer").locator('[contenteditable="true"]');
  await editor.click();
  await editor.fill(text);
  await ada.getByTestId("chat-send").click();
  await grace.getByTestId("chat-message").filter({ hasText: text }).waitFor();
  assert.equal(
    network.filter((entry) => entry.role === "grace" && entry.path === "/chat/preview/welcome")
      .length,
    witnessNavigationCount,
  );
  const accepted = await proveChannel(adaContext, [ada, grace], "two-profile-accepted");
  assert.equal(accepted.prefix.events.filter((event) => event.payload.body === text).length, 1);
  await screenshot(grace, "live-convergence");
  await grace.close();
  step("witness-disconnected", {
    method: "closed page; isolated profile and its session retained",
  });
  const secondText = `${text} while witness disconnected`;
  await editor.click();
  await editor.fill(secondText);
  await editor.press("Enter");
  await ada.getByTestId("chat-message").filter({ hasText: secondText }).waitFor();
  grace = await open(graceContext, "grace");
  videoPages.push({ page: grace, name: "grace-after-reconnect" });
  await grace.goto(`${origin}/chat/preview/welcome`);
  await grace.getByTestId("chat-message").filter({ hasText: secondText }).waitFor();
  await proveChannel(adaContext, [ada, grace], "witness-reconnected");
  await ada.goto(`${origin}/members/preview`);
  await ada.getByTestId("preview-agents-off").waitFor();
  assert.equal(await ada.getByTestId("seed-agents").count(), 0);
  await screenshot(ada, "agents-disabled");
  step("agent-execution-and-integrations-off");
  const oldCookie = (await adaContext.cookies()).find((cookie) => cookie.name === "ef_session");
  assert.ok(oldCookie);
  assert.equal(oldCookie.httpOnly, true);
  assert.equal(oldCookie.sameSite, "Lax");
  if (origin.startsWith("https:")) assert.equal(oldCookie.secure, true);
  await ada.getByTestId("account-menu-trigger").click();
  await ada.getByRole("button", { name: "Log out", exact: true }).click();
  await ada.waitForURL(`${origin}/`);
  const revoked = await fetch(`${origin}/api/whoami`, {
    headers: { cookie: `ef_session=${oldCookie.value}` },
  });
  assert.equal(revoked.status, 401);
  const invalid = await fetch(`${origin}/api/whoami`, {
    headers: { cookie: "ef_session=invalid.signature" },
  });
  assert.equal(invalid.status, 401);
  step("invalid-and-ended-session-refused", { invalid: invalid.status, ended: revoked.status });
  await signIn(ada, "ada", "/chat/preview/welcome");
  await proveChannel(adaContext, [ada, grace], "relogin-preserves-writes");
  await screenshot(ada, "relogin");
  await Promise.all(contexts.map((context) => context.close()));
  for (const item of videoPages) {
    const webm = await item.page.video().path();
    const path = resolve(output, `${item.name}.mp4`);
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        webm,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        path,
      ],
      { stdio: "ignore" },
    );
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
        { encoding: "utf8" },
      ),
    );
    assert.ok(Number(probe.format.duration) > 0);
    assert.ok(probe.streams.some((stream) => stream.codec_type === "video"));
    videos.push({
      name: `${item.name}.mp4`,
      duration: Number(probe.format.duration),
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
    await rm(webm);
  }
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(requestFailures, []);
  await runtime?.close();
  runtime = undefined;
  const summary = {
    mode: "preview",
    origin,
    revision: build.revision,
    artifactDigest: build.artifactDigest,
    browser: browser.version(),
    evidenceLayer: "Playwright fallback; Replay QA unavailable (authentication required)",
    consoleErrors,
    pageErrors,
    requestFailures,
    terminalLongPolls,
    captures,
    videos,
    timeline,
  };
  await writeFile(resolve(output, "browser.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(resolve(output, "network.json"), `${JSON.stringify(network, null, 2)}\n`);
  process.stdout.write(
    `E12_T00_BROWSER_OK ${JSON.stringify({ origin, revision: build.revision, scenes: timeline.length, consoleErrors: 0, pageErrors: 0, requestFailures: 0 })}\n`,
  );
} catch (error) {
  await writeFile(
    resolve(output, "failure.json"),
    `${JSON.stringify({ message: error.message, consoleErrors, pageErrors, requestFailures, network, timeline, pages: contexts.flatMap((context) => context.pages().map((page) => page.url())) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
  await runtime?.close();
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
}
