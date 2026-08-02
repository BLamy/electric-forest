import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { canonicalJson } from "@eforest/protocol";
import { digestBytes } from "@eforest/streamfs";
import { fileViewStreamId, replayWithReducer, requireReducer } from "@eforest/reducers";
import { OfficialStreamAdapter } from "@eforest/platform";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T07-file-viewer-patch-aware");
const evidence = resolve(task, "evidence");
const subject = {
  id: "ada-file-viewer",
  email: "ada.file-viewer@canopy.test",
  password: "AdaFileViewer1234!",
  name: "Ada File Viewer",
};
const initialText = new TextEncoder().encode("hello world\n");
const patchText = new TextEncoder().encode("hello durable streams\n");
const fallbackText = new TextEncoder().encode("fallback full write\n");
const renamedText = new TextEncoder().encode("after rename\n");
const contentStreams = {
  readme: "fs:maple/reading-room:main:file:viewer-readme",
  binary: "fs:maple/reading-room:main:file:viewer-binary",
  large: "fs:maple/reading-room:main:file:viewer-large",
  bad: "fs:maple/reading-room:main:file:viewer-bad",
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function contentEvent(streamId: string, bytes: Uint8Array) {
  return {
    type: "fs.file.content" as const,
    payload: { v: 2 as const, contentStreamId: streamId, contentBase64: base64(bytes) },
    ts: 1,
  };
}

function fileCreate(path: string, streamId: string) {
  return {
    type: "fs.file.create" as const,
    payload: { v: 2 as const, path, contentStreamId: streamId },
    ts: 1,
  };
}

function fileWrite(path: string, bytes: Uint8Array, ts = 2) {
  return {
    type: "fs.file.write" as const,
    payload: {
      v: 2 as const,
      path,
      base: "BASE_NONE",
      contentSha256: digestBytes(bytes),
      size: bytes.byteLength,
    },
    ts,
  };
}

function textPatch(path: string, before: Uint8Array, after: Uint8Array, ts = 3) {
  return {
    type: "fs.file.patch" as const,
    payload: {
      v: 2 as const,
      path,
      base: "BASE_NONE",
      baseDigest: digestBytes(before),
      ops: [
        ["=", 6],
        ["+", "durable streams"],
        ["-", 5],
        ["=", 1],
      ] as const,
      resultDigest: digestBytes(after),
    },
    ts,
  };
}

await mkdir(evidence, { recursive: true });
const work = resolve(task, "work");
const proofReceiptPath = resolve(work, "e3-t07-empty-receipt.json");
await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");

const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
const largeBytes = new Uint8Array(256 * 1024 + 1).fill(65);
const binaryBytes = Uint8Array.from([0, 1, 2, 255]);
const badBytes = new TextEncoder().encode("bad initial\n");

for (const [streamId, bytes] of [
  [contentStreams.readme, initialText],
  [contentStreams.binary, binaryBytes],
  [contentStreams.large, largeBytes],
  [contentStreams.bad, badBytes],
] as const) {
  await streams.create(streamId);
  await streams.append(streamId, contentEvent(streamId, bytes));
}

const metadataStream = await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: [
    { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 },
    fileCreate("docs/readme.md", contentStreams.readme),
    fileWrite("docs/readme.md", initialText),
    { type: "fs.dir.create", payload: { v: 2, path: "assets" }, ts: 4 },
    fileCreate("assets/logo.bin", contentStreams.binary),
    fileWrite("assets/logo.bin", binaryBytes, 5),
    { type: "fs.dir.create", payload: { v: 2, path: "artifacts" }, ts: 6 },
    fileCreate("artifacts/large.txt", contentStreams.large),
    fileWrite("artifacts/large.txt", largeBytes, 7),
    fileCreate("bad.txt", contentStreams.bad),
    fileWrite("bad.txt", badBytes, 9),
  ],
});

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
let peer: Awaited<ReturnType<typeof world.openPage>> | undefined;
let transcript = "E3-T07 live patch-aware file viewer\n";
let navigations = 0;
guarded.page.on("framenavigated", (frame) => {
  if (frame === guarded.page.mainFrame()) navigations += 1;
});

async function projection(path: string) {
  return guarded.page.evaluate(async (targetPath) => {
    const encoded = targetPath.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `/api/repos/maple/reading-room/main/blob/${encoded}?projection=1&reducer=file-content`,
    );
    return { status: response.status, body: await response.json() };
  }, path);
}

async function assertIndependentProjection(path: string, expectedBytes: Uint8Array) {
  const result = await projection(path);
  assert.equal(result.status, 200);
  const body = result.body as { readonly events: readonly unknown[]; readonly checkpoint: string };
  const replay = replayWithReducer(
    requireReducer("file-content", fileViewStreamId("maple", "reading-room", "main", path)),
    body.events as never,
  );
  const viewer = guarded.page.getByTestId("file-viewer");
  assert.equal(await viewer.getAttribute("data-ef-offset"), body.checkpoint);
  assert.equal(await viewer.getAttribute("data-content-digest"), digestBytes(expectedBytes));
  assert.equal(await viewer.getAttribute("data-state-digest"), replay.digest);
  assert.equal(replay.digest, digestBytes(expectedBytes));
}

try {
  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  await loginWithFixture(guarded.page);
  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  await guarded.page.getByTestId("tree-browser").waitFor();
  await guarded.page.getByTestId("tree-list").waitFor();
  await guarded.page.getByRole("link", { name: "docs/", exact: true }).click();
  await guarded.page.getByRole("link", { name: "readme.md", exact: true }).click();
  await guarded.page.getByTestId("file-viewer").waitFor();
  await guarded.page.getByTestId("file-content").waitFor();
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  assert.equal(await guarded.page.getByTestId("file-content").textContent(), "hello world\n");
  const initialIdentity = await guarded.page
    .getByTestId("file-viewer")
    .getAttribute("data-file-identity");
  assert.equal(initialIdentity, contentStreams.readme);
  await assertIndependentProjection("docs/readme.md", initialText);
  transcript += `initial text=true digest=${digestBytes(initialText)} identity=${initialIdentity} cli=equal\n`;

  peer = await world.openPage(browser);
  await peer.page.goto(`${world.platformUrl}/maple/reading-room/tree/main`);
  await loginWithFixture(peer.page);
  await peer.page.goto(`${world.platformUrl}/maple/reading-room/blob/main/docs/readme.md`);
  await peer.page.getByTestId("file-content").waitFor();
  await peer.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  assert.equal(await peer.page.getByTestId("file-content").textContent(), "hello world\n");
  transcript += "two-session bootstrap=true peer-text=equal\n";

  const beforeMutations = navigations;
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
    await world.appendApplication(metadataStream, event);
    await guarded.page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="file-viewer"]')
          ?.getAttribute("data-stream-status") === "reconnecting",
    );
    failing = false;
    await guarded.page.unroute("**/*");
    await guarded.page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="file-viewer"]')
          ?.getAttribute("data-stream-status") === "live",
    );
  }

  await appendWithReconnect(textPatch("docs/readme.md", initialText, patchText));
  assert.equal(
    await guarded.page.getByTestId("file-content").textContent(),
    "hello durable streams\n",
  );
  assert.equal(
    await peer.page.getByTestId("file-content").textContent(),
    "hello durable streams\n",
  );
  await assertIndependentProjection("docs/readme.md", patchText);
  assert.equal(navigations, beforeMutations);
  transcript += `live patch=true digest=${digestBytes(patchText)} reconnecting->live=true no-reload=true\n`;

  await streams.append(contentStreams.readme, contentEvent(contentStreams.readme, fallbackText));
  await appendWithReconnect(fileWrite("docs/readme.md", fallbackText, 4));
  assert.equal(
    await guarded.page.getByTestId("file-content").textContent(),
    "fallback full write\n",
  );
  assert.equal(await peer.page.getByTestId("file-content").textContent(), "fallback full write\n");
  await assertIndependentProjection("docs/readme.md", fallbackText);
  transcript += `full-write-fallback=true digest=${digestBytes(fallbackText)} reconnecting->live=true two-session=true\n`;

  await appendWithReconnect({
    type: "fs.rename",
    payload: { v: 2, from: "docs/readme.md", to: "docs/live.md" },
    ts: 5,
  });
  const renamedViewer = guarded.page.getByTestId("file-viewer");
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-file-path") ===
      "docs/live.md",
  );
  assert.equal(await renamedViewer.getAttribute("data-file-identity"), initialIdentity);
  await peer.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="file-viewer"]')?.getAttribute("data-file-path") ===
      "docs/live.md",
  );
  assert.equal(
    await peer.page.getByTestId("file-viewer").getAttribute("data-file-identity"),
    initialIdentity,
  );
  transcript += "rename=true identity-preserved=true reconnecting->live=true\n";

  const renameOps = [
    ["-", fallbackText.byteLength],
    ["+", "after rename\n"],
  ] as const;
  const renamedPatch = {
    type: "fs.file.patch" as const,
    payload: {
      v: 2 as const,
      path: "docs/live.md",
      base: "BASE_NONE",
      baseDigest: digestBytes(fallbackText),
      ops: renameOps,
      resultDigest: digestBytes(renamedText),
    },
    ts: 6,
  };
  await appendWithReconnect(renamedPatch);
  assert.equal(await guarded.page.getByTestId("file-content").textContent(), "after rename\n");
  assert.equal(await peer.page.getByTestId("file-content").textContent(), "after rename\n");
  await assertIndependentProjection("docs/readme.md", renamedText);
  transcript += `patch-after-rename=true digest=${digestBytes(renamedText)}\n`;

  await appendWithReconnect({
    type: "fs.file.delete",
    payload: { v: 2, path: "docs/live.md" },
    ts: 7,
  });
  await guarded.page.getByTestId("file-deleted").waitFor();
  assert.equal(await renamedViewer.getAttribute("data-file-status"), "deleted");
  await peer.page.getByTestId("file-deleted").waitFor();
  assert.equal(
    await peer.page.getByTestId("file-viewer").getAttribute("data-file-status"),
    "deleted",
  );
  transcript += "delete=true file-deleted-visible=true reconnecting->live=true\n";
  const finalProjection = await projection("docs/readme.md");
  assert.equal(finalProjection.status, 200);

  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/blob/main/assets/logo.bin`);
  await guarded.page.getByTestId("file-viewer").waitFor();
  await guarded.page.getByTestId("file-binary").waitFor();
  assert.equal(
    await guarded.page.getByTestId("file-viewer").getAttribute("data-file-status"),
    "binary",
  );
  transcript += "binary-state=true bytes-not-coerced=true\n";

  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/blob/main/artifacts/large.txt`);
  await guarded.page.getByTestId("file-oversize").waitFor();
  assert.equal(
    await guarded.page.getByTestId("file-viewer").getAttribute("data-file-status"),
    "oversize",
  );
  transcript += `oversize-state=true size=${largeBytes.byteLength} bytes-not-retained=true\n`;

  await guarded.page.goto(`${world.platformUrl}/maple/reading-room/blob/main/docs/readme.md`);
  await guarded.page.getByTestId("file-deleted").waitFor();
  const badPatch = {
    type: "fs.file.patch" as const,
    payload: {
      v: 2 as const,
      path: "bad.txt",
      base: "BASE_NONE",
      baseDigest: digestBytes(new TextEncoder().encode("wrong base\n")),
      ops: [["=", badBytes.byteLength]] as const,
      resultDigest: digestBytes(badBytes),
    },
    ts: 10,
  };
  await world.appendApplication(metadataStream, badPatch);
  await guarded.page.getByTestId("file-refusal").waitFor();
  assert.match(
    (await guarded.page.getByTestId("file-refusal").textContent()) ?? "",
    /patch base digest mismatch/,
  );
  transcript += "corrupt-base-refusal=true role=alert=true rendered-state-not-updated=true\n";

  const refusalProjection = await projection("docs/readme.md");
  assert.equal(refusalProjection.status, 422);
  await guarded.page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[data-testid="file-viewer"]')].some(
        (node) => node.getAttribute("data-stream-status") === "live",
      ),
  );
  await guarded.settleNetwork();
  assert.equal(
    guarded.network.some(
      (entry) =>
        entry.direction === "request" && new URL(entry.url).pathname.startsWith("/streams/"),
    ),
    false,
  );
  assert.ok(
    guarded.network.some(
      (entry) =>
        entry.direction === "request" && new URL(entry.url).pathname.includes("/api/repos/"),
    ),
  );
  const streamRequests = guarded.network.filter(
    (entry) => entry.direction === "request" && new URL(entry.url).pathname.startsWith("/streams/"),
  ).length;
  const projectionRequests = guarded.network.filter(
    (entry) => entry.direction === "request" && new URL(entry.url).pathname.includes("/api/repos/"),
  ).length;
  transcript += `transport stream-requests=${streamRequests} authorized-projection-requests=${projectionRequests}\n`;

  await writeFile(resolve(evidence, "e3-t07-browser.txt"), transcript);
  await writeFile(
    resolve(evidence, "e3-t07-events.jsonl"),
    `${canonicalJson(finalProjection.body)}\n`,
  );
  await writeFile(
    resolve(evidence, "e3-t07-digests.json"),
    `${canonicalJson({
      initial: { digest: digestBytes(initialText), size: initialText.byteLength },
      patch: { digest: digestBytes(patchText), size: patchText.byteLength },
      fallback: { digest: digestBytes(fallbackText), size: fallbackText.byteLength },
      renamed: { digest: digestBytes(renamedText), size: renamedText.byteLength },
      binary: { digest: digestBytes(binaryBytes), size: binaryBytes.byteLength },
      oversize: { digest: digestBytes(largeBytes), size: largeBytes.byteLength },
    })}\n`,
  );
  console.log(transcript.trim());
} finally {
  await peer?.close();
  await guarded.close();
  await browser.close();
  await world.close();
}
