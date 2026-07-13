import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  compareOffsets,
  stateDigest,
} from "../../packages/protocol/dist/src/index.js";
import { createHttpServer, FileStreamStore } from "../../packages/server/dist/src/index.js";
import {
  diffText,
  digestBytes,
  FS_EVENT_VERSION,
  createStreamFsServerOptions,
} from "../../packages/streamfs/dist/src/index.js";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const taskRoot = join(repoRoot, ".eforest/tasks/epic-1-the-trunk/E1-T06-convergence-harness");
const evidenceRoot = join(taskRoot, "evidence");
const clientPath = join(repoRoot, "tools/verify/convergence-client.mjs");
const reducerPath = join(repoRoot, "packages/streamfs/reducer.mjs");
const cliPath = join(repoRoot, "packages/cli/dist/src/bin.js");
const recordMode = process.argv.includes("--record");
const suppressArg = process.argv.indexOf("--suppress-live");
const corruptArg = process.argv.indexOf("--corrupt-cold-byte");
const suppressIndex = suppressArg >= 0 ? Number(process.argv[suppressArg + 1]) : undefined;
const corruptByte = corruptArg >= 0 ? Number(process.argv[corruptArg + 1]) : undefined;
const STALE_SENTINEL = "deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe";
const CONTENT_STREAM = "fs:e1-t06:main:file:1-fixed";
const BASE_NONE = "BASE_NONE";

if (suppressArg >= 0 && (!Number.isSafeInteger(suppressIndex) || suppressIndex < 1))
  throw new Error("--suppress-live requires a positive 1-based record index");
if (corruptArg >= 0 && (!Number.isSafeInteger(corruptByte) || corruptByte < 0))
  throw new Error("--corrupt-cold-byte requires a non-negative byte index");

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value);
const sha = (value) => digestBytes(bytes(value));
const event = (type, payload, ts) => ({ type, payload, ts });
const fileContent = (value, ts) =>
  event(
    "fs.file.content",
    {
      v: FS_EVENT_VERSION,
      contentStreamId: CONTENT_STREAM,
      contentBase64: Buffer.from(value).toString("base64"),
    },
    ts,
  );

function scenarioSteps(context) {
  const initial = "alpha\n";
  const revised = "alpha revised\n";
  const patchOne = "alpha revised once\n";
  const patchTwo = "alpha revised twice\n";
  const final = "final bytes\n";
  return [
    { kind: "raw", event: fileContent(initial, 1), label: "initial content" },
    {
      kind: "dispatch",
      event: () => event("fs.dir.create", { v: FS_EVENT_VERSION, path: "src" }, 2),
      label: "mkdir src",
    },
    {
      kind: "dispatch",
      event: () =>
        event(
          "fs.file.create",
          { v: FS_EVENT_VERSION, path: "src/readme.md", contentStreamId: CONTENT_STREAM },
          3,
        ),
      label: "create readme",
    },
    {
      kind: "dispatch",
      event: () =>
        event(
          "fs.file.write",
          {
            v: FS_EVENT_VERSION,
            path: "src/readme.md",
            base: BASE_NONE,
            contentSha256: sha(initial),
            size: bytes(initial).byteLength,
          },
          4,
        ),
      label: "write initial",
      after: (record) => {
        context.baseOffset = record.offset;
        context.content = initial;
      },
    },
    { kind: "raw", event: fileContent(revised, 5), label: "append revised content" },
    {
      kind: "dispatch",
      event: () =>
        event(
          "fs.file.write",
          {
            v: FS_EVENT_VERSION,
            path: "src/readme.md",
            base: context.baseOffset,
            contentSha256: sha(revised),
            size: bytes(revised).byteLength,
          },
          6,
        ),
      label: "write revised",
      after: (record) => {
        context.baseOffset = record.offset;
        context.content = revised;
      },
    },
    {
      kind: "dispatch",
      event: () =>
        event(
          "fs.file.patch",
          {
            v: FS_EVENT_VERSION,
            path: "src/readme.md",
            base: context.baseOffset,
            baseDigest: sha(context.content),
            ops: diffText(context.content, patchOne),
            resultDigest: sha(patchOne),
          },
          7,
        ),
      label: "patch one",
      after: (record) => {
        context.baseOffset = record.offset;
        context.content = patchOne;
      },
    },
    {
      kind: "dispatch",
      event: () =>
        event(
          "fs.file.patch",
          {
            v: FS_EVENT_VERSION,
            path: "src/readme.md",
            base: context.baseOffset,
            baseDigest: sha(context.content),
            ops: diffText(context.content, patchTwo),
            resultDigest: sha(patchTwo),
          },
          8,
        ),
      label: "patch two",
      after: (record) => {
        context.baseOffset = record.offset;
        context.content = patchTwo;
      },
    },
    {
      kind: "dispatch",
      event: () => event("fs.dir.create", { v: FS_EVENT_VERSION, path: "src/nested" }, 9),
      label: "mkdir nested",
    },
    {
      kind: "dispatch",
      event: () =>
        event("fs.rename", { v: FS_EVENT_VERSION, from: "src/readme.md", to: "src/README.md" }, 10),
      label: "rename file",
    },
    {
      kind: "dispatch",
      event: () =>
        event("fs.rename", { v: FS_EVENT_VERSION, from: "src/nested", to: "archive" }, 11),
      label: "rename directory",
    },
    {
      kind: "dispatch",
      event: () => event("fs.file.delete", { v: FS_EVENT_VERSION, path: "src/README.md" }, 12),
      label: "delete file",
    },
    { kind: "raw", event: fileContent(final, 13), label: "append final content" },
    {
      kind: "dispatch",
      event: () =>
        event(
          "fs.file.create",
          { v: FS_EVENT_VERSION, path: "src/final.txt", contentStreamId: CONTENT_STREAM },
          14,
        ),
      label: "recreate file",
    },
    {
      kind: "dispatch",
      event: () =>
        event(
          "fs.file.write",
          {
            v: FS_EVENT_VERSION,
            path: "src/final.txt",
            base: BASE_NONE,
            contentSha256: sha(final),
            size: bytes(final).byteLength,
          },
          15,
        ),
      label: "write final",
      after: (record) => {
        context.finalOffset = record.offset;
      },
    },
    {
      kind: "dispatch",
      event: () => event("fs.dir.remove", { v: FS_EVENT_VERSION, path: "archive" }, 16),
      label: "remove empty archive",
    },
    {
      kind: "refuse",
      event: () =>
        event(
          "fs.file.write",
          {
            v: FS_EVENT_VERSION,
            path: "src/final.txt",
            base: BASE_NONE,
            contentSha256: STALE_SENTINEL,
            size: 999,
          },
          17,
        ),
      label: "refused stale write",
    },
  ];
}

function commandLine(args) {
  return `node tools/verify/convergence-client.mjs ${args.slice(1).join(" ")}`;
}

function logLine(transcriptPath, line) {
  appendFileSync(transcriptPath, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${description}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readNdjson(path) {
  const text = readFileSync(path, "utf8");
  return text.trim().length === 0
    ? []
    : text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
}

function parseDumpBody(body) {
  if (Array.isArray(body)) return body;
  if (typeof body === "string" && body.trim().length > 0) {
    return body
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  return [];
}

function dumpText(records) {
  return records.length === 0
    ? ""
    : `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
}

function childExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function startServer(dataDir) {
  const server = createHttpServer(new FileStreamStore(dataDir), {
    ...createStreamFsServerOptions(),
    longPollTimeoutMs: 40,
    sseHeartbeatMs: 20,
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("convergence server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = undefined;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

async function createStream(baseUrl, streamId, type = "fs-meta") {
  const result = await requestJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: canonicalJson({ type, version: `fs-v${FS_EVENT_VERSION}` }),
  });
  if (result.response.status !== 201)
    throw new Error(`stream create failed: ${JSON.stringify(result.body)}`);
}

async function appendRaw(baseUrl, streamId, sequence, sourceEvent) {
  const result = await requestJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": String(sequence) },
    body: canonicalJson({ events: [sourceEvent] }),
  });
  if (result.response.status !== 201 || !result.body?.events?.[0]) {
    throw new Error(`raw append failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  }
  return result.body.events[0];
}

async function dispatch(baseUrl, streamId, sourceEvent) {
  const result = await requestJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson(sourceEvent),
  });
  return result;
}

function launchClient({ role, baseUrl, streamId, mode, runDir, suppress, fresh = true }) {
  const checkpoint = join(runDir, `${role}.checkpoint.json`);
  const events = join(runDir, `${role}.events.jsonl`);
  const state = join(runDir, `${role}.state.json`);
  const ready = join(runDir, `${role}.ready`);
  if (fresh) {
    writeFileSync(checkpoint, `${canonicalJson({ offset: "-1" })}\n`);
    writeFileSync(events, "");
    writeFileSync(state, "{}");
  }
  try {
    unlinkSync(ready);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const args = [clientPath, role, baseUrl, streamId, mode, checkpoint, events, state, ready];
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...(suppress ? { EF_SUPPRESS_LIVE: String(suppress) } : {}) },
    stdio: "ignore",
  });
  return { child, args, checkpoint, events, state, ready, exit: childExit(child) };
}

async function stopChild(worker, signal = "SIGTERM") {
  if (!worker.child.killed) worker.child.kill(signal);
  return worker.exit;
}

function firstDifference(left, right, path = "state") {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right || left === null || right === null) return path;
  if (typeof left !== "object") return path;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return undefined;
}

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runEf(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result;
}

async function materialize(dumpPath, outPath) {
  const result = runEf(["materialize", dumpPath, "--out", outPath, "--reducer", reducerPath]);
  if (result.status !== 0) throw new Error(`ef materialize failed: ${result.stderr}`);
  const output = result.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(output))
    throw new Error(`ef materialize output is not one digest: ${result.stdout}`);
  return output;
}

function diffTrees(left, right) {
  const result = spawnSync("diff", ["-r", left, right], { encoding: "utf8" });
  if (result.status === 0) return undefined;
  const first = `${result.stdout}${result.stderr}`.trim().split("\n")[0] || `${left} vs ${right}`;
  return first;
}

function writeGoldens(serverDump, state, treeDir, treeDigest, transcript) {
  writeFileSync(join(evidenceRoot, "golden-scenario.jsonl"), dumpText(serverDump));
  writeFileSync(join(evidenceRoot, "golden-state.json"), `${canonicalJson(state)}\n`);
  writeFileSync(join(evidenceRoot, "golden-tree.digest"), `${treeDigest}\n`);
  const goldenTree = join(evidenceRoot, "golden-tree");
  rmSync(goldenTree, { recursive: true, force: true });
  cpSync(treeDir, goldenTree, { recursive: true });
  writeFileSync(join(evidenceRoot, "e1-t06-transcript.txt"), transcript);
}

async function main() {
  mkdirSync(evidenceRoot, { recursive: true });
  const runDir = mkdtempSync(join(tmpdir(), "eforest-e1-t06-"));
  const transcriptPath = join(runDir, "transcript.txt");
  writeFileSync(transcriptPath, "");
  const dataDir = join(runDir, "server-data");
  const streamId = "e1-t06-convergence-main";
  const context = {};
  let server;
  let live;
  let resumed;
  try {
    server = await startServer(dataDir);
    await createStream(server.baseUrl, streamId);
    await createStream(server.baseUrl, CONTENT_STREAM, "fs-file-content");
    logLine(transcriptPath, `SERVER file-backed: ${server.baseUrl} data=${dataDir}`);
    logLine(transcriptPath, "WRITER start scenario=e1-t06-golden");

    live = launchClient({
      role: "live",
      baseUrl: server.baseUrl,
      streamId,
      mode: "long-poll",
      runDir,
      suppress: suppressIndex,
    });
    logLine(transcriptPath, `CLIENT-L live-tail: ${commandLine(live.args)}`);
    await waitFor(() => existsSync(live.ready), "client L readiness");

    let sequence = 0;
    let contentSequence = 0;
    let killed = false;
    const steps = scenarioSteps(context);
    const records = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const source = typeof step.event === "function" ? step.event() : step.event;
      if (step.kind === "raw") {
        if (source.type === "fs.file.content") {
          await appendRaw(server.baseUrl, CONTENT_STREAM, contentSequence, source);
          contentSequence += 1;
        }
        const record = await appendRaw(server.baseUrl, streamId, sequence, source);
        sequence += 1;
        records.push(record);
      } else if (step.kind === "dispatch") {
        const result = await dispatch(server.baseUrl, streamId, source);
        if (result.response.status !== 201)
          throw new Error(`dispatch ${step.label} refused: ${JSON.stringify(result.body)}`);
        sequence = Number(result.response.headers.get("stream-seq")) + 1;
        records.push(result.body.event);
        step.after?.(result.body.event);
      } else {
        const result = await dispatch(server.baseUrl, streamId, source);
        if (result.response.status !== 409 && result.response.status !== 422) {
          throw new Error(`stale write unexpectedly returned ${result.response.status}`);
        }
        logLine(
          transcriptPath,
          `REFUSED stale-write status=${result.response.status} sentinel=${STALE_SENTINEL}`,
        );
      }
      if (!killed && index === 7) {
        await waitFor(
          () => readJson(live.checkpoint).offset !== "-1",
          "client L interior checkpoint",
        );
        const checkpoint = readJson(live.checkpoint).offset;
        if (checkpoint === "-1") throw new Error("client L checkpoint did not advance before kill");
        logLine(transcriptPath, `KILL client-L pid=${live.child.pid} at-offset=${checkpoint}`);
        await stopChild(live, "SIGKILL");
        killed = true;
        resumed = launchClient({
          role: "live",
          baseUrl: server.baseUrl,
          streamId,
          mode: "long-poll",
          runDir,
          suppress: suppressIndex,
          fresh: false,
        });
        logLine(transcriptPath, `RESUME client-L from-checkpoint offset=${checkpoint}`);
        await waitFor(() => existsSync(resumed.ready), "client L resume readiness");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    }
    if (!killed) throw new Error("writer did not exercise the required kill/resume window");
    const serverDumpResult = await requestJson(
      `${server.baseUrl}/streams/${encodeURIComponent(streamId)}/dump`,
    );
    if (!serverDumpResult.response.ok) throw new Error("server dump failed");
    const serverDump = parseDumpBody(serverDumpResult.body);
    const expectedLiveCount =
      suppressIndex !== undefined && suppressIndex <= serverDump.length
        ? serverDump.length - 1
        : serverDump.length;
    await waitFor(
      () => readNdjson(resumed.events).length === expectedLiveCount,
      "client L reaches head",
    );
    await stopChild(resumed);
    logLine(
      transcriptPath,
      `WRITER complete head=${serverDump.at(-1)?.offset ?? "-1"} records=${serverDump.length}`,
    );

    const cold = launchClient({
      role: "cold",
      baseUrl: server.baseUrl,
      streamId,
      mode: "long-poll",
      runDir,
    });
    logLine(transcriptPath, `CLIENT-C cold-replay: ${commandLine(cold.args)}`);
    await waitFor(() => existsSync(cold.ready), "client C readiness");
    const coldExit = await cold.exit;
    if (coldExit.code !== 0) throw new Error(`client C failed: ${JSON.stringify(coldExit)}`);

    const liveDump = readNdjson(resumed.events);
    const coldDump = readNdjson(cold.events);
    const liveState = readJson(resumed.state);
    const coldStatePath = cold.state;
    if (corruptByte !== undefined) {
      const corrupted = readFileSync(coldStatePath);
      const position = corruptByte >= corrupted.length ? corrupted.length - 1 : corruptByte;
      if (position < 0) throw new Error("cold state is empty");
      corrupted[position] ^= 1;
      writeFileSync(coldStatePath, corrupted);
    }
    const coldStateText = readFileSync(coldStatePath, "utf8");
    let coldState;
    try {
      coldState = JSON.parse(coldStateText);
    } catch {
      coldState = undefined;
    }
    const stateMismatch = coldState === undefined || firstDifference(liveState, coldState);
    const dumpMismatch = dumpText(liveDump) !== dumpText(coldDump);
    if (dumpMismatch || stateMismatch) {
      const bisect = runEf(["bisect", resumed.events, cold.events, "--reducer", reducerPath]);
      const bisectLine =
        `${bisect.stdout}${bisect.stderr}`
          .trim()
          .split("\n")
          .find((line) => line.includes("index")) ?? "ef bisect unavailable";
      const difference =
        stateMismatch === true
          ? "state-file"
          : (stateMismatch ??
            (suppressIndex === undefined ? "event-record" : `event-record[${suppressIndex}]`));
      logLine(
        transcriptPath,
        `DIVERGENCE path=${difference} dumpMismatch=${dumpMismatch} ${bisectLine}`,
      );
      if (suppressIndex === undefined && corruptByte === undefined)
        throw new Error(`unexpected convergence failure: ${difference}`);
      if (
        suppressIndex !== undefined &&
        !bisectLine.includes(`"index":${suppressIndex}`) &&
        !bisectLine.includes(`index=${suppressIndex}`) &&
        !bisectLine.includes(`index: ${suppressIndex}`)
      ) {
        throw new Error(`ef bisect did not pin suppression index ${suppressIndex}: ${bisectLine}`);
      }
      throw new Error(`expected divergence: path=${difference}`);
    }

    const goldenScenarioPath = join(evidenceRoot, "golden-scenario.jsonl");
    const goldenStatePath = join(evidenceRoot, "golden-state.json");
    const goldenDigestPath = join(evidenceRoot, "golden-tree.digest");
    const liveTree = join(runDir, "live-tree");
    const coldTree = join(runDir, "cold-tree");
    const serverTree = join(runDir, "server-tree");
    const liveDigest = await materialize(resumed.events, liveTree);
    const coldDigest = await materialize(cold.events, coldTree);
    const serverDumpPath = join(runDir, "server.jsonl");
    writeFileSync(serverDumpPath, dumpText(serverDump));
    const serverDigest = await materialize(serverDumpPath, serverTree);
    const treeDifference = diffTrees(liveTree, coldTree) ?? diffTrees(liveTree, serverTree);
    if (treeDifference || liveDigest !== coldDigest || liveDigest !== serverDigest) {
      throw new Error(`tree divergence path=${treeDifference ?? "digest"}`);
    }
    const expectedState = stateDigest(liveState);
    if (!recordMode) {
      if (
        !existsSync(goldenScenarioPath) ||
        dumpText(serverDump) !== readFileSync(goldenScenarioPath, "utf8")
      )
        throw new Error("server dump differs from committed golden-scenario.jsonl");
      if (
        !existsSync(goldenStatePath) ||
        canonicalJson(liveState) !== readFileSync(goldenStatePath, "utf8").trim()
      )
        throw new Error("client state differs from committed golden-state.json");
      if (
        !existsSync(goldenDigestPath) ||
        liveDigest !== readFileSync(goldenDigestPath, "utf8").trim()
      )
        throw new Error("materialize digest differs from committed golden-tree.digest");
      if (digestFile(join(evidenceRoot, "golden-state.json")) !== digestFile(goldenStatePath))
        throw new Error("golden state digest check failed");
      if (expectedState.length !== 64) throw new Error("state digest was not canonical");
    } else {
      writeGoldens(
        serverDump,
        liveState,
        serverTree,
        serverDigest,
        readFileSync(transcriptPath, "utf8"),
      );
    }
    if (
      !readFileSync(join(resumed.events), "utf8").includes(STALE_SENTINEL) &&
      !readFileSync(cold.events, "utf8").includes(STALE_SENTINEL)
    ) {
      logLine(transcriptPath, `STALE_SENTINEL absent from both client dumps: ${STALE_SENTINEL}`);
    } else throw new Error("stale-write sentinel leaked into a client dump");
    logLine(
      transcriptPath,
      `CONVERGED records=${serverDump.length} liveDigest=${liveDigest} coldDigest=${coldDigest} materializeDigest=${serverDigest}`,
    );
  } finally {
    if (live && live.child.exitCode === null && !live.child.killed) live.child.kill("SIGKILL");
    if (resumed && resumed.child.exitCode === null && !resumed.child.killed)
      resumed.child.kill("SIGKILL");
    if (server?.server)
      await new Promise((resolvePromise) => server.server.close(() => resolvePromise()));
    if (!recordMode) rmSync(runDir, { recursive: true, force: true });
  }
}

await main();
