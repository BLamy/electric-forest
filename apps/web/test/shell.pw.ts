import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  bootWorld,
  browserSessionSecretForAttacks,
  collectEfRegions,
  loginWithFixture,
  replayChromiumPath,
  scanCredentialLeaks,
  type BrowserWorld,
} from "@eforest/browser-verify";
import { pkceChallenge, signedSessionCookie } from "@eforest/platform";
import { canonicalJson } from "@eforest/protocol";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const transcriptPath = resolve(evidence, "e3-t02-shell-playwright.txt");
const neutralityPath = resolve(evidence, "e3-t02-whoami-neutrality.txt");
const digestPath = resolve(evidence, "e3-t02-independent-digest.txt");
const committedDumpPath = resolve(evidence, "e3-t02-identity-replay.jsonl");
const pkcePath = resolve(evidence, "e3-t02-pkce.txt");
const visualPath = resolve(evidence, "e3-t02-neutral-shell.txt");
const dumpPath = resolve(work, "e3-t02-identity.jsonl");
const proofReceiptPath = resolve(work, "e3-t02-browser-proof-receipt.json");
const subject = {
  id: "ada-shell",
  email: "ada.shell@canopy.test",
  password: "AdaShell1234!",
  name: "Ada Shell",
};

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
await rm(proofReceiptPath, { force: true });

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
  const dump = `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
  await writeFile(dumpPath, dump);
  await writeFile(committedDumpPath, dump);
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

async function assertInlineSourceMap(): Promise<void> {
  const assets = resolve(root, "apps/web/dist/assets");
  const files = await readdir(assets);
  const scripts = files.filter((file) => file.endsWith(".js"));
  assert.ok(scripts.length > 0, "build emitted no JavaScript asset");
  assert.equal(
    files.some((file) => file.endsWith(".js.map")),
    false,
    "build emitted an external JavaScript source map",
  );
  for (const script of scripts) {
    const source = await readFile(resolve(assets, script), "utf8");
    assert.match(
      source,
      /sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,/,
      `${script} does not carry an inline source map`,
    );
  }
}

function assertIdentityRegionTruth(
  regions: readonly { readonly stream: string; readonly offset: string; readonly digest: string }[],
  expected: { readonly stream: string; readonly offset: string; readonly digest: string },
): void {
  assert.equal(regions.length, 1);
  assert.deepEqual(regions[0], expected);
}

async function expectTripwireRed(
  world: BrowserWorld,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  failureClass: "console.error" | "pageerror" | "requestfailed",
): Promise<void> {
  const sabotaged = await world.openPage(browser);
  try {
    await sabotaged.page.goto(world.platformUrl);
    await loginWithFixture(sabotaged.page);
    if (failureClass === "console.error") {
      await sabotaged.page.evaluate(() => console.error("E3-T02a expected-red console"));
    } else if (failureClass === "pageerror") {
      await sabotaged.page.evaluate(() => {
        setTimeout(() => {
          throw new Error("E3-T02a expected-red pageerror");
        }, 0);
      });
    } else {
      await sabotaged.page.route("**/__e3_t02a_expected_red", (route) =>
        route.abort("connectionrefused"),
      );
      await sabotaged.page.evaluate(async () => {
        await fetch("/__e3_t02a_expected_red").catch(() => undefined);
      });
    }
    await sabotaged.page.waitForTimeout(50);
    assert.throws(() => sabotaged.assertClean(), new RegExp(failureClass.replace(".", "\\.")));
  } finally {
    await sabotaged.close();
  }
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

const activeWorld = await bootWorld({
  root,
  subject,
  fixtureLogin: true,
  proofReceiptPath,
});
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
  await loginWithFixture(guarded.page);
  const fixtureRequest = guarded.network.find(
    (entry) =>
      entry.direction === "request" &&
      entry.method === "POST" &&
      new URL(entry.url).pathname === "/__fixture/authorize",
  );
  assert.ok(fixtureRequest?.bodyBase64);
  const fixtureBody = Buffer.from(fixtureRequest.bodyBase64, "base64").toString("utf8");
  assert.equal(fixtureBody.includes("password"), false);
  assert.equal(fixtureBody.includes(subject.password), false);
  assert.equal(fixtureBody.includes("code_challenge"), true);
  transcript +=
    "fixture-login one-click=true browser-password-fields=0 browser-password-wire=0 production-gate=fail-closed: OK\n";
  const authorizeLocation = guarded.network
    .filter((entry) => entry.direction === "response")
    .flatMap((entry) => entry.headers)
    .find(
      ([name, value]) =>
        name.toLowerCase() === "location" &&
        new URL(value, activeWorld.platformUrl).pathname.endsWith("/authorize") &&
        new URL(value, activeWorld.platformUrl).searchParams.has("code_challenge"),
    )?.[1];
  assert.ok(authorizeLocation);
  const authorizeUrl = new URL(authorizeLocation, activeWorld.platformUrl);
  const challenge = authorizeUrl.searchParams.get("code_challenge");
  assert.ok(challenge);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl.searchParams.has("code_verifier"), false);
  const callbackLocation = guarded.network
    .filter((entry) => entry.direction === "response")
    .flatMap((entry) => entry.headers)
    .find(
      ([name, value]) =>
        name.toLowerCase() === "location" &&
        new URL(value, activeWorld.platformUrl).pathname === "/auth/callback" &&
        new URL(value, activeWorld.platformUrl).searchParams.has("code"),
    )?.[1];
  assert.ok(callbackLocation);
  const callbackCode = new URL(callbackLocation, activeWorld.platformUrl).searchParams.get("code");
  assert.ok(callbackCode);
  const tokenRequest = activeWorld.serverNetwork.find(
    (entry) =>
      entry.direction === "request" &&
      entry.method === "POST" &&
      new URL(entry.url).pathname.endsWith("/oauth/token"),
  );
  assert.ok(tokenRequest?.bodyBase64);
  const tokenForm = new URLSearchParams(
    Buffer.from(tokenRequest.bodyBase64, "base64").toString("utf8"),
  );
  const verifier = tokenForm.get("code_verifier");
  assert.ok(verifier);
  assert.equal(pkceChallenge(verifier), challenge);
  assert.equal(tokenForm.get("code"), callbackCode);
  const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
  await writeFile(
    pkcePath,
    `E3-T02 PKCE proof\nmethod=S256\nchallenge=${challenge}\nverifier-sha256=${hash(verifier)}\ncallback-code-sha256=${hash(callbackCode)}\nredemption-code-sha256=${hash(tokenForm.get("code")!)}\nchallenge-matches-verifier=true\ncallback-code-redeemed=true\nverifier-visible-in-browser-wire=false\n`,
  );
  const snapshot = await activeWorld.snapshotIdentity();
  const user = snapshot.view.users[`auth0|${subject.id}`];
  assert.ok(user);
  assert.equal(await guarded.page.getByTestId("identity-sub").textContent(), `auth0|${subject.id}`);
  assert.equal(await guarded.page.getByTestId("identity-email").textContent(), user.email);
  let regions = await collectEfRegions(guarded.page);
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.stream, activeWorld.identity.streamId);
  assert.equal(regions[0]!.offset, await activeWorld.headIdentity());
  assert.equal(regions[0]!.offset, snapshot.offset);
  const independentDigest = await cliDigest(activeWorld);
  assert.equal(regions[0]!.digest, independentDigest);
  assert.equal(regions[0]!.digest, snapshot.digest);
  const dumpBytes = await readFile(committedDumpPath);
  await writeFile(
    digestPath,
    `E3-T02 independent identity replay\nstream=${regions[0]!.stream}\noffset=${regions[0]!.offset}\ndump-sha256=${createHash("sha256").update(dumpBytes).digest("hex")}\ncli-digest=${independentDigest}\ndom-digest=${regions[0]!.digest}\nliteral-equal=true\n`,
  );
  await writeFile(
    proofReceiptPath,
    `${JSON.stringify(
      {
        identityStream: regions[0]!.stream,
        offset: regions[0]!.offset,
        digest: regions[0]!.digest,
        cliDigest: independentDigest,
        cliDigestMatches: independentDigest === regions[0]!.digest,
        pkce: {
          method: "S256",
          challenge,
          redeemed: tokenForm.get("code") === callbackCode,
          verifierExposed: false,
        },
      },
      null,
      2,
    )}\n`,
  );
  await guarded.page.getByTestId("proof-receipt").waitFor();
  assert.equal(await guarded.page.getByTestId("proof-pkce-method").textContent(), "S256");
  assert.equal(await guarded.page.getByTestId("proof-pkce-challenge").textContent(), challenge);
  assert.equal(await guarded.page.getByTestId("proof-code-redeemed").textContent(), "redeemed");
  assert.equal(
    await guarded.page.getByTestId("proof-verifier-exposed").textContent(),
    "not exposed",
  );
  assert.equal(await guarded.page.getByTestId("proof-cli-digest").textContent(), independentDigest);
  assert.equal(
    await guarded.page.getByTestId("proof-dom-digest").textContent(),
    regions[0]!.digest,
  );
  assert.equal(await guarded.page.getByTestId("proof-digest-match").textContent(), "equal");
  transcript +=
    "committed proof panel source=authenticated-sanitized-runtime-state pkce=S256 redeemed=true verifier-exposed=false cli-dom-digest=equal: OK\n";
  const liveSessionCookie = (await guarded.context.cookies(activeWorld.platformUrl)).find(
    (cookie) => cookie.name === "ef_session",
  );
  assert.ok(liveSessionCookie);
  const liveCookieHeader = `${liveSessionCookie.name}=${liveSessionCookie.value}`;
  transcript += `login subject=auth0|${subject.id} email=${subject.email}: OK\n`;
  transcript += `region stream=${regions[0]!.stream} offset=${regions[0]!.offset} digest=${regions[0]!.digest} cli-replay=head: OK\n`;
  transcript += `pkce method=S256 challenge-matches-verifier=true callback-code-redeemed=true verifier-browser-wire=false: OK\n`;
  transcript += "partial-triple-sweep regions=1 partial=0: OK\n";

  const initialRegion = regions[0]!;
  const regionElement = guarded.page.getByTestId("identity-region");
  for (const attribute of ["data-ef-stream", "data-ef-offset", "data-ef-digest"] as const) {
    const original = await regionElement.getAttribute(attribute);
    assert.ok(original);
    await regionElement.evaluate((element, name) => element.removeAttribute(name), attribute);
    await assert.rejects(
      collectEfRegions(guarded.page),
      new RegExp("partial EF region"),
      `${attribute} damage stayed green`,
    );
    await regionElement.evaluate((element, [name, value]) => element.setAttribute(name, value), [
      attribute,
      original,
    ] as const);
  }
  for (const [attribute, wrong] of [
    ["data-ef-stream", "__wrong_stream__"],
    ["data-ef-digest", "f".repeat(64)],
  ] as const) {
    const original = await regionElement.getAttribute(attribute);
    assert.ok(original);
    await regionElement.evaluate((element, [name, value]) => element.setAttribute(name, value), [
      attribute,
      wrong,
    ] as const);
    assert.throws(
      () =>
        assertIdentityRegionTruth(
          [
            {
              stream: attribute === "data-ef-stream" ? wrong : initialRegion.stream,
              offset: initialRegion.offset,
              digest: attribute === "data-ef-digest" ? wrong : initialRegion.digest,
            },
          ],
          {
            stream: activeWorld.identity.streamId,
            offset: snapshot.offset,
            digest: snapshot.digest,
          },
        ),
      /Expected values to be strictly deep-equal/,
      `${attribute} wrong-value sabotage stayed green`,
    );
    await regionElement.evaluate((element, [name, value]) => element.setAttribute(name, value), [
      attribute,
      original,
    ] as const);
  }
  transcript +=
    "triple sensitivity missing-stream+offset+digest=expected-red wrong-stream+digest=expected-red: OK\n";

  await activeWorld.identity.ensureUser("auth0|out-of-band", "out-of-band@canopy.test");
  const advancedSnapshot = await activeWorld.snapshotIdentity();
  const advancedDigest = await cliDigest(activeWorld);
  assert.notEqual(advancedSnapshot.offset, initialRegion.offset);
  assert.notEqual(advancedSnapshot.digest, initialRegion.digest);
  assert.equal(advancedSnapshot.digest, advancedDigest);
  const advancedDumpBytes = await readFile(committedDumpPath);
  await writeFile(
    digestPath,
    `E3-T02 independent identity replay\nstream=${activeWorld.identity.streamId}\noffset=${advancedSnapshot.offset}\ndump-sha256=${createHash("sha256").update(advancedDumpBytes).digest("hex")}\ncli-digest=${advancedDigest}\ndom-digest=${advancedSnapshot.digest}\nliteral-equal=true\n`,
  );
  await writeFile(
    proofReceiptPath,
    `${JSON.stringify(
      {
        identityStream: activeWorld.identity.streamId,
        offset: advancedSnapshot.offset,
        digest: advancedSnapshot.digest,
        cliDigest: advancedDigest,
        cliDigestMatches: true,
        pkce: {
          method: "S256",
          challenge,
          redeemed: tokenForm.get("code") === callbackCode,
          verifierExposed: false,
        },
      },
      null,
      2,
    )}\n`,
  );
  await guarded.page.reload();
  await guarded.page.getByTestId("identity-region").waitFor();
  regions = await collectEfRegions(guarded.page);
  assertIdentityRegionTruth(regions, {
    stream: activeWorld.identity.streamId,
    offset: advancedSnapshot.offset,
    digest: advancedSnapshot.digest,
  });
  transcript += `out-of-band identity reload old-offset=${initialRegion.offset} new-offset=${advancedSnapshot.offset} old-digest=${initialRegion.digest} new-digest=${advancedSnapshot.digest} cli-replay=head: OK\n`;

  const visual = await guarded.page.evaluate(() => {
    const background = (selector: string): string => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`missing visual region ${selector}`);
      return getComputedStyle(element).backgroundColor;
    };
    return {
      body: background("body"),
      shell: background("main"),
      header: background("header"),
      identity: background('[data-testid="identity-region"]'),
      nav: background("nav"),
      article: background("article"),
      foreground: getComputedStyle(document.documentElement).color,
    };
  });
  assert.deepEqual(visual, {
    body: "rgb(246, 248, 250)",
    shell: "rgb(255, 255, 255)",
    header: "rgb(255, 255, 255)",
    identity: "rgb(246, 248, 250)",
    nav: "rgb(255, 255, 255)",
    article: "rgb(255, 255, 255)",
    foreground: "rgb(31, 35, 40)",
  });
  const sourceCss = await readFile(resolve(root, "apps/web/src/styles.css"), "utf8");
  for (const forbiddenThemeColor of ["#07120c", "#0d2115", "#174d2d", "#102a1a"]) {
    assert.equal(sourceCss.includes(forbiddenThemeColor), false, forbiddenThemeColor);
  }
  await writeFile(
    visualPath,
    `E3-T02 neutral shell visual proof\n${Object.entries(visual)
      .map(([region, color]) => `${region}=${color}`)
      .join("\n")}\nlegacy-green-theme-colors=0\nsuccess-green-role=status-only\n`,
  );
  transcript +=
    "visual shell=neutral body=#f6f8fa surfaces=#ffffff fg=#1f2328 legacy-green-theme=absent: OK\n";

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

  await guarded.page.evaluate(() => {
    document.addEventListener(
      "click",
      (event) => {
        if (event instanceof MouseEvent && event.metaKey) event.preventDefault();
      },
      { once: true },
    );
  });
  await guarded.page.getByRole("link", { name: "Maple" }).dispatchEvent("click", {
    button: 0,
    metaKey: true,
  });
  transcript += "modified-click metaKey branch=executed: OK\n";

  const deep = await guarded.context.newPage();
  await deep.goto(`${activeWorld.platformUrl}/maple/reading-room`);
  await deep.getByTestId("route-repo").waitFor();
  await deep.getByTestId("identity-region").waitFor();
  await deep.getByTestId("proof-receipt").waitFor();
  assert.equal((await collectEfRegions(deep)).length, 1);
  assert.equal(await deep.evaluate(() => performance.getEntriesByType("navigation").length), 1);
  transcript += "authenticated deep-link /maple/reading-room index+shell: OK\n";

  const identityError = await guarded.context.newPage();
  await identityError.route("**/api/whoami", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"unexpected":true}',
    }),
  );
  await identityError.goto(`${activeWorld.platformUrl}/`);
  await identityError.getByRole("alert").waitFor();
  await identityError.getByTestId("proof-receipt").waitFor();
  assert.equal(
    await identityError.getByRole("alert").textContent(),
    "Identity could not be replayed.",
  );
  transcript += "identity error branch injected-invalid-shape alert-visible: OK\n";

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
  assert.throws(() => {
    const sabotaged = {
      status: 200,
      contentType: "text/html",
      text: "<!doctype html><title>SPA fallback</title>",
    };
    assert.equal(sabotaged.status, 404);
    assert.match(sabotaged.contentType, /^application\/json/);
    assert.doesNotMatch(sabotaged.text.toLowerCase(), /<!doctype html>/);
  }, /200 !== 404/);
  transcript += "reserved-route SPA-fallback sensitivity=expected-red: OK\n";

  const bundle = await builtText();
  await assertInlineSourceMap();
  transcript += "source-map inline=true external-js-map-assets=0: OK\n";
  assert.ok(!/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(bundle));
  assert.ok(!bundle.includes("code_verifier"));
  assert.ok(!bundle.includes("ef_session"));
  await guarded.settleNetwork();
  const sessionId = liveSessionCookie.value.split(".")[0]!;
  const wireReceipt = scanCredentialLeaks(guarded.network, {
    secretLiterals: [sessionId, liveSessionCookie.value, subject.password],
  });
  transcript += `credential-scan bundle-bytes=${String(bundle.length)} network-observations=${String(wireReceipt.observations)} fields=${String(wireReceipt.fields)} full-url+request-headers+request-body+response-headers+response-body=true jwt=0 verifier=0 session-outside-http-only-cookie=0: OK\n`;

  await guarded.page.getByRole("button", { name: "Log out" }).click();
  await guarded.page.getByTestId("auth0-fixture-login-form").waitFor();
  assert.equal(
    (await guarded.context.cookies(activeWorld.platformUrl)).some(
      (cookie) => cookie.name === "ef_session",
    ),
    false,
  );
  transcript += "logout ended-session cookie-cleared login-form-visible: OK\n";

  guarded.assertClean();
  transcript += "console.error=0 pageerror=0 requestfailed=0 non-loopback=0: OK\n";
  for (const failureClass of ["console.error", "pageerror", "requestfailed"] as const) {
    await expectTripwireRed(activeWorld, browser, failureClass);
  }
  transcript += "tripwire sensitivity console.error+pageerror+requestfailed=expected-red: OK\n";
  await writeFile(transcriptPath, transcript);
  await writeFile(neutralityPath, neutrality);
  process.stdout.write(transcript);
} finally {
  await guarded.close();
  await browser.close();
  await activeWorld.close();
}
