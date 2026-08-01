import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { NamespaceViewReader, OfficialStreamAdapter, RepositoryHomeStore } from "@eforest/platform";
import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { replayWithReducer, requireReducer } from "@eforest/reducers";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T05-repo-home-branches-status");
const evidence = resolve(task, "evidence");
const work = resolve(task, "work");
const transcriptPath = resolve(evidence, "e3-t05-browser.txt");
const digestPath = resolve(evidence, "e3-t05-digests.json");
const eventPath = resolve(evidence, "e3-t05-events.json");
const subject = {
  id: "ada-repo-home",
  email: "ada.repo-home@canopy.test",
  password: "AdaRepoHome1234!",
  name: "Ada Repo Home",
};

await mkdir(evidence, { recursive: true });
await mkdir(work, { recursive: true });
const proofReceiptPath = resolve(work, "e3-t05-empty-proof-receipt.json");
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const mainStream = await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: [{ type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 10 }],
});
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
let repositoryEventTime = 100;
const homes = new RepositoryHomeStore(streams, () => repositoryEventTime++);
await homes.ensureRepository("maple", "reading-room", "canopy");
const namespaceReader = new NamespaceViewReader(streams);
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
let transcript = "E3-T05 repository home browser proof\n";

async function createNativeFork(name: string): Promise<void> {
  const forkOffset =
    (
      await readDurableJson<StreamRecord>({
        url: `${world.streamUrl}/streams/${encodeURIComponent(mainStream)}`,
      })
    ).at(-1)?.offset ?? "-1";
  const streamId = `fs:maple/reading-room:${name}:meta`;
  await streams.create(streamId);
  await streams.append(
    streamId,
    {
      type: "fs.branch.fork",
      ts: 20,
      payload: { v: 1, parentStreamId: mainStream, forkOffset },
    },
    { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
  );
  await homes.registerNativeBranch("maple", "reading-room", name);
}

async function independentProjection(region: "namespace" | "branches" | "status") {
  const view = await namespaceReader.viewFor("maple");
  const batch = await homes.projection(view, "maple", "reading-room", region);
  const reducerId =
    region === "namespace"
      ? "repo-namespace"
      : region === "branches"
        ? "repo-branches"
        : "repo-status";
  const streamId = `repo-home:maple/reading-room:${region}`;
  const replay = replayWithReducer(requireReducer(reducerId, streamId), batch.events);
  return {
    events: batch.events,
    checkpoint: (batch.events.at(-1) as { readonly offset?: string } | undefined)?.offset ?? "-1",
    digest: replay.digest,
  };
}

try {
  await guarded.page.goto(world.platformUrl);
  await loginWithFixture(guarded.page);

  let releaseLateBootstraps!: () => void;
  const lateBootstraps = new Promise<void>((resolveRelease) => {
    releaseLateBootstraps = resolveRelease;
  });
  let releaseNamespaceBootstrap!: () => void;
  const namespaceBootstrap = new Promise<void>((resolveRelease) => {
    releaseNamespaceBootstrap = resolveRelease;
  });
  let holdNamespaceBootstrap = true;
  let holdBootstraps = true;
  await guarded.page.route("**/api/repos/maple/reading-room/home/**", async (route) => {
    const url = new URL(route.request().url());
    const region = url.pathname.split("/").at(-1)!;
    const live = url.searchParams.get("live") === "1";
    if (holdNamespaceBootstrap && !live && region === "namespace") {
      await namespaceBootstrap;
    }
    if (holdBootstraps && !live && (region === "branches" || region === "status")) {
      await lateBootstraps;
    }
    await route.fallback();
  });

  await guarded.page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const control = { enabled: false, seen: new Set<string>() };
    (window as unknown as { __e3t05Reconnect: typeof control }).__e3t05Reconnect = control;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        window.location.origin,
      );
      const region = url.pathname.split("/").at(-1)!;
      if (
        control.enabled &&
        url.searchParams.get("live") === "1" &&
        (region === "branches" || region === "status") &&
        !control.seen.has(region)
      ) {
        control.seen.add(region);
        throw new TypeError(`fixture reconnect ${region}`);
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
  });

  await guarded.page.goto(`${world.platformUrl}/maple/reading-room`);
  const home = guarded.page.getByTestId("repository-home");
  await home.waitFor();
  await guarded.page.getByText("Loading repository metadata…").waitFor();
  const loadingFacts = await guarded.page.getByTestId("namespace-projection-facts").boundingBox();
  assert.ok(loadingFacts !== null);
  holdNamespaceBootstrap = false;
  releaseNamespaceBootstrap();
  await guarded.page.getByTestId("repo-project").waitFor();
  const loadedFacts = await guarded.page.getByTestId("namespace-projection-facts").boundingBox();
  assert.ok(loadedFacts !== null);
  assert.ok(Math.abs(loadedFacts.y - loadingFacts.y) <= 1);
  transcript += "metadata-layout-stable=true y=" + String(loadedFacts.y) + "\n";
  await guarded.page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="repo-namespace-region"]')
        ?.getAttribute("data-stream-status") === "live",
  );

  // The branch and status source advance after namespace bootstrap but before
  // their own bootstrap responses. All three must still converge independently.
  await createNativeFork("feature-typography");
  await homes.setProjectStatus("maple", "canopy", "paused");
  holdBootstraps = false;
  releaseLateBootstraps();
  await guarded.page.waitForFunction(() =>
    ["repo-namespace-region", "repo-branches-region", "repo-status-region"].every(
      (testId) =>
        document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("data-stream-status") ===
        "live",
    ),
  );
  await guarded.page.getByTestId("branch-parent-feature-typography").waitFor();
  assert.equal(
    await guarded.page.getByTestId("branch-parent-feature-typography").textContent(),
    mainStream,
  );
  assert.equal(
    await guarded.page.getByTestId("branch-fork-feature-typography").textContent(),
    offsetForOrdinal(0),
  );
  assert.equal(await guarded.page.getByTestId("project-state-value").textContent(), "paused");
  transcript += "staggered-bootstrap namespace-before-branch-status converged=true\n";

  const initial = Object.fromEntries(
    await Promise.all(
      (["namespace", "branches", "status"] as const).map(async (region) => [
        region,
        await independentProjection(region),
      ]),
    ),
  );
  for (const region of ["namespace", "branches", "status"] as const) {
    const node = guarded.page.getByTestId(`repo-${region}-region`);
    assert.equal(
      await node.getAttribute("data-application-checkpoint"),
      initial[region].checkpoint,
    );
    assert.equal(await node.getAttribute("data-state-digest"), initial[region].digest);
  }
  transcript += "independent-replay initial namespace=equal branches=equal status=equal\n";

  await guarded.page.evaluate(() => {
    (window as unknown as { __e3t05Reconnect: { enabled: boolean } }).__e3t05Reconnect.enabled =
      true;
  });
  await guarded.page.waitForFunction(() =>
    ["repo-branches-region", "repo-status-region"].some(
      (testId) =>
        document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("data-stream-status") ===
        "reconnecting",
    ),
  );
  await createNativeFork("fix-reconnect");
  await homes.setProjectStatus("maple", "canopy", "complete");
  await guarded.page.getByTestId("branch-parent-fix-reconnect").waitFor();
  await guarded.page.waitForFunction(
    () => document.querySelector('[data-testid="project-state-value"]')?.textContent === "complete",
  );
  assert.deepEqual(
    await guarded.page.evaluate(() =>
      [
        ...(window as unknown as { __e3t05Reconnect: { seen: Set<string> } }).__e3t05Reconnect.seen,
      ].sort(),
    ),
    ["branches", "status"],
  );

  const converged = Object.fromEntries(
    await Promise.all(
      (["namespace", "branches", "status"] as const).map(async (region) => [
        region,
        await independentProjection(region),
      ]),
    ),
  );
  for (const region of ["namespace", "branches", "status"] as const) {
    const node = guarded.page.getByTestId(`repo-${region}-region`);
    await guarded.page.waitForFunction(
      ({ testId, checkpoint }) =>
        document
          .querySelector(`[data-testid="${testId}"]`)
          ?.getAttribute("data-application-checkpoint") === checkpoint,
      { testId: `repo-${region}-region`, checkpoint: converged[region].checkpoint },
    );
    assert.equal(await node.getAttribute("data-state-digest"), converged[region].digest);
  }
  transcript += "forced-reconnect branch-and-status advanced=true converged=true\n";
  transcript += "independent-replay final namespace=equal branches=equal status=equal\n";

  await guarded.settleNetwork();
  assert.equal(
    guarded.network.some(
      (entry) =>
        entry.layer === "browser" &&
        entry.direction === "request" &&
        (new URL(entry.url).origin === world.streamUrl ||
          new URL(entry.url).pathname.startsWith("/streams/")),
    ),
    false,
  );
  const homeRequests = guarded.network.filter(
    (entry) => entry.layer === "browser" && entry.url.includes("/home/"),
  );
  assert.ok(homeRequests.length >= 6);
  assert.equal(
    homeRequests.some((entry) =>
      entry.headers.some(([name]) => name.toLowerCase() === "authorization"),
    ),
    false,
  );
  guarded.assertClean();
  transcript += "browser-network platform-only=true browser-authorization-header=false\n";
  transcript += "console-errors=0 page-errors=0 unexpected-request-failures=0\n";

  await writeFile(transcriptPath, transcript);
  await writeFile(
    digestPath,
    `${canonicalJson({
      initial: {
        namespace: { checkpoint: initial.namespace.checkpoint, digest: initial.namespace.digest },
        branches: { checkpoint: initial.branches.checkpoint, digest: initial.branches.digest },
        status: { checkpoint: initial.status.checkpoint, digest: initial.status.digest },
      },
      converged: {
        namespace: {
          checkpoint: converged.namespace.checkpoint,
          digest: converged.namespace.digest,
        },
        branches: { checkpoint: converged.branches.checkpoint, digest: converged.branches.digest },
        status: { checkpoint: converged.status.checkpoint, digest: converged.status.digest },
      },
    })}\n`,
  );
  await writeFile(
    eventPath,
    `${canonicalJson({
      initial: {
        namespace: initial.namespace.events,
        branches: initial.branches.events,
        status: initial.status.events,
      },
      converged: {
        namespace: converged.namespace.events,
        branches: converged.branches.events,
        status: converged.status.events,
      },
    })}\n`,
  );
  process.stdout.write(transcript);
} finally {
  await guarded.close();
  await browser.close();
  // Let the server-side one-second long polls observe their deadlines before
  // terminating the permission-denied namespace workers they may still use.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));
  namespaceReader.terminate();
  await world.close();
}

process.exit(0);
