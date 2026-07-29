import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const task = resolve(root, ".eforest/tasks/epic-2-the-gates/E2-T12-the-locked-gate");
const evidence = resolve(task, "evidence");
const update = process.env.E2_T12_UPDATE_GOLDENS === "1";
const platformUrl = `http://127.0.0.1:${process.env.E2_T12_PLATFORM_PORT ?? "47122"}`;
const replayChromium = resolve(
  homedir(),
  ".replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium",
);
const executablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? replayChromium;
assert.ok(existsSync(executablePath), `browser executable missing: ${executablePath}`);

const server = spawn(process.execPath, [resolve(root, "tools/verify/e2_t12_server.mjs")], {
  cwd: root,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverStderr = "";
server.stderr.on("data", (chunk) => {
  serverStderr += String(chunk);
});
const ready = new Promise<void>((resolveReady, rejectReady) => {
  const lines = createInterface({ input: server.stdout });
  const timer = setTimeout(
    () => rejectReady(new Error("E2-T12 server readiness timed out")),
    30_000,
  );
  lines.on("line", (line) => {
    if (line.includes('"status":"E2_T12_READY"')) {
      clearTimeout(timer);
      resolveReady();
    }
  });
  server.once("exit", (code) => {
    clearTimeout(timer);
    rejectReady(new Error(`E2-T12 server exited ${String(code)}: ${serverStderr}`));
  });
});

function loopback(value: string): boolean {
  const url = new URL(value);
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

async function replaceByKeyboard(page: Page, testId: string, value: string): Promise<void> {
  const input = page.getByTestId(testId);
  await input.click();
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.type(value);
}

async function proofAction(page: Page, testId: string): Promise<Record<string, unknown>> {
  const log = page.getByTestId("proof-log");
  const previous = await log.textContent();
  await page.getByTestId(testId).click();
  await log.waitFor();
  await page.waitForFunction(
    ({ prior }) => document.querySelector('[data-testid="proof-log"]')?.textContent !== prior,
    { prior: previous },
  );
  return JSON.parse((await log.textContent()) ?? "{}") as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBytes);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      key === "bytes" || key === "dump"
        ? [`${key}Sha256`, sha256(String(item))]
        : [key, withoutBytes(item)],
    ),
  );
}

await ready;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
const browserRequests: string[] = [];
const consoleErrors: string[] = [];
await context.route("**/*", async (route) => {
  const url = route.request().url();
  if (!loopback(url)) {
    await route.abort("blockedbyclient");
    throw new Error(`browser attempted non-loopback request: ${url}`);
  }
  browserRequests.push(`${route.request().method()} ${url}`);
  await route.continue();
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  await page.goto(platformUrl);
  await page.getByTestId("login").click();
  await page.getByTestId("auth0-login-form").waitFor();
  await replaceByKeyboard(page, "auth0-login-email", "gate@example.test");
  await replaceByKeyboard(page, "auth0-login-password", "LockedGate1234!");
  await Promise.all([
    page.waitForURL((url) => url.origin === platformUrl && url.pathname === "/"),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  await page.locator('[data-auth-state="logged-in"]').waitFor();
  await page.getByTestId("cli-tokens-link").click();
  await page.locator('input[name="name"]').click();
  await page.locator('input[name="name"]').type("capstone workstation");
  await page.getByRole("button", { name: "Mint token" }).click();
  const secretNode = page.getByTestId("cli-token-secret");
  await secretNode.waitFor({ state: "visible" });
  const token = (await secretNode.textContent()) ?? "";
  assert.match(token, /^ef_cli_/);
  const item = page.getByTestId("cli-token-list").locator("li");
  await item.waitFor();
  const grantId = (await item.getAttribute("data-grant-id")) ?? "";
  assert.match(grantId, /^grant_/);

  await page.goto(`${platformUrl}/__e2_t12`);
  await replaceByKeyboard(page, "grant-id", grantId);
  await replaceByKeyboard(page, "cli-token", token);
  const mint = await proofAction(page, "register-token");
  assert.equal(mint.rawSecretStored, false);
  const authorized = await proofAction(page, "authorized-cli");
  assert.equal((authorized.cli as { exitCode?: unknown }).exitCode, 0);
  assert.equal(
    (authorized.after as { count: number }).count,
    (authorized.before as { count: number }).count + 1,
  );
  const tokenless = await proofAction(page, "tokenless");
  assert.equal(tokenless.status, 401);
  assert.equal(tokenless.byteIdentical, true);

  await page.getByTestId("tokens-link").click();
  await page.getByRole("button", { name: "Revoke" }).click();
  await item.waitFor({ state: "detached" });
  await page.goto(`${platformUrl}/__e2_t12`);
  const revoked = await proofAction(page, "revoked-cli");
  assert.equal((revoked.cli as { exitCode?: unknown }).exitCode, 13);
  assert.equal(revoked.byteIdentical, true);
  const stateResponse = await fetch(`${platformUrl}/__e2_t12/state`);
  const state = (await stateResponse.json()) as {
    readonly network: {
      readonly nonLoopback: number;
      readonly observations: readonly string[];
    };
    readonly steps: {
      readonly authorized: {
        readonly before: {
          readonly bytes: string;
          readonly offset: string;
          readonly digest: string;
        };
        readonly after: {
          readonly bytes: string;
          readonly offset: string;
          readonly digest: string;
        };
      };
      readonly tokenless: { readonly after: { readonly bytes: string } };
      readonly revoked: { readonly after: { readonly bytes: string } };
    };
  };
  assert.equal(state.network.nonLoopback, 0);
  assert.equal(
    state.steps.authorized.after.bytes,
    state.steps.tokenless.after.bytes,
    "tokenless request mutated the target stream",
  );
  assert.equal(
    state.steps.authorized.after.bytes,
    state.steps.revoked.after.bytes,
    "revoked request mutated the target stream",
  );
  assert.equal(consoleErrors.length, 0, consoleErrors.join("\n"));
  assert.ok(browserRequests.length > 0);
  assert.ok(browserRequests.every((entry) => loopback(entry.slice(entry.indexOf(" ") + 1))));

  const transcript = {
    ...withoutBytes(state),
    network: {
      nonLoopback: state.network.nonLoopback,
      origins: [
        ...new Set(
          state.network.observations.map((entry) => {
            const url = entry.slice(entry.indexOf(" ") + 1);
            return new URL(url).origin;
          }),
        ),
      ].sort(),
    },
    browser: {
      consoleErrors: 0,
      nonLoopbackRequests: 0,
    },
  };
  const files = new Map<string, string>([
    ["e2-t12-before.raw.json", state.steps.authorized.before.bytes],
    ["e2-t12-after.raw.json", state.steps.authorized.after.bytes],
    ["e2-t12-after.jsonl", (state.steps.authorized.after as { readonly dump: string }).dump],
    ["e2-t12-capstone.json", `${JSON.stringify(transcript, null, 2)}\n`],
  ]);
  await mkdir(evidence, { recursive: true });
  if (update) {
    for (const [name, contents] of files) await writeFile(resolve(evidence, name), contents);
  } else {
    for (const [name, contents] of files) {
      assert.equal(await readFile(resolve(evidence, name), "utf8"), contents, `${name} drifted`);
    }
  }
  process.stdout.write(
    `E2_T12_BROWSER_OK before-offset=${state.steps.authorized.before.offset} before-digest=${state.steps.authorized.before.digest} after-offset=${state.steps.authorized.after.offset} after-digest=${state.steps.authorized.after.digest} console-errors=0 non-loopback=0\n`,
  );
} finally {
  await context.close();
  await browser.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolveExit) => server.once("exit", () => resolveExit()));
}
