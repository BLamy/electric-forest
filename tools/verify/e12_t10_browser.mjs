#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { createHostedFixture, task, root } from "./e12_t10_fixture.mjs";

const output = resolve(process.argv[2] ?? resolve(task, "work/browser"));
await mkdir(output, { recursive: true });
const world = await createHostedFixture(output);
const browser = await chromium.launch({
  executablePath:
    process.env.AGENT_BROWSER_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const contexts = [],
  pages = [],
  consoleErrors = [],
  pageErrors = [],
  requestFailures = [],
  terminalLongPolls = [],
  network = [],
  timeline = [],
  screenshots = [],
  videos = [],
  dumps = [],
  denialChecks = [];
const began = performance.now();
const step = (name, data = {}) => {
  timeline.push({ name, ms: Math.round(performance.now() - began), ...data });
  writeFileSync(
    resolve(output, "progress.json"),
    JSON.stringify({ timeline, network, consoleErrors, pageErrors, requestFailures }, null, 2),
  );
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const screenshot = async (page, name) => {
  const path = resolve(output, `${name}.png`);
  screenshots.push({ path, sha256: sha(await page.screenshot({ path, fullPage: true })) });
};
const open = async (context, name) => {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  pages.push({ page, name });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ name, text: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push({ name, text: error.message }));
  page.on("requestfailed", (request) => {
    const entry = {
      name,
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    };
    if (
      /live=1|projection=1/.test(request.url()) &&
      /ERR_ABORTED|NS_BINDING_ABORTED/.test(entry.error ?? "")
    )
      terminalLongPolls.push(entry);
    else requestFailures.push(entry);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    network.push({
      name,
      ms: Math.round(performance.now() - began),
      method: response.request().method(),
      origin: url.origin,
      path: url.pathname,
      status: response.status(),
      callbackQueryRetained: false,
    });
  });
  return page;
};
const context = async () => {
  const value = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    recordVideo: { dir: resolve(output, "video-work"), size: { width: 1440, height: 1000 } },
  });
  contexts.push(value);
  return value;
};
const signIn = async (page, role, target) => {
  await page.goto(`${world.origin}${target}`);
  await page.getByRole("heading", { name: "Dedicated Auth0-shaped issuer fixture" }).waitFor();
  step(`${role}-dedicated-issuer-before-login`, {
    target,
    issuer: world.issuer,
    productionCredentialsUsed: false,
  });
  await screenshot(page, `${role}-issuer`);
  await page
    .getByRole("button", {
      name: role === "ada" ? "Continue as Ada fixture" : "Continue as Grace fixture",
    })
    .click();
  await page.waitForURL(`${world.origin}${target}`);
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "ef_session");
  assert.ok(session?.secure && session.httpOnly && session.sameSite === "Lax");
  assert.equal(
    cookies.some((cookie) => cookie.name === "ef_login"),
    false,
  );
  assert.equal(await page.locator('meta[name="ef-auth"]').getAttribute("content"), "auth0");
  step(`${role}-PKCE-callback-and-local-return`, {
    target,
    sessionCookie: {
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      valueRetained: false,
    },
  });
};
const createOrg = async (page, name) => {
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await page.getByTestId("new-workspace-form").getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.waitForURL(`${world.origin}/organizations/${name}`);
  assert.equal(await page.getByTestId("new-workspace-form").count(), 0);
  step("fresh-user-created-own-organization", { name, defaultAgentsSeeded: false });
};
const cliDigest = (path, reducer) =>
  execFileSync(
    process.execPath,
    [
      resolve(root, "packages/cli/dist/src/bin.js"),
      "replay",
      path,
      "--digest",
      "--reducer",
      resolve(root, reducer),
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
async function identityProof(page, name, plain = false) {
  const node = plain ? page.locator("main") : page.getByTestId("identity-region").first();
  await node.waitFor({ state: "attached" });
  const offset = await node.getAttribute(plain ? "data-identity-offset" : "data-ef-offset");
  const digest = await node.getAttribute(plain ? "data-identity-digest" : "data-ef-digest");
  assert.ok(offset && digest);
  const snapshot = await world.runtime.identity.snapshot();
  assert.equal(
    snapshot.offset,
    offset,
    "DOM identity transport cursor must name this exact captured snapshot",
  );
  assert.equal(snapshot.digest, digest);
  const prefix = snapshot.events;
  const path = resolve(output, `${name}.jsonl`);
  await writeFile(path, prefix.length ? `${prefix.map(canonicalJson).join("\n")}\n` : "");
  assert.equal(cliDigest(path, "tools/verify/e12_t10_identity_reducer.mjs"), digest);
  const receipt = {
    name,
    layer: "identity",
    path,
    transportCursor: offset,
    lastApplicationOffset: prefix.at(-1)?.offset ?? "-1",
    digest,
    eventCount: prefix.length,
  };
  dumps.push(receipt);
  step("DOM-identity-cursor-matches-captured-snapshot-and-CLI-replay", receipt);
}
async function chatProof(context, viewers, name) {
  const response = await context.request.get(
    `${world.origin}/api/chat/browser-ada/welcome?projection=1&reducer=chat-channel`,
  );
  assert.equal(response.status(), 200);
  const body = await response.json();
  const path = resolve(output, `${name}.jsonl`);
  await writeFile(path, body.events.length ? `${body.events.map(canonicalJson).join("\n")}\n` : "");
  const digest = cliDigest(path, "tools/verify/e12_t00_chat_reducer.mjs");
  for (const page of viewers)
    await page.waitForFunction(
      ({ offset, digest }) => {
        const node = globalThis.document.querySelector('[data-testid="chat-channel"]');
        return (
          node?.getAttribute("data-ef-offset") === offset &&
          node?.getAttribute("data-ef-digest") === digest
        );
      },
      { offset: body.checkpoint, digest },
    );
  const receipt = {
    name,
    layer: "chat-channel",
    path,
    offset: body.checkpoint,
    digest,
    eventCount: body.events.length,
    viewers: viewers.length,
  };
  dumps.push(receipt);
  step("DOM-chat-triples-match-CLI-replay", receipt);
  return body;
}
try {
  const adaContext = await context(),
    graceContext = await context(),
    witnessContext = await context();
  const ada = await open(adaContext, "ada"),
    grace = await open(graceContext, "grace");
  assert.equal((await world.runtime.identity.snapshot()).events.length, 0);
  await signIn(ada, "ada", "/settings/cli-tokens");
  await ada.getByRole("heading", { name: "CLI tokens" }).waitFor();
  await identityProof(ada, "ada-login-deep-return", true);
  await screenshot(ada, "local-deep-link-return");
  await ada.getByRole("link", { name: "Back", exact: true }).click();
  await ada.getByTestId("hosted-banner").waitFor();
  assert.equal(
    await ada.getByTestId("hosted-banner").getAttribute("data-ef-build"),
    world.environment.EF_BUILD_REVISION,
  );
  assert.equal((await world.events("ns:root")).length, 0);
  await createOrg(ada, "browser-ada");
  await identityProof(ada, "ada-organization");
  await screenshot(ada, "first-private-workspace");
  await signIn(grace, "grace", "/settings/cli-tokens");
  await grace.getByRole("link", { name: "Back", exact: true }).click();
  await grace.getByTestId("hosted-banner").waitFor();
  assert.equal((await world.events("ns:root")).length, 1);
  await createOrg(grace, "browser-grace");
  await identityProof(grace, "grace-organization");
  await screenshot(grace, "separate-private-workspace");
  await ada.getByTestId("new-channel").click();
  await ada.getByTestId("new-channel-form").getByLabel("Channel name").fill("welcome");
  await ada.getByTestId("new-channel-form").getByLabel("Topic").fill("Private acceptance fixture");
  await ada.getByRole("button", { name: "Create channel", exact: true }).click();
  await ada.waitForURL(`${world.origin}/chat/browser-ada/welcome`);
  await ada.getByTestId("chat-composer").waitFor();
  let witness = await open(witnessContext, "ada-witness");
  await signIn(witness, "ada", "/chat/browser-ada/welcome");
  await witness.getByTestId("chat-composer").waitFor();
  const text = "Private hosted browser acceptance survives restart.";
  const editor = ada.getByTestId("chat-composer").locator('[contenteditable="true"]');
  await editor.click();
  await editor.fill(text);
  await ada.getByTestId("chat-send").click();
  await witness.getByTestId("chat-message").filter({ hasText: text }).waitFor();
  await chatProof(adaContext, [ada, witness], "two-profiles-live");
  await screenshot(witness, "private-live-convergence");
  for (const [name, ctx] of [
    ["other-tenant", graceContext],
    ["anonymous", await browser.newContext({ ignoreHTTPSErrors: true })],
  ]) {
    const path = `${world.origin}/api/chat/browser-ada/welcome?projection=1&reducer=chat-channel`;
    const result = await ctx.request.get(path);
    assert.ok([401, 403, 404].includes(result.status()));
    denialChecks.push({ name, path: new URL(path).pathname, status: result.status() });
    if (name === "anonymous") await ctx.close();
  }
  step("private-read-refused-to-other-tenant-and-anonymous", { checks: denialChecks });
  await witness.close();
  step("witness-disconnected-with-session-retained");
  const second = "A second private mutation arrived while the witness was disconnected.";
  await editor.click();
  await editor.fill(second);
  await editor.press("Enter");
  await ada.getByTestId("chat-message").filter({ hasText: second }).waitFor();
  witness = await open(witnessContext, "ada-witness-reconnected");
  await witness.goto(`${world.origin}/chat/browser-ada/welcome`);
  await witness.getByTestId("chat-message").filter({ hasText: second }).waitFor();
  await chatProof(adaContext, [ada, witness], "witness-reconnected");
  await ada.getByTestId("members-tab").click();
  await ada.getByTestId("hosted-agents-off").waitFor();
  assert.equal(await ada.getByTestId("seed-agents").count(), 0);
  await ada.getByTestId("add-member").click();
  assert.equal(await ada.getByTestId("agent-form").count(), 0);
  await screenshot(ada, "agents-off-human-members");
  await ada.keyboard.press("Escape");
  step("disabled-agent-capability-and-human-member-dialog");
  await ada.getByTestId("account-menu-trigger").click();
  await ada.getByRole("button", { name: "CLI tokens", exact: true }).click();
  await ada.getByRole("heading", { name: "CLI tokens" }).waitFor();
  // Dedicated fixture grants are never captured in screenshots/video/network bodies.
  await ada.addStyleTag({
    content: '[data-testid="cli-token-secret"]{visibility:hidden!important}',
  });
  await ada
    .getByTestId("cli-token-mint")
    .getByLabel("Name", { exact: true })
    .fill("browser-fixture-grant");
  await ada.getByRole("button", { name: "Mint token", exact: true }).click();
  await ada
    .getByTestId("cli-token-list")
    .getByText(/browser-fixture-grant/)
    .waitFor();
  assert.equal(
    await ada
      .getByTestId("cli-token-secret")
      .evaluate((node) => /^ef_cli_[A-Za-z0-9_-]{43}$/.test(node.textContent ?? "")),
    true,
  );
  await identityProof(ada, "browser-grant-minted", true);
  await screenshot(ada, "web-cli-grant-minted-redacted");
  step("opaque-CLI-token-minted", {
    tokenValueRetained: false,
    videoRedaction: "secret output hidden before mint; token-format assertion executes in page",
  });
  ada.once("dialog", (dialog) => dialog.accept());
  await ada.getByRole("button", { name: "Revoke", exact: true }).click();
  await ada.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-testid="cli-token-list"]')?.children.length === 0,
  );
  await identityProof(ada, "browser-grant-revoked", true);
  await screenshot(ada, "web-cli-grant-revoked");
  step("grant-revoked-returning-home");
  await ada.getByRole("link", { name: "Back", exact: true }).click();
  await ada.getByTestId("hosted-banner").waitFor();
  step("home-before-logout");
  const oldCookie = (await adaContext.cookies()).find((cookie) => cookie.name === "ef_session");
  assert.ok(oldCookie);
  await ada.getByTestId("account-menu-trigger").click();
  step("account-menu-before-logout");
  await ada.getByRole("button", { name: "Log out", exact: true }).click();
  step("logout-form-submitted");
  await ada.waitForURL(`${world.origin}/`);
  const refused = await adaContext.request.get(`${world.origin}/api/whoami`, {
    headers: { cookie: `ef_session=${oldCookie.value}` },
  });
  assert.equal(refused.status(), 401);
  step("logout-session-refused", { status: refused.status(), secretRetained: false });
  const before = await world.dumpIdentity("browser-identity-before-restart");
  dumps.push({ ...before, name: "identity-before-restart", layer: "identity" });
  const chatPrefix = await world.events("chat:browser-ada/welcome");
  await witness.close();
  await grace.close();
  step("active-pages-disconnected-before-controlled-restart", { sessionContextsRetained: true });
  await world.restart();
  const after = await world.dumpIdentity("browser-identity-after-restart");
  dumps.push({ ...after, name: "identity-after-restart", layer: "identity" });
  assert.equal(after.sha256, before.sha256);
  assert.equal(after.digest, before.digest);
  assert.deepEqual(await world.events("chat:browser-ada/welcome"), chatPrefix);
  witness = await open(witnessContext, "ada-witness-after-restart");
  await witness.goto(`${world.origin}/chat/browser-ada/welcome`);
  await witness.getByTestId("chat-message").filter({ hasText: second }).waitFor();
  await chatProof(witnessContext, [witness], "active-session-after-restart");
  await identityProof(witness, "active-session-restarted");
  await screenshot(witness, "session-and-private-writes-survive-restart");
  await signIn(ada, "ada", "/chat/browser-ada/welcome");
  await ada.getByTestId("chat-message").filter({ hasText: second }).waitFor();
  await chatProof(adaContext, [ada, witness], "relogin-preserves-state");
  const finalIdentity = await world.dumpIdentity("browser-identity-final");
  dumps.push({ ...finalIdentity, name: "identity-final", layer: "identity" });
  for (const streamId of ["ns:root", "ns:org:browser-ada", "ns:org:browser-grace"]) {
    const events = await world.events(streamId);
    const path = resolve(output, `${streamId.replaceAll(":", "-")}.jsonl`);
    await writeFile(path, events.length ? `${events.map(canonicalJson).join("\n")}\n` : "");
    dumps.push({ name: streamId, layer: "namespace", path, eventCount: events.length });
  }
  assert.equal(
    network.some((entry) => entry.path === "/__proof/e3-t02"),
    false,
  );
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(requestFailures, []);
  await Promise.all(contexts.map((ctx) => ctx.close()));
  for (const item of pages) {
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
    videos.push({
      path,
      duration: Number(probe.format.duration),
      sha256: sha(await readFile(path)),
    });
  }
  await writeFile(
    resolve(output, "browser.json"),
    `${JSON.stringify({ task: "E12-T10", journey: "E12-T10 Auth0 login and private workspace", proof: "dedicated-fixture browser fallback; not actual Auth0 operator", sourceRevision: world.environment.EF_BUILD_REVISION, origin: world.origin, timeline, network, consoleErrors, pageErrors, requestFailures, terminalLongPolls, denialChecks, screenshots, videos, dumps, timings: world.timings, productionCredentialsUsed: false }, null, 2)}\n`,
  );
  process.stdout.write(
    `E12-T10 browser: ${timeline.length} scenes, ${videos.length} verified videos, zero console/page errors\n`,
  );
} finally {
  step("closing-fixture-browser-contexts");
  await Promise.allSettled(contexts.map((ctx) => ctx.close()));
  step("closing-fixture-browser");
  await browser.close();
  step("closing-fixture-runtime");
  await world.close();
  step("fixture-cleanup-complete");
}
