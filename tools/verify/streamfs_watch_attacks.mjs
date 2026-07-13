import { appendFile, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, sep, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import chokidar from "chokidar";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { createHttpServer, FileStreamStore } from "../../packages/server/dist/src/index.js";
import {
  createStreamFsServerOptions,
  fsEventsToWatchEvents,
  StreamFs,
} from "../../packages/streamfs/dist/src/index.js";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const evidenceRoot = join(
  repoRoot,
  ".eforest/tasks/epic-1-the-trunk/E1-T05-watch-chokidar/evidence",
);
const recordRun = process.argv.includes("--record");
const workerDir = mkdtempSync(join(tmpdir(), "eforest-e1-t05-attacks-"));

function artifactPath(name) {
  return recordRun ? join(evidenceRoot, name) : join(workerDir, `generated-${name}`);
}

function readJsonl(path) {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line));
}

function transcriptText(records) {
  return `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
}

function writeArtifact(name, content) {
  const path = artifactPath(name);
  writeFileSync(path, content);
  if (!recordRun) {
    const committed = readFileSync(join(evidenceRoot, name));
    if (committed.compare(Buffer.from(content)) !== 0)
      throw new Error(`attack evidence differs from committed report: ${name}`);
  }
}

async function waitFor(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function startServer(dataDir) {
  const server = createHttpServer(new FileStreamStore(dataDir), createStreamFsServerOptions());
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("attack verifier did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function eventSet(records) {
  return new Set(records.map(({ event, path }) => `${event}:${path}`));
}

function assertSameTranscript(left, right, description) {
  if (transcriptText(left) !== transcriptText(right))
    throw new Error(`${description} diverged from independent pure mapping`);
}

function longPollFetch(state) {
  return async (input, init) => {
    if (String(input).includes("live=long-poll") && state.failOnce) {
      state.failOnce = false;
      throw new Error("critic-owned long-poll reconnect");
    }
    return fetch(input, init);
  };
}

function sseCutFetch(state) {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input).includes("live=sse") || !state.cutOnce || response.body === null)
      return response;
    state.cutOnce = false;
    const reader = response.body.getReader();
    let firstChunk = true;
    const body = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
        if (firstChunk) {
          firstChunk = false;
          await reader.cancel();
          controller.close();
        }
      },
      cancel() {
        return reader.cancel();
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

async function differentialAttack(baseUrl) {
  const repo = await new StreamFs({ baseUrl }).createRepo("critic-differential");
  const longState = { failOnce: true };
  const sseState = { cutOnce: true };
  const longTranscript = [];
  const sseTranscript = [];
  const long = repo.watch(".", {
    mode: "long-poll",
    from: { offset: "-1" },
    reconnectDelayMs: 0,
    fetch: longPollFetch(longState),
  });
  const sse = repo.watch(".", {
    mode: "sse",
    from: { offset: "-1" },
    reconnectDelayMs: 0,
    fetch: sseCutFetch(sseState),
  });
  long.onBatch((records) => longTranscript.push(...records));
  sse.onBatch((records) => sseTranscript.push(...records));
  await Promise.all([long.ready, sse.ready]);
  const base = "A".repeat(500);
  await repo.mkdir("critic");
  await repo.mkdir("critic/sub");
  await repo.createFile("critic/a.txt", new TextEncoder().encode(base));
  await repo.writeFile("critic/a.txt", new TextEncoder().encode(`B${base.slice(1)}`));
  await repo.writeFile("critic/a.txt", new TextEncoder().encode(`BC${base.slice(2)}`));
  await repo.rename("critic/a.txt", "critic/b.txt");
  await repo.rename("critic", "moved");
  await repo.deleteFile("moved/b.txt");
  await repo.rmdir("moved/sub");
  await repo.rmdir("moved");
  const metadata = await repo.dump();
  const expected = fsEventsToWatchEvents(metadata).events;
  await waitFor(() => longTranscript.length === expected.length, "critic long-poll transcript");
  await waitFor(() => sseTranscript.length === expected.length, "critic SSE transcript");
  await Promise.all([long.close(), sse.close()]);
  assertSameTranscript(longTranscript, expected, "critic long-poll transcript");
  assertSameTranscript(sseTranscript, expected, "critic SSE transcript");
  if (longState.failOnce || sseState.cutOnce)
    throw new Error("critic-owned reconnect/socket interruption did not execute");
  return {
    seed: "critic-differential-20260713",
    events: expected.length,
    longPollReconnect: true,
    sseSocketInterruption: true,
    exactConvergence: true,
  };
}

async function chokidarAttack() {
  const root = mkdtempSync(join(tmpdir(), "eforest-chokidar-"));
  const watcher = chokidar.watch(root, { ignoreInitial: true });
  const events = [];
  watcher.on("all", (event, path) => {
    events.push({ event, path: relative(root, path).split(sep).join("/") });
  });
  await new Promise((resolvePromise, reject) => {
    watcher.once("ready", resolvePromise);
    watcher.once("error", reject);
  });
  const has = (event, path) => events.some((entry) => entry.event === event && entry.path === path);
  await mkdir(join(root, "dir"));
  await waitFor(() => has("addDir", "dir"), "chokidar addDir");
  await writeFile(join(root, "dir/a.txt"), "A");
  await waitFor(() => has("add", "dir/a.txt"), "chokidar add");
  await appendFile(join(root, "dir/a.txt"), "B");
  await waitFor(() => has("change", "dir/a.txt"), "chokidar change");
  await rename(join(root, "dir/a.txt"), join(root, "dir/b.txt"));
  await waitFor(
    () => has("unlink", "dir/a.txt") && has("add", "dir/b.txt"),
    "chokidar rename dialect",
  );
  await unlink(join(root, "dir/b.txt"));
  await waitFor(() => has("unlink", "dir/b.txt"), "chokidar unlink");
  await rm(join(root, "dir"), { recursive: true });
  await waitFor(() => has("unlinkDir", "dir"), "chokidar unlinkDir");
  await watcher.close();
  rmSync(root, { recursive: true, force: true });
  const expected = new Set([
    "addDir:dir",
    "add:dir/a.txt",
    "change:dir/a.txt",
    "unlink:dir/a.txt",
    "add:dir/b.txt",
    "unlink:dir/b.txt",
    "unlinkDir:dir",
  ]);
  const actual = new Set(events.map(({ event, path }) => `${event}:${path}`));
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`chokidar dialect mismatch: ${JSON.stringify([...actual].sort())}`);
  }
  return { expected: [...expected].sort(), actual: [...actual].sort(), exactKinds: true };
}

async function fuzzAttack(baseUrl) {
  const repo = await new StreamFs({ baseUrl }).createRepo("critic-fuzz");
  const transcript = [];
  const watcher = repo.watch(".", {
    mode: "long-poll",
    from: { offset: "-1" },
    reconnectDelayMs: 0,
  });
  watcher.onBatch((records) => transcript.push(...records));
  await watcher.ready;
  const encoder = new TextEncoder();
  const base = "Z".repeat(400);
  await repo.mkdir("fuzz");
  const refused = [];
  for (let index = 0; index < 4; index += 1) {
    const path = `fuzz/file-${index}.txt`;
    await repo.createFile(path, encoder.encode(base));
    await repo.writeFile(
      path,
      encoder.encode(`${String.fromCharCode(65 + index)}${base.slice(1)}`),
    );
    if (index % 2 === 0) {
      await repo.deleteFile(path);
      const before = await repo.dump();
      try {
        await repo.writeFile(path, encoder.encode("refused"));
      } catch {
        refused.push(path);
      }
      const after = await repo.dump();
      if (canonicalJson(before) !== canonicalJson(after))
        throw new Error(`refused write changed the log for ${path}`);
    } else {
      await repo.rename(path, `fuzz/renamed-${index}.txt`);
    }
  }
  const metadata = await repo.dump();
  const expected = fsEventsToWatchEvents(metadata).events;
  await waitFor(() => transcript.length === expected.length, "critic fuzz transcript");
  await watcher.close();
  assertSameTranscript(transcript, expected, "critic fuzz transcript");
  const patches = metadata.filter((record) => record.type === "fs.file.patch");
  for (const patch of patches) {
    const matches = transcript.filter((record) => record.offset === patch.offset);
    if (matches.length !== 1 || matches[0].event !== "change")
      throw new Error(`patch did not map to exactly one change at ${patch.offset}`);
  }
  return {
    seed: "critic-patch-refusal-20260713",
    patches: patches.length,
    refusedWrites: refused.length,
  };
}

function sabotageAttack() {
  const golden = readJsonl(join(evidenceRoot, "e1-t05-golden-transcript.jsonl"));
  const renameOffset = golden.find((entry) => entry.event === "unlinkDir")?.offset;
  const renameGroup = golden.filter((entry) => entry.offset === renameOffset);
  if (renameGroup.length < 2) throw new Error("sabotage fixture lacks a rename decomposition");
  const firstChange = golden.findIndex((entry) => entry.event === "change");
  const mutants = {
    dropOnResume: golden.slice(1),
    duplicateBoundary: [golden[0], ...golden],
    swapRenameOrder: golden.map((entry) => entry),
    patchAsAdd: golden.map((entry, index) =>
      index === firstChange ? { ...entry, event: "add" } : entry,
    ),
  };
  const start = golden.findIndex((entry) => entry.offset === renameOffset);
  mutants.swapRenameOrder.splice(start, renameGroup.length, ...renameGroup.reverse());
  const red = Object.fromEntries(
    Object.entries(mutants).map(([name, mutant]) => [
      name,
      transcriptText(mutant) !== transcriptText(golden),
    ]),
  );
  if (Object.values(red).some((value) => !value))
    throw new Error(`sabotage stayed green: ${JSON.stringify(red)}`);
  return { mutations: red, allExpectedFail: true };
}

const dataDir = mkdtempSync(join(tmpdir(), "eforest-e1-t05-attacks-data-"));
const { server, baseUrl } = await startServer(dataDir);
try {
  const report = {
    differential: await differentialAttack(baseUrl),
    chokidar: await chokidarAttack(),
    fuzz: await fuzzAttack(baseUrl),
    sabotage: sabotageAttack(),
  };
  writeArtifact("e1-t05-attacks.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workerDir, { recursive: true, force: true });
}
