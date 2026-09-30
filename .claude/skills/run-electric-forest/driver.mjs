#!/usr/bin/env node
// Drive a running electric-forest stack: log in through the emulated Auth0 and screenshot
// one or more app paths.
//
//   node .claude/skills/run-electric-forest/driver.mjs --log <app.log> [--out dir] [path ...]
//   node .claude/skills/run-electric-forest/driver.mjs --url http://127.0.0.1:PORT [path ...]
//   extra flags: --wait <max ms per page, default 30000>  --email <emulated Auth0 user>
//
// --log reads the `E5_T14_READY {...}` line the preview fixture prints; --url skips that.
// Paths default to "/" and the seeded repo. Screenshots land in --out (default: cwd).
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const logPath = flag("--log");
let base = flag("--url");
const out = resolve(flag("--out") ?? ".");
const waitMs = Number(flag("--wait") ?? "30000");
const email = flag("--email") ?? "brett@electric-forest.test";
const chrome =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (base === undefined) {
  if (logPath === undefined) throw new Error("pass --log <app.log> or --url <platform url>");
  const line = readFileSync(logPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith("E5_T14_READY "));
  if (line === undefined) throw new Error(`no E5_T14_READY line in ${logPath} yet`);
  base = JSON.parse(line.slice("E5_T14_READY ".length)).url;
}
const paths = args.length > 0 ? args : ["/", "/maple/reading-room"];
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// "/" is public (no redirect without a session), so start at /auth/login explicitly. It
// redirects to emulated Auth0 /authorize: a button-per-user picker with no password field.
await page.goto(`${base}/auth/login`);
if (page.url().includes("/authorize")) {
  await page.locator("button", { hasText: email }).first().click();
  await page.waitForURL((u) => u.href.startsWith(base), { timeout: 20_000 });
} else {
  throw new Error(`expected Auth0 /authorize after /auth/login, got ${page.url()}`);
}
console.log(`logged in as ${email} -> ${page.url()}`);

for (const [i, path] of paths.entries()) {
  await page.goto(`${base}${path}`);
  // Never use waitForLoadState("networkidle"): live stream subscriptions keep it busy forever.
  // Instead wait out the lazy-route placeholder (the repo Code chunk can take >10s cold).
  await page.waitForTimeout(1000);
  const settled = await page
    .getByText("Loading route", { exact: false })
    .first()
    .waitFor({ state: "detached", timeout: waitMs })
    .then(() => true)
    .catch(() => false);
  if (!settled) console.log(`  still "Loading route..." after ${waitMs}ms`);
  await page.waitForTimeout(1000);
  const file = resolve(out, `shot-${i}-${path.replace(/[^a-z0-9]+/gi, "_") || "root"}.png`);
  await page.screenshot({ path: file });
  console.log(`${path} -> ${page.url()} "${await page.title()}" ${file}`);
}
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
await browser.close();
