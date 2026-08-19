import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  bootWorld,
  loginWithFixture,
  replayChromiumPath,
  type GuardedPage,
} from "@eforest/browser-verify";
import { UnauthorizedError, type AuthorizationVerifier } from "@eforest/platform";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-4-the-roots/E4-T12-two-machines-one-branch");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work/e4-t12-browser");
const controlPath = resolve(work, "live-control.json");
const runOutput = resolve(work, "live-run.json");
const subject = {
  id: "e4-t12-browser",
  email: "e4-t12-browser@canopy.test",
  password: "E4T12Browser1234!",
  name: "E4 T12 Browser",
};
const browserSubject = `auth0|${subject.id}`;
function subjectForHeader(header: string | null): string {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token === "local-token") return "machine-a";
  if (token === "remote-token") return "machine-b";
  return browserSubject;
}

await mkdir(work, { recursive: true });
await writeFile(controlPath, "{}\n");

let identityView = { users: {}, orgs: {}, memberships: {}, grants: {}, sessions: {} };
let identityOffset = "-1";
let mutationOrdinal = 0;
const gatewayVerifier: AuthorizationVerifier = {
  async verifyAuthorization(header: string | null) {
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token !== undefined && token !== "local-token" && token !== "remote-token")
      throw new UnauthorizedError("invalid_signature");
    return { sub: subjectForHeader(header) };
  },
  async authorizationContext(header: string | null) {
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token !== undefined && token !== "local-token" && token !== "remote-token")
      throw new UnauthorizedError("invalid_signature");
    return {
      principal: { kind: "identified" as const, sub: subjectForHeader(header) },
      identity: identityView,
      identityOffset,
    };
  },
  async withAuthorizedMutation(header, _plan, mutation) {
    const identity = await this.verifyAuthorization(header);
    mutationOrdinal += 1;
    return mutation(
      identity,
      `e4-t12-browser-operation-${String(mutationOrdinal).padStart(4, "0")}`,
      async () => undefined,
    );
  },
};

const world = await bootWorld({
  root,
  subject,
  fixtureLogin: true,
  proofReceiptPath: resolve(work, "proof-receipt.json"),
  gatewayVerifier,
  gatewayDecideAuthorization: (input) => ({
    allowed: true,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write",
    streamId: input.target.kind === "repo" ? input.target.streamId : "test",
  }),
});
await world.seedPublicRepo({
  org: "e4",
  project: "convergence",
  repo: "convergence",
  branch: "main",
});
const identitySnapshot = await world.snapshotIdentity();
identityView = identitySnapshot.view;
identityOffset = identitySnapshot.offset;

const child = spawn(
  process.execPath,
  [
    resolve(root, "tools/verify/e4-sync/run.mjs"),
    "--seed",
    "1",
    "--profile",
    "offline",
    "--mode",
    "lockstep",
    "--scenario",
    "mixed",
    "--capstone",
    "--convergence-bound-ms",
    "10000",
    "--stream-url",
    world.streamUrl,
    "--platform-url",
    world.platformUrl,
    "--browser-control",
    controlPath,
    "--out",
    runOutput,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let childStderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => (childStderr += chunk));

async function control(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(controlPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
async function waitControl(
  key: string,
  expected: unknown,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await control();
    if (state[key] === expected) return state;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`browser control timeout key=${key} expected=${String(expected)}`);
}
async function patchControl(patch: Record<string, unknown>): Promise<void> {
  await writeFile(controlPath, `${JSON.stringify({ ...(await control()), ...patch })}\n`);
}
async function openLiveViewer(guarded: GuardedPage): Promise<void> {
  await guarded.page.goto(world.platformUrl);
  await loginWithFixture(guarded.page);
  await guarded.page.goto(`${world.platformUrl}/e4/convergence/blob/main/docs/readme.txt`);
  await guarded.page.getByTestId("file-content").waitFor();
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-stream-status") ===
      "live",
  );
}
async function checkpoint(page: GuardedPage["page"]): Promise<string> {
  const value = await page.getByTestId("file-viewer").getAttribute("data-application-checkpoint");
  assert.ok(value);
  return value;
}

const replayProfile = resolve(work, "replay-profile");
const replayDirectory = resolve(work, "replay-recordings");
const replayPort = 62317;
await rm(replayProfile, { recursive: true, force: true });
await rm(replayDirectory, { recursive: true, force: true });
await mkdir(replayDirectory, { recursive: true });
const replayProcess = spawn(
  replayChromiumPath(),
  [
    world.platformUrl,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${String(replayPort)}`,
    `--user-data-dir=${replayProfile}`,
  ],
  {
    env: {
      ...process.env,
      RECORD_ALL_CONTENT: "1",
      RECORD_REPLAY_DIRECTORY: replayDirectory,
      RECORD_REPLAY_METADATA: JSON.stringify({
        title: "e4-t12-final",
        claim: "two-machines-one-branch",
      }),
      RECORD_REPLAY_VERBOSE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let replayStderr = "";
replayProcess.stderr?.setEncoding("utf8");
replayProcess.stderr?.on("data", (chunk) => (replayStderr += chunk));
const replayDeadline = Date.now() + 30_000;
while (Date.now() < replayDeadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(replayPort)}/json/version`);
    if (response.ok) break;
  } catch {
    // The DevTools endpoint is not ready until Chromium finishes starting.
  }
  await new Promise((done) => setTimeout(done, 100));
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(replayPort)}`);
const guarded = await world.openPage(browser);
const navigations: string[] = [];
const errors: string[] = [];
guarded.page.on("request", (request) => {
  if (request.isNavigationRequest() && request.resourceType() === "document")
    navigations.push(request.url());
});
guarded.page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
guarded.page.on("response", (response) => {
  if (response.status() >= 400) errors.push(`${String(response.status())} ${response.url()}`);
});
guarded.page.on("pageerror", (error) => errors.push(error.message));

try {
  await waitControl("harnessReady", true);
  await openLiveViewer(guarded);
  navigations.length = 0;
  const beforeLive = await checkpoint(guarded.page);
  await patchControl({ browserReady: true });
  await guarded.page.waitForFunction((before) => {
    const current = document
      .querySelector('[data-testid="file-viewer"]')
      ?.getAttribute("data-application-checkpoint");
    return current !== null && current !== before;
  }, beforeLive);
  const afterLive = await checkpoint(guarded.page);
  const partitionState = await waitControl("phase", "partition");
  assert.equal(typeof partitionState.partitionHeadOffset, "string");
  await patchControl({ partitionReady: true });
  await waitControl("partitionComplete", true);
  await guarded.page.waitForFunction((before) => {
    const current = document
      .querySelector('[data-testid="file-viewer"]')
      ?.getAttribute("data-application-checkpoint");
    return current !== null && current !== before;
  }, afterLive);
  const partitionVisible = await checkpoint(guarded.page);
  const partitionSamples: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    partitionSamples.push(await checkpoint(guarded.page));
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.deepEqual(new Set(partitionSamples), new Set([partitionVisible]));
  await patchControl({ reunionReady: true });
  await waitControl("phase", "reunion");
  const done = await waitControl("harnessDone", true);
  await guarded.page
    .getByTestId("file-breadcrumbs")
    .getByRole("link", { name: "File tree", exact: true })
    .click();
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.getByRole("link", { name: "docs/", exact: true }).click();
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.getByText(/mixed-conflict\.bin\.conflict-/).waitFor();
  const finalOffset = await guarded.page
    .getByTestId("tree-browser")
    .getAttribute("data-application-checkpoint");
  const finalDigest = await guarded.page
    .getByTestId("tree-browser")
    .getAttribute("data-state-digest");
  assert.ok(finalOffset && finalDigest);
  assert.equal(finalOffset, done.finalHeadOffset);
  assert.deepEqual(errors, []);
  assert.equal(navigations.length, 0);
  const transcript = [
    "E4-T12 browser capstone live harness",
    `phase=live before=${beforeLive} after=${afterLive}`,
    `phase=partition before=${afterLive} visible=${partitionVisible} samples=${partitionSamples.join(",")} stable=true`,
    `phase=reunion final=${finalOffset} digest=${finalDigest} conflict-visible=true`,
    "console-errors=0 document-navigations=0",
    "source=two watcher processes against the browser world's live Durable Stream",
  ].join("\n");
  await writeFile(resolve(work, "transcript.txt"), `${transcript}\n`);
  await writeFile(resolve(evidence, "e4-t12-browser.txt"), `${transcript}\n`);
  await patchControl({ browserDone: true });
  console.log(transcript);
} catch (error) {
  await writeFile(
    resolve(work, "failure-page.txt"),
    `url=${guarded.page.url()}\ntitle=${await guarded.page.title()}\n${await guarded.page
      .locator("body")
      .innerText()
      .catch(() => "<body unavailable>")}\n`,
  );
  await patchControl({ browserDone: true, browserError: String(error), childStderr });
  throw error;
} finally {
  await guarded.close();
  await browser.close();
  if (replayProcess.exitCode === null) replayProcess.kill("SIGTERM");
  await new Promise<void>((resolveExit) => {
    if (replayProcess.exitCode !== null) resolveExit();
    else replayProcess.once("exit", () => resolveExit());
  });
  execFileSync("replayio", ["upload", "--all"], { stdio: "ignore" });
  if (child.exitCode === null) child.kill("SIGTERM");
  await world.close();
}
process.exit(0);
