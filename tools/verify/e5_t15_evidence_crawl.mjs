#!/usr/bin/env node
// E5-T15 evidence-attribute crawl: the same frozen stream state, two web bundles.
//
//   node tools/verify/e5_t15_evidence_crawl.mjs --baseline <dist> --candidate <dist> --out <dir>
//
// Boots the E5-T14 preview world ONCE (one seeded stream data directory, one signed-in
// session), then serves the baseline bundle and the candidate bundle in turn by pointing
// apps/web/dist at each (a symlink swap; the platform reads the web root per request).
// No dispatch happens between the two crawls, so both render identical stream state. For
// every route it records every evidence attribute (data-ef-*, *-digest, *-offset,
// data-reducer-version, data-dispatches-*, data-code, *-checkpoint, data-page-revision)
// as sorted JSON rows [route, element key, attribute, value] into <out>/baseline.json and
// <out>/candidate.json. The claim is `cmp baseline.json candidate.json` → exit 0.
// A missing, extra or changed evidence row makes the files differ.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const baselineDist = option("--baseline");
const candidateDist = option("--candidate");
const out = option("--out");
if (baselineDist === undefined || candidateDist === undefined || out === undefined) {
  console.error(
    "usage: e5_t15_evidence_crawl.mjs --baseline <dist> --candidate <dist> --out <dir>",
  );
  process.exit(2);
}
const [width, height] = (option("--viewport") ?? "1440x900").split("x").map(Number);
const chrome =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ROUTES = [
  "/",
  "/organizations/maple",
  "/maple/reading-room",
  "/maple/reading-room/tree/main",
  "/maple/reading-room/tree/main/apps",
  "/maple/reading-room/blob/main/README.md",
  "/maple/reading-room/blob/main/apps/web/product.ts",
  "/maple/reading-room/history/main",
  "/inspect/maple/reading-room/main",
  "/orgs/maple/repos/reading-room/pulls",
  "/orgs/maple/repos/reading-room/pulls/60",
  "/orgs/maple/repos/reading-room/pulls/60/commits",
  "/orgs/maple/repos/reading-room/pulls/60/checks",
  "/orgs/maple/repos/reading-room/pulls/60/changes",
  "/orgs/maple/repos/reading-room/pulls/56",
  "/orgs/maple/repos/reading-room/issues",
  "/orgs/maple/repos/reading-room/issues/visual-capstone",
  "/orgs/maple/repos/reading-room/labels",
  "/orgs/maple/repos/reading-room/wiki",
  "/orgs/maple/repos/reading-room/wiki/home",
  "/orgs/maple/repos/reading-room/wiki/home/edit",
  "/orgs/maple/repos/reading-room/wiki/missing-page",
  "/orgs/maple/repos/reading-room/settings",
  "/members/maple",
  "/chat/maple/general",
  "/maple/unknown-repo",
  "/lost/deep/trail",
];

const EVIDENCE =
  /^data-(ef-[a-z-]+|[a-z-]*digest|[a-z-]*offset|reducer-version|dispatches-[a-z]+|code|[a-z-]*checkpoint|page-revision)$/;

const dist = resolve(root, "apps/web/dist");
const parked = resolve(root, "apps/web/dist.e5-t15-crawl-parked");

function pointDistAt(target) {
  if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) rmSync(dist);
  symlinkSync(resolve(target), dist, "dir");
}

function restoreDist() {
  if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) rmSync(dist);
  if (existsSync(parked)) renameSync(parked, dist);
}

async function startWorld() {
  const child = spawn(
    process.execPath,
    [resolve(root, "apps/web/test/fixtures/e5-t14-preview-server.mjs")],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "test", EF_PREVIEW_SESSION_TTL: "3600" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stderr.on("data", () => undefined);
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`preview timeout\n${stdout}`)), 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("E5_T14_READY "));
      if (line !== undefined) {
        clearTimeout(timer);
        resolveReady(JSON.parse(line.slice("E5_T14_READY ".length)));
      }
    });
    child.once("exit", (code) => reject(new Error(`preview exited ${String(code)}\n${stdout}`)));
  });
  return { child, ready };
}

async function snapshot(page, route) {
  return page.evaluate(
    ({ route, evidence }) => {
      const pattern = new RegExp(evidence);
      const seen = new Map();
      const rows = [];
      for (const element of globalThis.document.querySelectorAll("*")) {
        const names = element.getAttributeNames().filter((name) => pattern.test(name));
        if (names.length === 0) continue;
        const base =
          element.getAttribute("data-testid") ??
          `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`;
        const ordinal = seen.get(base) ?? 0;
        seen.set(base, ordinal + 1);
        for (const name of names)
          rows.push([route, `${base}[${String(ordinal)}]`, name, element.getAttribute(name) ?? ""]);
      }
      return rows;
    },
    { route, evidence: EVIDENCE.source },
  );
}

async function settle(page, route) {
  const deadline = Date.now() + 45_000;
  let previous = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      loading: globalThis.document.querySelector('[data-testid="route-loading"]') !== null,
      pending: [...globalThis.document.querySelectorAll("[data-stream-status]")].filter((node) => {
        const status = node.getAttribute("data-stream-status") ?? "";
        return status === "loading" || status === "reconnecting";
      }).length,
    }));
    const rows = JSON.stringify(await snapshot(page, route));
    if (!state.loading && state.pending === 0 && rows === previous) {
      stable += 1;
      if (stable >= 3) return JSON.parse(rows);
    } else {
      stable = 0;
    }
    previous = rows;
    await page.waitForTimeout(500);
  }
  throw new Error(`${route} did not settle`);
}

async function crawl(page, base, label) {
  const rows = [];
  for (const route of ROUTES) {
    await page.goto(`${base}${route}`);
    rows.push(...(await settle(page, route)));
    if (process.env.E5_T15_CRAWL_DEBUG === "1") {
      await page.screenshot({
        path: resolve(out, `${label}${route.replace(/[^a-z0-9]+/gi, "_")}.png`),
      });
    }
    process.stdout.write(`${label} ${route} ok\n`);
  }
  rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return rows;
}

await mkdir(resolve(out), { recursive: true });
if (existsSync(dist) && !lstatSync(dist).isSymbolicLink()) renameSync(dist, parked);
const candidate = resolve(candidateDist) === dist ? parked : resolve(candidateDist);
let world;
let browser;
try {
  pointDistAt(resolve(baselineDist));
  world = await startWorld();
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const debug = process.env.E5_T15_CRAWL_DEBUG === "1";
  if (debug) {
    page.on("pageerror", (error) => process.stdout.write(`PAGEERROR ${error.message}\n`));
    page.on("console", (message) => {
      if (message.type() === "error")
        process.stdout.write(`CONSOLE ${message.text().slice(0, 240)}\n`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        process.stdout.write(`HTTP ${String(response.status())} ${response.url()}\n`);
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const base = world.ready.url;
  await page.goto(`${base}/auth/login`);
  await page.locator("button", { hasText: world.ready.subject }).first().click();
  await page.waitForURL((url) => url.href.startsWith(base), { timeout: 30_000 });
  const baselineRows = await crawl(page, base, "baseline");
  pointDistAt(candidate);
  const candidateRows = await crawl(page, base, "candidate");
  const encode = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(resolve(out, "baseline.json"), encode(baselineRows));
  await writeFile(resolve(out, "candidate.json"), encode(candidateRows));
  const same = readFileSync(resolve(out, "baseline.json")).equals(
    readFileSync(resolve(out, "candidate.json")),
  );
  process.stdout.write(
    `E5_T15_EVIDENCE_CRAWL routes=${String(ROUTES.length)} baseline_rows=${String(baselineRows.length)} candidate_rows=${String(candidateRows.length)} identical=${String(same)}\n`,
  );
} finally {
  await browser?.close();
  world?.child.kill("SIGTERM");
  restoreDist();
}
