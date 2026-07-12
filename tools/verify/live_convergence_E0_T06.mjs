import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHttpServer } from "../../packages/server/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(process.cwd());
const evidenceDir = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function startServer() {
  const server = createHttpServer(undefined, { longPollTimeoutMs: 1_000, sseHeartbeatMs: 200 });
  await new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "server did not expose a TCP address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolveStop, reject) => {
    server.close((error) => (error ? reject(error) : resolveStop()));
  });
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function create(base, streamId) {
  const response = await request(base, `/streams/${streamId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamId, verifier: "E0-T06" }),
  });
  assert(response.status === 201, `create ${streamId} returned ${response.status}`);
}

async function append(base, streamId, sequence, events) {
  const response = await request(base, `/streams/${streamId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": String(sequence) },
    body: JSON.stringify({ events }),
  });
  assert(response.status === 201, `append ${streamId}/${sequence} returned ${response.status}`);
  return JSON.parse(response.body).events;
}

function parseSse(text) {
  const frames = [];
  let comments = 0;
  for (const block of text.split("\n\n")) {
    if (!block) continue;
    if (block.startsWith(":")) {
      comments += 1;
      continue;
    }
    const id = block.split("\n").find((line) => line.startsWith("id: "))?.slice(4);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (id && data) frames.push({ id, records: JSON.parse(data) });
  }
  return { frames, comments };
}

async function collectSse(base, streamId, expectedRecords, offset = "-1") {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/streams/${streamId}?offset=${encodeURIComponent(offset)}&live=sse`,
    { signal: controller.signal },
  );
  assert(response.status === 200, `SSE ${streamId} returned ${response.status}`);
  assert(response.headers.get("content-type")?.includes("text/event-stream"), "SSE content type missing");
  assert(response.body, "SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (parseSse(text).frames.flatMap((frame) => frame.records).length < expectedRecords) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE closed before expected records arrived");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  const parsed = parseSse(text);
  return { frames: parsed.frames, records: parsed.frames.flatMap((frame) => frame.records) };
}

async function collectSseWindow(base, streamId, durationMs, offset) {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/streams/${streamId}?offset=${encodeURIComponent(offset)}&live=sse`,
    { signal: controller.signal },
  );
  assert(response.status === 200, `SSE window ${streamId} returned ${response.status}`);
  assert(response.body, "SSE window has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + durationMs;
  let text = "";
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read().then((chunk) => ({ kind: "chunk", chunk })),
        delay(Math.max(1, deadline - Date.now())).then(() => ({ kind: "timeout" })),
      ]);
      if (result.kind === "timeout") break;
      if (result.chunk.done) break;
      text += decoder.decode(result.chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return parseSse(text);
}

async function collectLongPoll(base, streamId, expectedRecords, offset = "-1") {
  const records = [];
  const responses = [];
  let nextOffset = offset;
  while (records.length < expectedRecords) {
    const response = await request(
      base,
      `/streams/${streamId}?offset=${encodeURIComponent(nextOffset)}&live=long-poll`,
    );
    responses.push(response);
    if (response.status === 204) {
      nextOffset = response.headers.get("stream-next-offset");
      assert(nextOffset, "long-poll timeout omitted Stream-Next-Offset");
      continue;
    }
    assert(response.status === 200, `long-poll returned ${response.status}`);
    const batch = JSON.parse(response.body);
    assert(batch.length > 0, "long-poll returned an empty success batch");
    records.push(...batch);
    nextOffset = response.headers.get("stream-next-offset");
    assert(nextOffset === batch.at(-1).offset, "long-poll resume header did not equal batch head");
  }
  return { records, responses };
}

function writeLog(path, records) {
  writeFileSync(path, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
}

function replayDigest(path) {
  const result = spawnSync(process.execPath, ["packages/cli/dist/src/bin.js", "replay", path, "--digest"], {
    cwd: root,
    encoding: "utf8",
  });
  assert(result.status === 0, `ef replay failed for ${path}: ${result.stderr}`);
  assert(/^[0-9a-f]{64}\n$/.test(result.stdout), `ef replay emitted invalid digest for ${path}`);
  return result.stdout.trim();
}

async function main() {
  const { server, base } = await startServer();
  const temp = mkdtempSync(join(tmpdir(), "eforest-e0-t06-"));
  try {
    const streamId = "e0-t06-convergence";
    await create(base, streamId);
    const batches = [
      [{ type: "set", payload: 1, ts: 1 }],
      [
        { type: "increment", payload: 2, ts: 2 },
        { type: "push", payload: "three", ts: 3 },
      ],
      [{ type: "meta", payload: { phase: "tail" }, ts: 4 }],
    ];
    const total = batches.reduce((count, batch) => count + batch.length, 0);
    const longPollPromise = collectLongPoll(base, streamId, total);
    const ssePromise = collectSse(base, streamId, total);
    await delay(40);
    const writerRecords = [];
    for (const [sequence, batch] of batches.entries()) {
      await delay(20 + sequence * 15);
      writerRecords.push(...(await append(base, streamId, sequence, batch)));
    }
    const [longPoll, sse] = await Promise.all([longPollPromise, ssePromise]);
    const coldGet = JSON.parse((await request(base, `/streams/${streamId}?offset=-1`)).body);
    assert(JSON.stringify(longPoll.records) === JSON.stringify(coldGet), "long-poll tail diverged from cold GET");
    assert(JSON.stringify(sse.records) === JSON.stringify(coldGet), "SSE tail diverged from cold GET");
    assert(sse.frames.length === batches.length, "SSE did not emit one frame per append batch");
    assert(
      sse.frames.every((frame) => frame.id === frame.records.at(-1).offset),
      "SSE frame id did not carry its resume offset",
    );

    const paths = {
      writer: join(temp, "writer-input.jsonl"),
      longPoll: join(temp, "longpoll-tail.jsonl"),
      sse: join(temp, "sse-tail.jsonl"),
      cold: join(temp, "cold-get.jsonl"),
    };
    writeLog(paths.writer, writerRecords);
    writeLog(paths.longPoll, longPoll.records);
    writeLog(paths.sse, sse.records);
    writeLog(paths.cold, coldGet);
    const digests = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, replayDigest(path)]));
    assert(new Set(Object.values(digests)).size === 1, `digest mismatch: ${JSON.stringify(digests)}`);

    const prefix = await collectSse(base, streamId, total);
    const savedOffset = prefix.frames.at(-1).id;
    const suffixRecords = await append(base, streamId, 3, [{ type: "push", payload: "five", ts: 5 }]);
    const suffix = await collectSse(base, streamId, suffixRecords.length, savedOffset);
    assert(suffix.records[0].offset > savedOffset, "resume duplicated the saved boundary event");
    const resumedCold = JSON.parse((await request(base, `/streams/${streamId}?offset=-1`)).body);
    const prefixPath = join(temp, "resume-prefix.jsonl");
    const suffixPath = join(temp, "resume-suffix.jsonl");
    const concatPath = join(temp, "resume-concat.jsonl");
    const resumedColdPath = join(temp, "resume-cold.jsonl");
    writeLog(prefixPath, prefix.records);
    writeLog(suffixPath, suffix.records);
    writeLog(concatPath, [...prefix.records, ...suffix.records]);
    writeLog(resumedColdPath, resumedCold);
    const resumedDigests = [prefixPath, suffixPath, concatPath, resumedColdPath].map(replayDigest);
    assert(resumedDigests[2] === resumedDigests[3], "prefix plus suffix digest diverged from cold GET");
    assert(resumedDigests[0] !== resumedDigests[1], "resume prefix and suffix were not distinct logs");
    assert(
      JSON.stringify([...prefix.records, ...suffix.records]) === JSON.stringify(resumedCold),
      "prefix plus resumed suffix diverged from cold GET",
    );

    const timeoutId = "e0-t06-timeout";
    await create(base, timeoutId);
    const started = performance.now();
    const timeout = await request(base, `/streams/${timeoutId}?offset=-1&live=long-poll`);
    const elapsed = performance.now() - started;
    assert(timeout.status === 204 && timeout.body === "", "long-poll timeout shape was not 204/empty");
    assert(elapsed >= 1_000 && elapsed <= 1_500, `long-poll timeout elapsed ${elapsed}ms`);
    assert(timeout.headers.get("stream-next-offset") === "-1", "timeout head was not -1");
    const timeoutRecords = await append(base, timeoutId, 0, [{ type: "set", payload: 9, ts: 9 }]);
    const afterTimeout = await request(
      base,
      `/streams/${timeoutId}?offset=${encodeURIComponent(timeout.headers.get("stream-next-offset"))}&live=long-poll`,
    );
    assert(JSON.parse(afterTimeout.body).length === timeoutRecords.length, "timeout offset could not resume exactly");

    const heartbeatId = "e0-t06-heartbeat";
    await create(base, heartbeatId);
    const heartbeat = await collectSseWindow(base, heartbeatId, 650, "-1");
    assert(heartbeat.comments >= 2, `expected at least two heartbeats, got ${heartbeat.comments}`);
    assert(heartbeat.frames.length === 0, "quiescent heartbeat stream emitted a data frame");

    const fencedId = "e0-t06-fenced";
    await create(base, fencedId);
    const firstFenced = await append(base, fencedId, 0, [{ type: "set", payload: 1, ts: 1 }]);
    const fencedHead = firstFenced.at(-1).offset;
    const fencedLongPoll = request(
      base,
      `/streams/${fencedId}?offset=${encodeURIComponent(fencedHead)}&live=long-poll`,
    );
    const fencedSse = collectSseWindow(base, fencedId, 1_200, fencedHead);
    await delay(40);
    const rejected = await request(base, `/streams/${fencedId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "0" },
      body: JSON.stringify({ events: [{ type: "rejected", payload: true, ts: 2 }] }),
    });
    assert(rejected.status === 409, "fenced append was not rejected");
    const fencedTimeout = await fencedLongPoll;
    assert(fencedTimeout.status === 204, "rejected append woke long-poll as a success");
    const fencedSseResult = await fencedSse;
    assert(fencedSseResult.frames.length === 0, "rejected append emitted an SSE data frame");

    const summary = {
      task: "E0-T06",
      replay: "ef replay --digest",
      digests,
      resumeDigests: resumedDigests,
      timeoutMs: elapsed,
      heartbeatComments: heartbeat.comments,
      fencedLongPollStatus: fencedTimeout.status,
      fencedSseDataFrames: fencedSseResult.frames.length,
    };
    const output = `${JSON.stringify(summary, null, 2)}\n`;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      for (const [name, path] of Object.entries(paths)) {
        writeFileSync(join(evidenceDir, `e0-t06-${name === "longPoll" ? "longpoll-tail" : name === "sse" ? "sse-tail" : name === "cold" ? "cold-get" : "writer-input"}.jsonl`), readFileSync(path));
      }
      writeFileSync(join(evidenceDir, "e0-t06-resume-prefix.jsonl"), readFileSync(prefixPath));
      writeFileSync(join(evidenceDir, "e0-t06-resume-suffix.jsonl"), readFileSync(suffixPath));
      writeFileSync(join(evidenceDir, "e0-t06-resume-concat.jsonl"), readFileSync(concatPath));
      writeFileSync(join(evidenceDir, "e0-t06-digests.txt"), `${Object.entries(digests).map(([name, digest]) => `${name} ${digest}`).join("\n")}\n`);
      writeFileSync(join(evidenceDir, "e0-t06-verify-summary.json"), output);
    }
    process.stdout.write(`${Object.entries(digests).map(([name, digest]) => `${name}: ${digest}`).join("\n")}\n`);
    process.stdout.write(output);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    await stopServer(server);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
