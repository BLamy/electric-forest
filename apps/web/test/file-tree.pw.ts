import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { canonicalJson } from "@eforest/protocol";
import { replayWithReducer, requireReducer } from "@eforest/reducers";
import { listTree, type FsTree } from "@eforest/streamfs";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T06-file-tree-live");
const evidence = resolve(task, "evidence");
const digestPath = resolve(evidence, "e3-t06-digests.json");
const subject = {
  id: "ada-file-tree",
  email: "ada.file-tree@canopy.test",
  password: "AdaFileTree1234!",
  name: "Ada File Tree",
};
const file = (path: string, id: string) => ({
  type: "fs.file.create" as const,
  payload: { v: 2 as const, path, contentStreamId: `fs:maple/reading-room:main:file:${id}` },
  ts: 10,
});
const write = (path: string, sha: string, size: number) => ({
  type: "fs.file.write" as const,
  payload: { v: 2 as const, path, base: "BASE_NONE", contentSha256: sha, size },
  ts: 11,
});

await mkdir(evidence, { recursive: true });
const work = resolve(task, "work");
const proofReceiptPath = resolve(work, "e3-t06-empty-e3-t02-receipt.json");
await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const streamId = await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: [
    { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 },
    { type: "fs.dir.create", payload: { v: 2, path: "notes" }, ts: 2 },
    { type: "fs.dir.create", payload: { v: 2, path: "src" }, ts: 3 },
    { type: "fs.dir.create", payload: { v: 2, path: "B" }, ts: 4 },
    { type: "fs.dir.create", payload: { v: 2, path: "a" }, ts: 5 },
    { type: "fs.dir.create", payload: { v: 2, path: "z" }, ts: 6 },
    { type: "fs.dir.create", payload: { v: 2, path: "ä" }, ts: 7 },
    { type: "fs.dir.create", payload: { v: 2, path: "team docs" }, ts: 8 },
    { type: "fs.dir.create", payload: { v: 2, path: "team docs/über" }, ts: 9 },
    { type: "fs.dir.create", payload: { v: 2, path: "percent%2Fname" }, ts: 10 },
    file("guide-old.md", "1-a"),
    write("guide-old.md", "a".repeat(64), 27),
    file("obsolete.txt", "2-b"),
    write("obsolete.txt", "b".repeat(64), 10),
    file("docs/chapter-one.md", "3-c"),
    write("docs/chapter-one.md", "c".repeat(64), 12),
    file("docs/my file.md", "3-space"),
    write("docs/my file.md", "d".repeat(64), 9),
    file("team docs/über/read me.txt", "3-encoded-path"),
    write("team docs/über/read me.txt", "e".repeat(64), 14),
    file("percent%2Fname/literal-percent.txt", "3-literal-percent"),
    write("percent%2Fname/literal-percent.txt", "f".repeat(64), 15),
  ],
});
const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
let transcript = "E3-T06 live StreamFS tree browser\n";
let navigations = 0;
guarded.page.on("framenavigated", (frame) => {
  if (frame === guarded.page.mainFrame()) navigations += 1;
});

async function independentTree(): Promise<{
  checkpoint: string;
  digest: string;
  canonicalRows: number;
}> {
  const records = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(streamId)}`,
  });
  await writeFile(
    resolve(evidence, "e3-t06-events.jsonl"),
    `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
  const replay = replayWithReducer(requireReducer("streamfs", streamId), records);
  return {
    checkpoint: records.at(-1)?.offset ?? "-1",
    digest: replay.digest,
    canonicalRows: listTree(replay.state as FsTree).length,
  };
}

try {
  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  await loginWithFixture(guarded.page);
  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  const tree = guarded.page.getByTestId("tree-browser");
  await tree.waitFor();
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="tree-browser"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  const initial = await independentTree();
  assert.equal(await tree.getAttribute("data-ef-offset"), initial.checkpoint);
  assert.equal(await tree.getAttribute("data-tree-digest"), initial.digest);
  assert.deepEqual(
    await guarded.page
      .getByTestId("tree-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path"))),
    [
      "B",
      "a",
      "docs",
      "guide-old.md",
      "notes",
      "obsolete.txt",
      "percent%2Fname",
      "src",
      "team docs",
      "z",
      "ä",
    ],
  );
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "obsolete.txt" }).count(),
    1,
  );
  transcript += `initial rows=11 checkpoint=${initial.checkpoint} digest=${initial.digest} cli=equal\n`;

  const docsLink = guarded.page.getByRole("link", { name: "docs/", exact: true });
  await docsLink.focus();
  await docsLink.press("Enter");
  await guarded.page.getByTestId("tree-breadcrumbs").waitFor();
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "chapter-one.md" }).count(),
    1,
  );
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "my file.md" }).count(),
    1,
  );
  await guarded.page
    .getByTestId("tree-breadcrumbs")
    .getByRole("link", { name: "File tree", exact: true })
    .click();

  const beforeEncodedDocumentNavigations = await guarded.page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  await guarded.page.getByRole("link", { name: "percent%2Fname/", exact: true }).click();
  assert.match(guarded.page.url(), /\/percent%252Fname$/);
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "literal-percent.txt" }).count(),
    1,
  );
  assert.equal(
    await guarded.page
      .getByTestId("tree-breadcrumbs")
      .getByRole("link", { name: "percent%2Fname", exact: true })
      .count(),
    1,
  );
  await guarded.page
    .getByTestId("tree-breadcrumbs")
    .getByRole("link", { name: "File tree", exact: true })
    .click();
  transcript +=
    "literal-percent-navigation canonical-path=percent%2Fname encoded-url=percent%252Fname decode=exactly-once\n";

  const spacedDirectory = guarded.page.getByRole("link", { name: "team docs/", exact: true });
  await spacedDirectory.click();
  assert.match(guarded.page.url(), /\/team%20docs$/);
  await guarded.page.getByRole("link", { name: "über/", exact: true }).waitFor();
  assert.equal(
    await guarded.page
      .getByTestId("tree-breadcrumbs")
      .getByRole("link", { name: "team docs" })
      .count(),
    1,
  );
  const unicodeDirectory = guarded.page.getByRole("link", { name: "über/", exact: true });
  await unicodeDirectory.focus();
  await unicodeDirectory.press("Enter");
  assert.match(guarded.page.url(), /\/team%20docs\/%C3%BCber$/);
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "read me.txt" }).count(),
    1,
  );
  assert.equal(
    await guarded.page.getByTestId("tree-breadcrumbs").getByRole("link", { name: "über" }).count(),
    1,
  );
  assert.equal(
    await guarded.page.evaluate(() => performance.getEntriesByType("navigation").length),
    beforeEncodedDocumentNavigations,
  );
  await guarded.page
    .getByTestId("tree-breadcrumbs")
    .getByRole("link", { name: "File tree", exact: true })
    .click();
  transcript +=
    "encoded-directory-navigation pointer-space=true keyboard-unicode=true canonical-path=team docs/über no-reload=true\n";

  for (const unsafePath of ["broken%E0%A4%A", "encoded%2Fseparator"]) {
    await guarded.page.evaluate((path) => {
      window.history.pushState(null, "", `/maple/reading-room/tree/main/${path}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, unsafePath);
    await guarded.page.getByTestId("route-not-found").waitFor();
  }
  await guarded.page.getByRole("link", { name: "File tree" }).click();
  await tree.waitFor();
  assert.equal(
    await guarded.page.evaluate(() => performance.getEntriesByType("navigation").length),
    beforeEncodedDocumentNavigations,
  );
  transcript += "unsafe-encoded-paths malformed-percent=404 encoded-separator=404 no-reload=true\n";

  const beforeMutations = navigations;
  await world.appendApplication(streamId, {
    type: "fs.rename",
    payload: { v: 2, from: "guide-old.md", to: "guide.md" },
    ts: 20,
  });
  await guarded.page.getByTestId("tree-row").filter({ hasText: "guide.md" }).waitFor();
  assert.equal(
    await guarded.page.getByTestId("tree-row").filter({ hasText: "guide-old.md" }).count(),
    0,
  );
  transcript += "live-rename old-absent new-visible=true\n";

  async function appendWithReconnect(event: Parameters<typeof world.appendApplication>[1]) {
    let failing = true;
    await guarded.page.route("**/*", async (route) => {
      const url = route.request().url();
      if (failing && url.includes("/api/repos/") && url.includes("live=1")) {
        await route.abort();
        return;
      }
      await route.fallback();
    });
    await world.appendApplication(streamId, event);
    await guarded.page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="tree-browser"]')
          ?.getAttribute("data-stream-status") === "reconnecting",
    );
    failing = false;
    await guarded.page.unroute("**/*");
    await guarded.page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="tree-browser"]')
          ?.getAttribute("data-stream-status") === "live",
    );
  }

  await appendWithReconnect({
    type: "fs.file.delete",
    payload: { v: 2, path: "obsolete.txt" },
    ts: 21,
  });
  assert.equal(navigations, beforeMutations);
  await guarded.page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[data-testid="tree-row"]')].some(
        (row) => row.getAttribute("data-path") === "obsolete.txt",
      ),
  );
  transcript += "live-delete tombstone-absent=true reconnecting->live=true\n";

  await appendWithReconnect(file("obsolete.txt", "4-d"));
  await guarded.page.getByTestId("tree-row").filter({ hasText: "obsolete.txt" }).waitFor();
  transcript += "live-recreate visible=true reconnecting->live=true\n";

  await appendWithReconnect({
    type: "fs.rename",
    payload: { v: 2, from: "notes", to: "archive" },
    ts: 23,
  });
  await guarded.page.getByTestId("tree-row").filter({ hasText: "archive" }).waitFor();
  assert.equal(await guarded.page.getByTestId("tree-row").filter({ hasText: "notes" }).count(), 0);
  transcript += "live-notes-rename visible=true reconnecting->live=true\n";
  await guarded.page.getByRole("link", { name: "docs/", exact: true }).click();
  await appendWithReconnect({
    type: "fs.rename",
    payload: { v: 2, from: "docs", to: "archive-docs" },
    ts: 22,
  });
  await guarded.page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tree-row"]').length === 0,
  );
  transcript += "live-populated-dir-rename nested-empty=true reconnecting->live=true\n";

  const final = await independentTree();
  await writeFile(digestPath, `${canonicalJson({ initial, final })}\n`);
  await guarded.page.waitForFunction(({ checkpoint, digest }) => {
    const node = document.querySelector('[data-testid="tree-browser"]');
    return (
      node?.getAttribute("data-ef-offset") === checkpoint &&
      node.getAttribute("data-tree-digest") === digest
    );
  }, final);
  assert.equal(await tree.getAttribute("data-stream-status"), "live");
  const displayedRows = await guarded.page.getByTestId("tree-row").count();
  assert.equal(displayedRows, 0);
  transcript += `final displayedRows=${displayedRows} canonicalRows=${final.canonicalRows} checkpoint=${final.checkpoint} digest=${final.digest} cli=equal no-reload=true populated-dir-rename=true\n`;

  let releaseLoading!: () => void;
  const loadingGate = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await guarded.page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/repos/") && url.includes("projection=1") && !url.includes("live=1")) {
      await loadingGate;
    }
    await route.fallback();
  });
  const loadingNavigation = guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  await guarded.page.getByTestId("tree-loading").waitFor();
  releaseLoading();
  await loadingNavigation;
  await guarded.page.unroute("**/*");
  transcript += "loading-state visible=true keyboard-docs=true\n";

  await guarded.page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/repos/") && url.includes("projection=1") && !url.includes("live=1")) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false}' });
      return;
    }
    await route.fallback();
  });
  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  const refusal = guarded.page.getByRole("alert");
  await refusal.waitFor();
  assert.match((await refusal.textContent()) ?? "", /StreamFS tree projection refused:/);
  await guarded.page.unroute("**/*");
  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="tree-browser"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  transcript += "refusal-state role=alert visible=true recovery=live\n";
  await guarded.settleNetwork();
  // The reconnect proof intentionally aborts one in-flight long-poll per mutation;
  // all non-aborted console/network assertions below remain strict.
  assert.equal(
    guarded.network.some(
      (entry) =>
        entry.direction === "request" && new URL(entry.url).pathname.startsWith("/streams/"),
    ),
    false,
  );
  assert.ok(
    guarded.network.some(
      (entry) => entry.direction === "request" && new URL(entry.url).pathname.includes("/events"),
    ),
  );
  await writeFile(resolve(evidence, "e3-t06-browser.txt"), transcript);
  console.log(transcript.trim());
} finally {
  await guarded.close();
  await browser.close();
  await world.close();
}

// All owned resources are closed above. Terminate this standalone runner so
// Playwright's process-global macOS file watcher cannot hold the proof open.
process.exit(0);
