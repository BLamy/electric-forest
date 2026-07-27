import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  bootWorld,
  browserSessionSecretForAttacks,
  collectEfRegions,
  loginAs,
  replayChromiumPath,
  type BrowserWorld,
} from "@eforest/browser-verify";
import { signedSessionCookie } from "@eforest/platform";
import { canonicalJson } from "@eforest/protocol";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const transcriptPath = resolve(evidence, "e3-t02-shell-playwright.txt");
const neutralityPath = resolve(evidence, "e3-t02-whoami-neutrality.txt");
const dumpPath = resolve(work, "e3-t02-identity.jsonl");
const subject = {
  id: "ada-shell",
  email: "ada.shell@canopy.test",
  password: "AdaShell1234!",
  name: "Ada Shell",
};

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });

async function truth(world: BrowserWorld): Promise<{
  readonly offset: string;
  readonly count: number;
  readonly digest: string;
}> {
  const snapshot = await world.snapshotIdentity();
  return { offset: snapshot.offset, count: snapshot.events.length, digest: snapshot.digest };
}

async function cliDigest(world: BrowserWorld): Promise<string> {
  const records = await world.dumpIdentity();
  await writeFile(dumpPath, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
  const result = await run(
    process.execPath,
    [
      resolve(root, "packages/cli/dist/src/bin.js"),
      "replay",
      dumpPath,
      "--digest",
      "--reducer",
      resolve(root, "packages/identity/reducer.mjs"),
    ],
    { cwd: root },
  );
  return result.stdout.trim();
}

async function manual(world: BrowserWorld, path: string, cookie?: string): Promise<Response> {
  return await fetch(`${world.platformUrl}${path}`, {
    redirect: "manual",
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function routeStatus(
  world: BrowserWorld,
  cookie: string,
  path: string,
): Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
}> {
  const response = await manual(world, path, cookie);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    text: await response.text(),
  };
}

async function builtText(): Promise<string> {
  const dist = resolve(root, "apps/web/dist");
  const assets = resolve(dist, "assets");
  const files = await readdir(assets);
  const contents = await Promise.all(
    files
      .filter((file) => /\.(?:js|css|map)$/.test(file))
      .map((file) => readFile(resolve(assets, file), "utf8")),
  );
  return contents.join("\n");
}

const isolation = await Promise.all([
  bootWorld({ root, subject: { ...subject, id: "isolation-a", email: "a@isolation.test" } }),
  bootWorld({ root, subject: { ...subject, id: "isolation-b", email: "b@isolation.test" } }),
]);
try {
  assert.notEqual(isolation[0].platformUrl, isolation[1].platformUrl);
  assert.notEqual(isolation[0].streamUrl, isolation[1].streamUrl);
  assert.notEqual(isolation[0].emulatorUrl, isolation[1].emulatorUrl);
  assert.notEqual(isolation[0].dataDir, isolation[1].dataDir);
} finally {
  await Promise.all(isolation.map((world) => world.close()));
}

const activeWorld = await bootWorld({ root, subject });
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await activeWorld.openPage(browser);
let transcript = "E3-T02 shell proof\nisolation worlds=2 distinct-ports+data-dirs: OK\n";
let neutrality = "E3-T02 /api/whoami refusal neutrality\n";
try {
  const before = await truth(activeWorld);
  for (const path of ["/", "/maple", "/maple/reading-room", "/index.html"]) {
    const response = await manual(activeWorld, path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), "/auth/login", path);
    transcript += `unauth ${path} status=302 location=/auth/login: OK\n`;
  }
  const index = await readFile(resolve(root, "apps/web/dist/index.html"), "utf8");
  const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(index)?.[1];
  assert.ok(asset);
  const assetResponse = await manual(activeWorld, asset);
  assert.equal(assetResponse.status, 302);
  assert.equal(assetResponse.headers.get("location"), "/auth/login");
  transcript += `unauth emitted-asset ${asset} status=302: OK\n`;

  const absent = await manual(activeWorld, "/api/whoami");
  assert.equal(absent.status, 401);
  assert.equal(absent.headers.get("content-type"), "application/json");
  assert.deepEqual(await absent.json(), { error: { class: "auth-refused" } });
  const forgedCookie = signedSessionCookie(
    browserSessionSecretForAttacks(),
    "fabricated-session",
    60,
  ).split(";")[0]!;
  const forged = await manual(activeWorld, "/api/whoami", forgedCookie);
  assert.equal(forged.status, 401);
  assert.deepEqual(await forged.json(), { error: { class: "auth-refused" } });
  const after = await truth(activeWorld);
  assert.deepEqual(after, before);
  neutrality += `before offset=${before.offset} count=${String(before.count)} digest=${before.digest}\n`;
  neutrality += 'absent status=401 body={"error":{"class":"auth-refused"}}\n';
  neutrality +=
    'forged-valid-hmac/fabricated-session status=401 body={"error":{"class":"auth-refused"}}\n';
  neutrality += `after offset=${after.offset} count=${String(after.count)} digest=${after.digest}\nneutral=true\n`;
  transcript += `whoami refusal neutrality offset=${before.offset} count=${String(before.count)} digest=${before.digest}: OK\n`;

  await guarded.page.goto(activeWorld.platformUrl);
  await loginAs(guarded.page, subject);
  const snapshot = await activeWorld.snapshotIdentity();
  const user = snapshot.view.users[`auth0|${subject.id}`];
  assert.ok(user);
  assert.equal(await guarded.page.getByTestId("identity-sub").textContent(), `auth0|${subject.id}`);
  assert.equal(await guarded.page.getByTestId("identity-email").textContent(), user.email);
  const regions = await collectEfRegions(guarded.page);
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.stream, activeWorld.identity.streamId);
  assert.equal(regions[0]!.offset, await activeWorld.headIdentity());
  assert.equal(regions[0]!.offset, snapshot.offset);
  assert.equal(regions[0]!.digest, await cliDigest(activeWorld));
  assert.equal(regions[0]!.digest, snapshot.digest);
  const liveSessionCookie = (await guarded.context.cookies(activeWorld.platformUrl)).find(
    (cookie) => cookie.name === "ef_session",
  );
  assert.ok(liveSessionCookie);
  const liveCookieHeader = `${liveSessionCookie.name}=${liveSessionCookie.value}`;
  transcript += `login subject=auth0|${subject.id} email=${subject.email}: OK\n`;
  transcript += `region stream=${regions[0]!.stream} offset=${regions[0]!.offset} digest=${regions[0]!.digest} cli-replay=head: OK\n`;
  transcript += "partial-triple-sweep regions=1 partial=0: OK\n";

  assert.equal(await guarded.page.evaluate(() => document.cookie.includes("ef_session")), false);
  assert.deepEqual(
    await guarded.page.evaluate(async () => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      indexedDb: typeof indexedDB.databases === "function" ? await indexedDB.databases() : [],
    })),
    { local: [], session: [], indexedDb: [] },
  );
  transcript += "browser-storage local=0 session=0 indexeddb=0 document.cookie-session=false: OK\n";

  const initialNavigations = await guarded.page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  assert.equal(initialNavigations, 1);
  await guarded.page.getByRole("link", { name: "Maple" }).click();
  await guarded.page.getByTestId("route-org").waitFor();
  await guarded.page.getByRole("link", { name: "Reading room" }).click();
  await guarded.page.getByTestId("route-repo").waitFor();
  await guarded.page.goBack();
  await guarded.page.getByTestId("route-org").waitFor();
  await guarded.page.goForward();
  await guarded.page.getByTestId("route-repo").waitFor();
  await guarded.page.getByRole("link", { name: "Missing trail" }).click();
  await guarded.page.getByTestId("route-not-found").waitFor();
  assert.equal(
    await guarded.page.evaluate(() => performance.getEntriesByType("navigation").length),
    1,
  );
  transcript += "spa routes home>org>repo>back>forward>404 document-loads=1: OK\n";

  const deep = await guarded.context.newPage();
  await deep.goto(`${activeWorld.platformUrl}/maple/reading-room`);
  await deep.getByTestId("route-repo").waitFor();
  await deep.getByTestId("identity-region").waitFor();
  assert.equal((await collectEfRegions(deep)).length, 1);
  assert.equal(await deep.evaluate(() => performance.getEntriesByType("navigation").length), 1);
  transcript += "authenticated deep-link /maple/reading-room index+shell: OK\n";

  for (const path of [
    "/api/nonexistent",
    "/auth/nonexistent",
    "/..%2fpackage.json",
    "/%2e%2e/package.json",
  ]) {
    const result = await routeStatus(activeWorld, liveCookieHeader, path);
    assert.equal(result.status, 404, path);
    assert.match(result.contentType ?? "", /^application\/json/, path);
    assert.ok(!result.text.toLowerCase().includes("<!doctype html>"), path);
    transcript += `reserved/traversal ${path} status=404 json=true: OK\n`;
  }

  const bundle = await builtText();
  assert.ok(!/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(bundle));
  assert.ok(!bundle.includes("code_verifier"));
  assert.ok(!bundle.includes("ef_session"));
  assert.ok(!guarded.network.some((line) => /\beyJ[A-Za-z0-9_-]{8,}\./.test(line)));
  assert.ok(!guarded.network.some((line) => /code_verifier|ef_session/.test(line)));
  transcript += `credential-scan bundle-bytes=${String(bundle.length)} network-lines=${String(guarded.network.length)} jwt=0 verifier=0 session=0: OK\n`;

  await guarded.page.getByRole("button", { name: "Log out" }).click();
  await guarded.page.getByTestId("auth0-login-form").waitFor();
  assert.equal(
    (await guarded.context.cookies(activeWorld.platformUrl)).some(
      (cookie) => cookie.name === "ef_session",
    ),
    false,
  );
  transcript += "logout ended-session cookie-cleared login-form-visible: OK\n";

  guarded.assertClean();
  transcript += "console.error=0 pageerror=0 requestfailed=0 non-loopback=0: OK\n";
  await writeFile(transcriptPath, transcript);
  await writeFile(neutralityPath, neutrality);
  process.stdout.write(transcript);
} finally {
  await guarded.close();
  await browser.close();
  await activeWorld.close();
}
