import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bootWorld, loginWithFixture, replayChromiumPath } from "@eforest/browser-verify";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { OfficialStreamAdapter, RepositoryHomeStore } from "@eforest/platform";
import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { historyReducerDefinition, replayWithReducer } from "@eforest/reducers";
import { chromium, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T09-history-event-log");
const evidence = resolve(task, "evidence");
const subject = {
  id: "ada-history-event-log",
  email: "ada.history@canopy.test",
  password: "AdaHistory1234!",
  name: "Ada History",
};
const mainStream = "fs:maple/reading-room:main:meta";
const featureStream = "fs:maple/reading-room:feature:meta";

interface HistoryRecord extends StreamRecord {
  readonly sourceStreamId: string;
  readonly actor: string;
}

interface HistoryRowValue {
  readonly offset: string | null;
  readonly sourceStreamId: string | null;
  readonly actor: string | null;
  readonly kind: string | null;
  readonly known: string | null;
  readonly raw: string | null;
}

function actorOf(record: StreamRecord): string {
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    return "unknown-actor";
  }
  const payload = record.payload as Record<string, unknown>;
  const writer = payload.writer;
  if (
    writer !== null &&
    typeof writer === "object" &&
    !Array.isArray(writer) &&
    (writer as Record<string, unknown>).v === 1 &&
    typeof (writer as Record<string, unknown>).sub === "string" &&
    payload.actor === (writer as Record<string, unknown>).sub
  ) {
    return (writer as Record<string, unknown>).sub as string;
  }
  return "unknown-actor";
}

function logicalHistory(
  main: readonly StreamRecord[],
  leaf?: readonly StreamRecord[],
): readonly HistoryRecord[] {
  const raw =
    leaf === undefined
      ? main.map((record) => ({ record, sourceStreamId: mainStream }))
      : [
          ...main
            .filter((record) => {
              const fork = leaf[0]?.payload;
              return (
                fork !== null &&
                typeof fork === "object" &&
                !Array.isArray(fork) &&
                record.offset <= (fork as { readonly forkOffset?: string }).forkOffset!
              );
            })
            .map((record) => ({ record, sourceStreamId: mainStream })),
          ...leaf.map((record) => ({ record, sourceStreamId: featureStream })),
        ];
  return raw.map(({ record, sourceStreamId }, ordinal) => ({
    ...record,
    offset: offsetForOrdinal(ordinal),
    sourceStreamId,
    actor: actorOf(record),
  }));
}

function rowValues(page: Page): Promise<HistoryRowValue[]> {
  return page.getByTestId("history-row").evaluateAll((nodes) =>
    nodes.map((node) => ({
      offset: node.getAttribute("data-ef-offset"),
      sourceStreamId: node.getAttribute("data-history-source-stream"),
      actor: node.getAttribute("data-history-actor"),
      kind: node.getAttribute("data-history-kind"),
      known: node.getAttribute("data-history-known"),
      raw: node.getAttribute("data-history-raw"),
    })),
  );
}

function seededSample(length: number, count = 3): readonly number[] {
  const selected = new Set<number>();
  let state = 0xe309;
  while (selected.size < Math.min(count, length)) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    selected.add((state >>> 0) % length);
  }
  return [...selected].sort((left, right) => left - right);
}

await mkdir(evidence, { recursive: true });
await mkdir(resolve(task, "work"), { recursive: true });
await writeFile(resolve(task, "work/e3-t09-empty-proof-receipt.json"), "{}\n");
const world = await bootWorld({
  root,
  subject,
  fixtureLogin: true,
  proofReceiptPath: resolve(task, "work/e3-t09-empty-proof-receipt.json"),
});
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
const main = await world.seedPublicRepo({
  org: "maple",
  project: "canopy",
  repo: "reading-room",
  branch: "main",
  events: [
    { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 100 },
    { type: "future.event", payload: { v: 99, path: "unknown.txt" }, ts: 100 },
    {
      type: "fs.file.create",
      payload: { v: 2, path: "base.txt", contentStreamId: "fs:history:file" },
      ts: 100,
    },
  ],
});
await world.appendApplication(main, {
  type: "future.actor-spoof",
  payload: { v: 99, actor: "mallory", path: "actor-spoof.txt" },
  ts: 100,
});
await world.appendApplication(main, {
  type: "sync/conflict",
  payload: {
    v: 1,
    path: "base.txt",
    conflictFile: "base.txt.conflict-0000000000000000_0000000000000002",
    winningOffset: offsetForOrdinal(2),
    loserSha256: "a".repeat(64),
  },
  ts: 100,
});
const repositoryEventTime = { value: 100 };
const homes = new RepositoryHomeStore(streams, () => repositoryEventTime.value++);
await homes.ensureRepository("maple", "reading-room", "canopy");
const mainRecords = await readDurableJson<StreamRecord>({
  url: `${world.streamUrl}/streams/${encodeURIComponent(main)}`,
});
const forkOffset = mainRecords.at(-1)!.offset;
await streams.create(featureStream);
await streams.append(
  featureStream,
  {
    type: "fs.branch.fork",
    payload: { v: 1, parentStreamId: main, forkOffset },
    ts: 101,
  },
  { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
);
await homes.registerNativeBranch("maple", "reading-room", "feature");
await world.appendApplication(featureStream, {
  type: "future.branch",
  payload: { v: 88, path: "feature-only.txt" },
  ts: 100,
});
await world.appendApplication(main, {
  type: "fs.file.create",
  payload: { v: 99, path: "future-version.txt", contentStreamId: "fs:future:file" },
  ts: 100,
});

const browser = await chromium.launch({ executablePath: replayChromiumPath(), headless: true });
const guarded = await world.openPage(browser);
let consoleErrors = 0;
let pageErrors = 0;
let abortedRequests = 0;
guarded.page.on("console", (message) => {
  if (message.type() === "error") consoleErrors += 1;
});
guarded.page.on("pageerror", () => {
  pageErrors += 1;
});
guarded.page.on("requestfailed", (request) => {
  if (request.failure()?.errorText === "net::ERR_ABORTED") abortedRequests += 1;
});
await guarded.page.addInitScript(() => {
  const originalFetch = window.fetch.bind(window);
  const control = {
    enabled: false,
    used: false,
    malformedBootstrap: sessionStorage.getItem("e3t09-disable-malformed") !== "1",
    malformedBootstrapUsed: false,
  };
  (window as unknown as { __e3t09Reconnect: typeof control }).__e3t09Reconnect = control;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
      window.location.origin,
    );
    if (
      control.enabled &&
      !control.used &&
      url.pathname.endsWith("/events") &&
      url.searchParams.get("live") === "1" &&
      url.searchParams.get("reducer") === "history"
    ) {
      control.used = true;
      throw new TypeError("fixture history reconnect");
    }
    if (
      control.malformedBootstrap &&
      !control.malformedBootstrapUsed &&
      url.pathname.endsWith("/events") &&
      url.searchParams.get("live") !== "1" &&
      url.searchParams.get("reducer") === "history"
    ) {
      control.malformedBootstrapUsed = true;
      return new Response(
        JSON.stringify({
          events: [
            {
              offset: "not-an-offset",
              type: "future.event",
              payload: { v: 99 },
              ts: 1,
            },
          ],
          checkpoint: "not-an-offset",
          reducer: { id: "history", version: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

const transcript: string[] = ["E3-T09 canonical history browser proof"];
try {
  await guarded.page.goto(world.platformUrl);
  await loginWithFixture(guarded.page);
  await guarded.page.evaluate(() => {
    (
      window as unknown as { __e3t09Reconnect: { malformedBootstrap: boolean } }
    ).__e3t09Reconnect.malformedBootstrap = true;
  });
  await guarded.page.goto(`${world.platformUrl}/history/maple/reading-room/main`);
  await guarded.page.getByTestId("history-refusal").waitFor();
  transcript.push("malformed-history-refusal=true");
  await guarded.page.evaluate(() => {
    window.sessionStorage.setItem("e3t09-disable-malformed", "1");
    (
      window as unknown as { __e3t09Reconnect: { malformedBootstrap: boolean } }
    ).__e3t09Reconnect.malformedBootstrap = false;
  });
  await guarded.page.reload();
  await guarded.page.getByTestId("history-rows").waitFor();
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="history-view"]')?.getAttribute("data-stream-status") ===
      "live",
  );
  const mainRaw = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(main)}`,
  });
  const expectedMain = logicalHistory(mainRaw);
  let rows = await rowValues(guarded.page);
  assert.equal(rows.length, expectedMain.length);
  assert.deepEqual(
    rows.map((row) => row.offset),
    expectedMain.map((record) => record.offset).reverse(),
  );
  assert.deepEqual(
    rows.map((row) => row.actor),
    expectedMain.map((record) => record.actor).reverse(),
  );
  const unknown = rows.find((row) => row.kind === "future.event@v99");
  assert.equal(unknown?.known, "false");
  const unknownRecord = expectedMain.find((record) => record.type === "future.event")!;
  assert.equal(unknown?.raw, canonicalJson(unknownRecord.payload));
  const unknownKnownType = rows.find((row) => row.kind === "fs.file.create@v99");
  assert.equal(unknownKnownType?.known, "false");
  const unknownKnownTypeRecord = expectedMain.find(
    (record) =>
      record.type === "fs.file.create" && (record.payload as { readonly v?: unknown }).v === 99,
  )!;
  assert.equal(unknownKnownType?.raw, canonicalJson(unknownKnownTypeRecord.payload));
  assert.equal(rows.find((row) => row.kind === "sync/conflict")?.known, "true");
  await guarded.page
    .getByTestId("history-row")
    .filter({ hasText: "preserved local conflict for base.txt" })
    .waitFor();
  transcript.push("sync-conflict-known=true humanized-summary-visible=true");
  const spoof = rows.find((row) => row.kind === "future.actor-spoof@v99");
  const spoofRecord = expectedMain.find((record) => record.type === "future.actor-spoof")!;
  assert.equal((spoofRecord.payload as { readonly actor?: unknown }).actor, `auth0|${subject.id}`);
  assert.equal(spoof?.actor, spoofRecord.actor);
  assert.ok(rows.every((row) => row.sourceStreamId === main));
  transcript.push(
    `main rows=${rows.length} newest-first=true unknown-raw-citable=true actors-from-writer=true`,
  );

  await guarded.page.reload();
  await guarded.page.getByTestId("history-rows").waitFor();
  const reloadedRows = await rowValues(guarded.page);
  assert.deepEqual(
    reloadedRows.map((row) => row.offset),
    rows.map((row) => row.offset),
  );
  transcript.push("reload ordering-stable=true");

  const beforeLive = expectedMain.length;
  await world.appendApplicationAs(
    main,
    {
      type: "future.same-time-a",
      payload: { v: 77, path: "same-time-a" },
      ts: 100,
    },
    "auth0|writer-a",
  );
  await world.appendApplicationAs(
    main,
    {
      type: "future.same-time-b",
      payload: { v: 77, path: "same-time-b" },
      ts: 100,
    },
    "auth0|writer-b",
  );
  await guarded.page.getByTestId("history-row").filter({ hasText: "future.same-time-b" }).waitFor();
  rows = await rowValues(guarded.page);
  assert.equal(rows.length, beforeLive + 2);
  assert.equal(rows[0]!.kind, "future.same-time-b@v77");
  assert.equal(rows[1]!.kind, "future.same-time-a@v77");
  assert.equal(rows[0]!.actor, "auth0|writer-b");
  assert.equal(rows[1]!.actor, "auth0|writer-a");
  transcript.push(
    "same-timestamp offset-order=true live-events-prepend=true history-preserved=true",
  );
  transcript.push("same-timestamp-writers=auth0|writer-a,auth0|writer-b");

  await guarded.page.evaluate(() => {
    (window as unknown as { __e3t09Reconnect: { enabled: boolean } }).__e3t09Reconnect.enabled =
      true;
  });
  await guarded.page.waitForFunction(
    () => (window as unknown as { __e3t09Reconnect: { used: boolean } }).__e3t09Reconnect.used,
  );
  await guarded.page.waitForFunction(
    () => document.querySelector('[data-testid="history-status"]')?.textContent === "reconnecting",
  );
  await world.appendApplication(main, {
    type: "future.boundary",
    payload: { v: 100, path: "boundary" },
    ts: 100,
  });
  await guarded.page.getByTestId("history-row").filter({ hasText: "future.boundary" }).waitFor();
  await guarded.page.waitForFunction(
    () => document.querySelector('[data-testid="history-status"]')?.textContent === "live",
  );
  transcript.push("boundary-reconnect=true event-preserved=true status=live");

  await guarded.page.getByTestId("branch-selector").selectOption("feature");
  await guarded.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="history-view"]')?.getAttribute("data-branch") ===
      "feature",
  );
  await guarded.page.getByTestId("history-row").filter({ hasText: "future.branch" }).waitFor();
  const featureRaw = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(featureStream)}`,
  });
  const finalMainRaw = await readDurableJson<StreamRecord>({
    url: `${world.streamUrl}/streams/${encodeURIComponent(main)}`,
  });
  const expectedFeature = logicalHistory(finalMainRaw, featureRaw);
  rows = await rowValues(guarded.page);
  assert.equal(rows.length, expectedFeature.length);
  assert.deepEqual(
    rows.map((row) => row.offset),
    expectedFeature.map((record) => record.offset).reverse(),
  );
  assert.ok(rows.some((row) => row.sourceStreamId === main));
  assert.ok(rows.some((row) => row.sourceStreamId === featureStream));
  const sampleIndices = seededSample(rows.length);
  for (const index of sampleIndices) {
    const row = rows[index]!;
    const record = expectedFeature[expectedFeature.length - 1 - index]!;
    assert.equal(row.offset, record.offset);
    assert.equal(row.sourceStreamId, record.sourceStreamId);
    assert.equal(row.actor, record.actor);
    assert.equal(row.raw, canonicalJson(record.payload));
  }
  transcript.push(
    `feature inherited=true fork-visible=true branch-local=true sampled-random-row-byte-match=true sample-seed=0xe309 sample-indices=${sampleIndices.join(",")} rows=${rows.length}`,
  );

  await guarded.settleNetwork();
  assert.equal(consoleErrors, 0);
  assert.equal(pageErrors, 0);
  transcript.push(`console-errors=0 page-errors=0 expected-route-aborts=${abortedRequests}`);

  await writeFile(resolve(evidence, "e3-t09-browser.txt"), `${transcript.join("\n")}\n`);
  await writeFile(
    resolve(evidence, "e3-t09-events.json"),
    `${canonicalJson({ main: logicalHistory(finalMainRaw), feature: expectedFeature })}\n`,
  );
  await writeFile(
    resolve(evidence, "e3-t09-digests.json"),
    `${canonicalJson({
      main: replayWithReducer(historyReducerDefinition, logicalHistory(finalMainRaw)),
      feature: replayWithReducer(historyReducerDefinition, expectedFeature),
    })}\n`,
  );
  process.stdout.write(`${transcript.join("\n")}\n`);
} finally {
  await guarded.close();
  await browser.close();
  await world.close();
}

process.exit(0);
