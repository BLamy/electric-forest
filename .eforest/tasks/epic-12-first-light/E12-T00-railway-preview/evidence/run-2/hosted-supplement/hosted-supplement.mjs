import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const [origin, revision, directory] = process.argv.slice(2);
assert.ok(origin?.startsWith("https://"));
assert.match(revision, /^[a-f0-9]{40}$/);
const output = resolve(directory);
await mkdir(output, { recursive: true });
const root = process.cwd();
const work = resolve(root, ".eforest/tasks/epic-12-first-light/E12-T00-railway-preview/work");
const browser = await chromium.launch({ executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", recordVideo: { dir: resolve(work, "supplement-video"), size: { width: 1440, height: 1000 } } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const network = [];
const requestFailures = [];
const abortedFollows = [];
const endpoints = [];
let focusObservation;
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("response", (response) => network.push({ url: response.url(), method: response.request().method(), status: response.status() }));
page.on("requestfailed", (request) => { const failure = { url: request.url(), error: request.failure()?.errorText }; if (/live=1|projection=1/.test(failure.url) && /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure.error ?? "")) abortedFollows.push(failure); else requestFailures.push(failure); });
try {
  for (const path of ["/api/build", "/healthz", "/readyz"]) {
    const response = await context.request.get(`${origin}${path}`);
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.revision, revision); assert.equal(body.mode, "preview"); assert.equal(body.agents, "off"); assert.equal(body.integrations, "off");
    endpoints.push({ path, status: response.status(), body });
  }
  await page.goto(`${origin}/auth/login?next=%2Fmembers%2Fpreview`);
  await page.getByTestId("preview-notice").waitFor();
  await page.getByTestId("preview-login-ada").click();
  await page.getByTestId("preview-agents-off").waitFor();
  assert.equal(await page.getByTestId("preview-banner").getAttribute("data-ef-build"), revision);
  await page.getByTestId("add-member").click();
  const dialog = page.getByRole("dialog", { name: "Add member" });
  await dialog.waitFor();
  const group = dialog.getByRole("radiogroup", { name: "Member kind" });
  await group.getByRole("radio", { name: "Human", exact: true }).waitFor();
  assert.equal(await group.getByRole("radio").count(), 1);
  assert.equal(await group.getByRole("radio", { name: "Agent", exact: true }).count(), 0);
  assert.equal(await dialog.getByTestId("agent-form").count(), 0);
  await dialog.getByTestId("invite-form").waitFor();
  const dom = await dialog.evaluate((node) => node.outerHTML);
  const screenshot = await page.screenshot({ path: resolve(output, "human-only-members.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="add-member"]') === document.activeElement, undefined, { timeout: 3000 });
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
  }
  focusObservation = await page.evaluate(() => ({ restoredToTrigger: document.querySelector('[data-testid="add-member"]') === document.activeElement, activeTag: document.activeElement?.tagName }));
  assert.equal(await page.getByTestId("add-member").isVisible(), true);
  for (const path of ["/settings/cli-tokens", "/api/cli-tokens"]) {
    const response = await context.request.get(`${origin}${path}`);
    assert.equal(response.status(), 403);
    const body = await response.json(); assert.equal(body.error, "preview-external-integrations-disabled");
    endpoints.push({ path, status: response.status(), body });
  }
  const device = await context.request.post(`${origin}/api/device-grants`, { headers: { origin }, data: {} });
  assert.equal(device.status(), 403);
  endpoints.push({ path: "/api/device-grants", status: device.status(), body: await device.json() });
  const agent = await context.request.post(`${origin}/api/dispatch`, { headers: { origin }, data: { streamId: "agents:preview", event: { type: "agent.register", payload: null, ts: 1 } } });
  assert.equal(agent.status(), 403);
  const agentBody = await agent.json(); assert.equal(agentBody.error, "preview-agent-execution-disabled");
  endpoints.push({ path: "/api/dispatch", action: "agent.register", status: agent.status(), body: agentBody });
  for (const path of ["/auth/callback?state=fixture&code=fixture", "/streams/__identity__", "/admin"]) {
    const response = await context.request.get(`${origin}${path}`);
    assert.equal(response.status(), 404);
    endpoints.push({ path, status: response.status(), body: await response.json() });
  }
  await context.close();
  const webm = await page.video().path();
  const videoPath = resolve(output, "hosted-supplement.mp4");
  execFileSync("ffmpeg", ["-y", "-i", webm, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath], { stdio: "ignore" });
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", videoPath], { encoding: "utf8" }));
  assert.ok(Number(probe.format.duration) > 0); assert.ok(probe.streams.some((stream) => stream.codec_type === "video"));
  assert.deepEqual(consoleErrors, []); assert.deepEqual(pageErrors, []); assert.deepEqual(requestFailures, []);
  const summary = { origin, revision, scenes: ["shared-fixture-notice", "members-agent-disabled-notice", "add-member-human-only", "escape-closes-member-dialog", "production-integration-routes-refused"], focusObservation, focusScope: "Focus restoration is recorded for the later design audit; E12-T00 changes no member-dialog focus implementation and makes no focus-restoration claim.", memberDialogHtml: dom, endpoints, consoleErrors, pageErrors, requestFailures, abortedFollows, screenshot: { path: "human-only-members.png", sha256: createHash("sha256").update(screenshot).digest("hex") }, video: { path: "hosted-supplement.mp4", duration: Number(probe.format.duration), sha256: createHash("sha256").update(await readFile(videoPath)).digest("hex") } };
  await copyFile(new URL(import.meta.url), resolve(output, "hosted-supplement.mjs"));
  await writeFile(resolve(output, "supplement.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(resolve(output, "network.json"), `${JSON.stringify(network, null, 2)}\n`);
  process.stdout.write(`E12_T00_HOSTED_SUPPLEMENT_OK ${JSON.stringify({ origin, revision, scenes: summary.scenes.length, errors: 0 })}\n`);
} finally {
  await context.close();
  await browser.close();
}
