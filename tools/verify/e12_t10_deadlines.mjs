import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createPlatformServer,
  listenPlatformServer,
  platformTimeouts,
} from "../../packages/platform/dist/src/server.js";
import { connect } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const { Response, ReadableStream, clearTimeout } = globalThis;
const root = resolve(import.meta.dirname, "../..");
const task = resolve(root, ".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway");
const output = resolve(process.argv[2] ?? resolve(task, "work/deadlines"));
await mkdir(output, { recursive: true });
const records = [];
async function trial(name, writes, handlerMs = 0, clientCloseAt) {
  const marks = [];
  const started = performance.now();
  const server = createPlatformServer(
    async (request) => {
      const path = new URL(request.url).pathname;
      marks.push({ event: "admitted", path, ms: Math.round(performance.now() - started) });
      if (path === "/stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: established\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (handlerMs) await new Promise((done) => setTimeout(done, handlerMs));
      return new Response("ok");
    },
    { origin: "https://fixture.invalid", requestDeadlineMs: 500, maxBodyBytes: 1024 },
  );
  const address = await listenPlatformServer(server);
  const receipt = await new Promise((done) => {
    const socket = connect(Number(new URL(address).port), "127.0.0.1");
    let output = "";
    let error;
    const timers = [];
    socket.on("connect", () => {
      for (const [at, bytes] of writes)
        timers.push(
          setTimeout(() => {
            if (!socket.destroyed) {
              marks.push({
                event: "write",
                at,
                ms: Math.round(performance.now() - started),
                bytes: Buffer.byteLength(bytes),
              });
              socket.write(bytes);
            }
          }, at),
        );
      if (clientCloseAt) timers.push(setTimeout(() => socket.end(), clientCloseAt));
    });
    socket.setTimeout(2500, () => {
      socket.destroy();
      error = "sensor-timeout";
    });
    socket.on("data", (chunk) => {
      output += chunk.toString();
    });
    socket.on("error", (cause) => {
      error = cause.code;
    });
    socket.on("close", () => {
      timers.forEach(clearTimeout);
      done({
        statuses: [...output.matchAll(/HTTP\/1\.1 (\d+)/g)].map((m) => Number(m[1])),
        elapsedMs: Math.round(performance.now() - started),
        error: error ?? null,
        established: output.includes("data: established"),
        requestDeadlineBody: output.includes("request-deadline"),
      });
    });
  });
  await new Promise((done) => {
    server.close(done);
    server.closeAllConnections();
  });
  records.push({
    name,
    deadlineMs: 500,
    handlerMs,
    clientCloseAt: clientCloseAt ?? null,
    ...receipt,
    marks,
  });
}
await trial("slow-initial-header", [[0, "GET /slow HTTP/1.1\r\nHost: fixture"]]);
await trial(
  "header-after-initial-idle-gets-own-window",
  [
    [420, "GET /slow HTTP/1.1\r\nHost: fixture"],
    [650, "\r\nConnection: close\r\n\r\n"],
  ],
  50,
);
await trial("partial-pipelined-next-header", [
  [0, "GET /fast HTTP/1.1\r\nHost: fixture\r\n\r\nGET /slow HTTP/1.1\r\nHost: fixture"],
]);
await trial(
  "valid-pipelined-requests",
  [
    [
      0,
      "GET /fast HTTP/1.1\r\nHost: fixture\r\n\r\nGET /slow HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n",
    ],
  ],
  100,
);
await trial("trickled-header-is-not-rolling", [
  [0, "G"],
  [200, "E"],
  [400, "T"],
  [600, " "],
]);
await trial(
  "body-and-handler-share-admitted-request-budget",
  [
    [0, "POST /slow HTTP/1.1\r\nHost: fixture\r\nContent-Length: 1\r\n\r\n"],
    [350, "x"],
  ],
  300,
);
await trial(
  "established-SSE-survives-header-deadline",
  [[0, "GET /stream HTTP/1.1\r\nHost: fixture\r\n\r\n"]],
  0,
  750,
);
async function idleArrival(mode) {
  const marks = [];
  const began = performance.now();
  const server = createPlatformServer(
    async (request) => {
      const path = new URL(request.url).pathname;
      marks.push({ event: "handler-admitted", path, ms: Math.round(performance.now() - began) });
      if (path === "/slow") await new Promise((done) => setTimeout(done, 150));
      marks.push({ event: "handler-completed", path, ms: Math.round(performance.now() - began) });
      return new Response(path);
    },
    { origin: "https://fixture.invalid", requestDeadlineMs: 500 },
  );
  const address = await listenPlatformServer(server);
  const result = await new Promise((done, reject) => {
    const socket = connect(Number(new URL(address).port), "127.0.0.1");
    let data = "";
    let next = false;
    const send = (path, last) => {
      marks.push({ event: "request-sent", path, ms: Math.round(performance.now() - began) });
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: fixture\r\nConnection: ${last ? "close" : "keep-alive"}\r\n\r\n`,
      );
    };
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("idle-arrival sensor timed out"));
    });
    socket.on("connect", () => {
      if (mode === "initial") setTimeout(() => send("/slow", true), 420);
      else send("/fast", false);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (mode === "keepalive" && !next && data.includes("/fast")) {
        next = true;
        setTimeout(() => send("/slow", true), 420);
      }
    });
    socket.on("error", reject);
    socket.on("end", () =>
      done({
        statuses: [...data.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => Number(match[1])),
        elapsedMs: Math.round(performance.now() - began),
      }),
    );
  });
  await new Promise((done) => {
    server.close(done);
    server.closeAllConnections();
  });
  assert.deepEqual(result.statuses, mode === "initial" ? [200] : [200, 200]);
  records.push({
    name: `${mode}-idle-does-not-consume-request-budget`,
    deadlineMs: 500,
    idleMs: 420,
    handlerMs: 150,
    ...result,
    marks,
  });
}
await idleArrival("initial");
await idleArrival("keepalive");
const expected = {
  "slow-initial-header": [408],
  "header-after-initial-idle-gets-own-window": [200],
  "partial-pipelined-next-header": [200, 408],
  "valid-pipelined-requests": [200, 200],
  "trickled-header-is-not-rolling": [408],
  "body-and-handler-share-admitted-request-budget": [504],
  "established-SSE-survives-header-deadline": [200],
};
for (const record of records) {
  if (expected[record.name]) assert.deepEqual(record.statuses, expected[record.name], record.name);
  assert.equal(record.error ?? null, null, `${record.name}: transport error`);
  if (
    [
      "slow-initial-header",
      "partial-pipelined-next-header",
      "trickled-header-is-not-rolling",
      "body-and-handler-share-admitted-request-budget",
    ].includes(record.name)
  ) {
    assert.ok(
      record.elapsedMs >= 450 && record.elapsedMs <= 1000,
      `${record.name}: ${record.elapsedMs}ms outside parser polling/scheduler allowance`,
    );
  }
  if (record.name === "established-SSE-survives-header-deadline") {
    assert.equal(record.established, true);
    assert.ok(record.elapsedMs >= 700);
    assert.equal(record.requestDeadlineBody, false);
  }
}
const receipt = {
  task: "E12-T10",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  node: process.version,
  profile: platformTimeouts(500),
  productionProfile: platformTimeouts(30000),
  phasePolicy:
    "Node parser-owned header/receive deadlines; independent idle timeout; admitted body+handler+finite-response deadline; established SSE cancelled by client/drain",
  records,
};
await writeFile(resolve(output, "deadlines.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(
  `E12-T10 native deadlines: ${records.length} phase/idle/pipeline/SSE cases passed\n`,
);
