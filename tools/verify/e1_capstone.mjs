import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  BASE_NONE,
  StreamFs,
  applyThreeWayMerge,
  planThreeWayMerge,
  resolveMergeConflict,
  treeDigest,
  unresolvedMergeConflicts,
} from "../../packages/streamfs/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverBin = join(root, "packages/server/dist/src/bin.js");
const efBin = join(root, "packages/cli/dist/src/bin.js");
const watcherBin = join(root, "tools/verify/e1_capstone_watcher.mjs");
const serverUpstream = join(root, "packages/server/src/upstream.ts");
const committedEvidence = join(
  root,
  ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence",
);
const arguments_ = process.argv.slice(2);
const args = new Set(arguments_);
const updateEvidence = args.has("--update-evidence");
const keep = args.has("--keep") || process.env.EFOREST_CAPSTONE_KEEP === "1";
const sabotageArgument = arguments_.find((argument) => argument.startsWith("--sabotage="));
const sabotage = sabotageArgument?.slice("--sabotage=".length);
const sabotages = new Set([
  "event-mutation",
  "invalid-merge",
  "restart-storage",
  "watcher-resume",
  "writer-race",
]);

if (
  arguments_.some(
    (argument) =>
      !["--update-evidence", "--keep"].includes(argument) && !argument.startsWith("--sabotage="),
  ) ||
  (sabotage !== undefined && !sabotages.has(sabotage))
) {
  throw new Error("usage: node tools/verify/e1_capstone.mjs [--update-evidence] [--keep]");
}

const scratch = mkdtempSync(join(tmpdir(), "eforest-e1-t11-"));
const runArtifacts = join(scratch, "artifacts");
mkdirSync(runArtifacts);
const transcript = [];
let tick = 1_800_000_000_000;
Date.now = () => tick++;

function note(message) {
  transcript.push(message);
  process.stderr.write(`${message}\n`);
}

function processEnvironment() {
  const env = { ...process.env };
  for (const key of ["PORT", "EF_STORE", "EF_DATA_DIR", "NODE_OPTIONS", "NODE_ENV"]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_config_")) delete env[key];
  }
  return env;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, description, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path) {
  const text = readFileSync(path, "utf8").trimEnd();
  return text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line));
}

function writeJsonLines(path, records) {
  writeFileSync(path, `${records.map((record) => canonicalJson(record)).join("\n")}\n`, "utf8");
}

function stableRecord(record) {
  return { ...record, ts: 0 };
}

function portableOffset(ordinal) {
  return `0000000000000000_${String(ordinal).padStart(16, "0")}`;
}

async function portableTreeDump(repo) {
  const tree = await repo.tree();
  const records = [];
  let ordinal = 0;
  const append = (type, payload) => {
    records.push({ offset: portableOffset(ordinal), payload, ts: 0, type });
    ordinal += 1;
  };
  for (const path of Object.keys(tree.dirs).sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  )) {
    append("fs.dir.create", { path, v: 2 });
  }
  for (const path of Object.keys(tree.files).sort()) {
    const file = tree.files[path];
    const content = await repo.readFile(path);
    append("fs.file.content", {
      contentBase64: Buffer.from(content).toString("base64"),
      contentStreamId: file.contentStreamId,
      v: 2,
    });
    append("fs.file.create", {
      contentStreamId: file.contentStreamId,
      path,
      v: 2,
    });
    append("fs.file.write", {
      base: BASE_NONE,
      contentSha256: file.contentSha256,
      path,
      size: file.size,
      v: 2,
    });
  }
  return records;
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestMethod(input, init) {
  if (init?.method !== undefined) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : "GET";
}

function requestUrl(input) {
  return input instanceof Request ? input.url : String(input);
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function startServer(dataDir, label, port = 0) {
  const child = spawn(
    process.execPath,
    [serverBin, `--port=${port}`, "--store=file", `--data-dir=${dataDir}`],
    { cwd: root, env: processEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const baseUrl = await waitFor(() => {
    const match = /LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
    if (match !== null) return match[1];
    if (child.exitCode !== null) {
      throw new Error(`${label} server exited ${child.exitCode}: ${stderr}`);
    }
    return undefined;
  }, `${label} server LISTENING`);
  note(`${label} server pid=${child.pid} url=${baseUrl} dataDir=${dataDir}`);
  return { baseUrl, child, port: Number(new URL(baseUrl).port), stderr: () => stderr };
}

async function stopServer(server, label) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => {
    server.child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  server.child.kill("SIGTERM");
  const result = await exited;
  assert.deepEqual(result, { code: 0, signal: null }, `${label} server shutdown`);
  assert.equal(server.stderr(), "", `${label} server stderr`);
  note(`${label} server stopped cleanly`);
}

function watcherPaths(name) {
  return {
    checkpoint: join(scratch, `${name}.checkpoint`),
    control: join(scratch, `${name}.control`),
    log: join(scratch, `${name}.jsonl`),
    ready: join(scratch, `${name}.ready.json`),
    result: join(scratch, `${name}.result.json`),
  };
}

function startWatcher(name, baseUrl, streamId, paths) {
  rmSync(paths.ready, { force: true });
  rmSync(paths.result, { force: true });
  const child = spawn(
    process.execPath,
    [
      watcherBin,
      `--base-url=${baseUrl}`,
      `--stream-id=${streamId}`,
      `--log=${paths.log}`,
      `--checkpoint=${paths.checkpoint}`,
      `--control=${paths.control}`,
      `--ready=${paths.ready}`,
      `--result=${paths.result}`,
    ],
    { cwd: root, env: processEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  note(`${name} watcher pid=${child.pid}`);
  return { child, paths, stderr: () => stderr, stdout: () => stdout };
}

async function waitWatcherReady(watcher) {
  return waitFor(() => {
    if (watcher.child.exitCode !== null) {
      throw new Error(`watcher exited before ready: ${watcher.stderr()}`);
    }
    return existsSync(watcher.paths.ready) ? readJson(watcher.paths.ready) : undefined;
  }, `${watcher.paths.ready} ready`);
}

async function waitCheckpoint(path, expected) {
  await waitFor(
    () => existsSync(path) && readFileSync(path, "utf8").trim() === expected,
    `checkpoint ${expected}`,
  );
}

async function waitWatcherResult(watcher) {
  const exit = new Promise((resolveExit) => {
    watcher.child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const result = await waitFor(
    () => (existsSync(watcher.paths.result) ? readJson(watcher.paths.result) : undefined),
    `${watcher.paths.result} result`,
  );
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.equal(watcher.stderr(), "");
  return result;
}

function runEf(arguments_) {
  const result = spawnSync(process.execPath, [efBin, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: processEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function textLines(prefix) {
  return Array.from({ length: 128 }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`);
}

function encodeLines(lines) {
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

async function runRaceProbe(baseUrl) {
  const setup = await new StreamFs({ baseUrl }).createRepo("first-repository-race");
  await setup.createFile("race.txt", new TextEncoder().encode("base"));
  const metadataUrl = `${baseUrl}/streams/${encodeURIComponent(setup.metadataStreamId)}`;
  const paused = deferred();
  const release = deferred();
  const loserFetch = async (input, init) => {
    if (requestMethod(input, init) === "POST" && requestUrl(input) === metadataUrl) {
      paused.resolve();
      await release.promise;
    }
    return fetch(input, init);
  };
  const loser = await new StreamFs({ baseUrl, fetch: loserFetch }).openRepo(
    "first-repository-race",
  );
  const winner = await new StreamFs({ baseUrl }).openRepo("first-repository-race");
  const losingWrite = loser.writeFile("race.txt", new TextEncoder().encode("A"), {
    forceFull: true,
  });
  await paused.promise;
  if (sabotage === "writer-race") {
    release.resolve();
  } else {
    await winner.writeFile("race.txt", new TextEncoder().encode("B"), { forceFull: true });
    release.resolve();
  }
  await assert.rejects(losingWrite, (error) => error?.body?.error?.reason === "stale-base");
  const fresh = await new StreamFs({ baseUrl }).openRepo("first-repository-race");
  assert.equal(new TextDecoder().decode(await fresh.readFile("race.txt")), "B");
  return { loserRejected: true, winner: "B" };
}

function materializedManifest(directory) {
  const entries = [];
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const relativePath = relative(directory, absolute).split("\\").join("/");
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        entries.push(`D ${relativePath}`);
        visit(absolute);
      } else {
        const bytes = readFileSync(absolute);
        entries.push(`F ${relativePath} ${digestBytes(bytes)} ${bytes.byteLength}`);
      }
    }
  }
  visit(directory);
  return `${entries.join("\n")}\n`;
}

async function repoManifest(repo) {
  const tree = await repo.tree();
  const entries = [];
  for (const path of Object.keys(tree.dirs).sort()) entries.push(`D ${path}`);
  for (const path of Object.keys(tree.files).sort()) {
    const bytes = await repo.readFile(path);
    entries.push(`F ${path} ${digestBytes(bytes)} ${bytes.byteLength}`);
  }
  entries.sort(
    (left, right) => left.slice(2).localeCompare(right.slice(2)) || left.localeCompare(right),
  );
  return `${entries.join("\n")}\n`;
}

let server;
let watcherA;
let watcherB;
try {
  assert.ok(existsSync(serverBin), "build @eforest/server before the capstone");
  assert.ok(existsSync(efBin), "build @eforest/cli before the capstone");
  const upstreamSource = readFileSync(serverUpstream, "utf8");
  assert.match(
    upstreamSource,
    /from "@durable-streams\/server"/,
    "the local server boundary must wrap the published Durable Streams server",
  );
  assert.doesNotMatch(
    upstreamSource,
    /node:http|createServer\(|express\(|fastify\(/,
    "the local boundary must not implement a second Durable Streams transport",
  );
  const stateDir = join(scratch, "state");
  server = await startServer(stateDir, "initial");

  const client = new StreamFs({ baseUrl: server.baseUrl });
  let main = await client.createRepo("first-repository");
  await main.mkdir("docs");
  await main.mkdir("src");
  const baseReadme = textLines("base");
  await main.createFile("docs/readme.md", encodeLines(baseReadme));
  await main.createFile("src/app.ts", new TextEncoder().encode("export const side = 'base';\n"));

  const pathsA = watcherPaths("watcher-a");
  const pathsB = watcherPaths("watcher-b");
  watcherA = startWatcher("A", server.baseUrl, main.metadataStreamId, pathsA);
  watcherB = startWatcher("B", server.baseUrl, main.metadataStreamId, pathsB);
  const readyA = await waitWatcherReady(watcherA);
  const readyB = await waitWatcherReady(watcherB);
  assert.notEqual(readyA.pid, readyB.pid);

  await main.createBranch("feature");
  let feature = await main.openBranch("feature");
  await feature.writeFile(
    "src/app.ts",
    new TextEncoder().encode("export const side = 'feature';\n"),
  );
  await feature.createFile(
    "src/feature.ts",
    new TextEncoder().encode("export const feature = 1;\n"),
  );
  assert.equal(
    new TextDecoder().decode(await main.readFile("src/app.ts")),
    "export const side = 'base';\n",
  );
  await assert.rejects(
    main.readFile("src/feature.ts"),
    (error) => error?.code === "file_not_found",
  );

  const targetReadme = [...baseReadme];
  targetReadme[12] = "target-012";
  await main.writeFile("docs/readme.md", encodeLines(targetReadme));
  const prefixHead = (await main.rawDump()).at(-1).offset;
  await waitCheckpoint(pathsA.checkpoint, prefixHead);
  const watcherAKilledPid = watcherA.child.pid;
  const killed = new Promise((resolveExit) => {
    watcherA.child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  watcherA.child.kill("SIGKILL");
  assert.deepEqual(await killed, { code: null, signal: "SIGKILL" });
  note(`A watcher pid=${watcherAKilledPid} killed at checkpoint=${prefixHead}`);
  if (sabotage === "watcher-resume") rmSync(pathsA.checkpoint);

  const sourceReadme = [...baseReadme];
  sourceReadme[12] = "source-012";
  await feature.writeFile("docs/readme.md", encodeLines(sourceReadme));

  const unrelated = await client.createRepo("unrelated-source");
  const beforeInvalid = canonicalJson(await main.rawDump());
  await assert.rejects(
    planThreeWayMerge(main, sabotage === "invalid-merge" ? feature : unrelated),
    (error) => error?.code === "merge/unrelated-source",
  );
  assert.equal(canonicalJson(await main.rawDump()), beforeInvalid);

  const plan = await planThreeWayMerge(main, feature);
  assert.deepEqual(
    plan.conflicts.map(({ path }) => path),
    ["docs/readme.md"],
  );
  assert.ok(plan.changes.some((change) => change.payload.path === "src/app.ts"));
  assert.ok(plan.changes.some((change) => change.payload.path === "src/feature.ts"));
  const mergeReceipt = await applyThreeWayMerge(main, feature, plan);
  assert.equal(await main.digest(), mergeReceipt.resultTreeDigest);
  assert.equal(
    new TextDecoder().decode(await main.readFile("docs/readme.md")),
    new TextDecoder().decode(encodeLines(targetReadme)),
  );
  assert.equal(
    new TextDecoder().decode(await main.readFile("src/app.ts")),
    "export const side = 'feature';\n",
  );
  assert.equal(unresolvedMergeConflicts(await main.tree()).length, 1);
  const conflict = unresolvedMergeConflicts(await main.tree())[0];
  await resolveMergeConflict(main, conflict.mergeId, conflict.path);
  assert.deepEqual(unresolvedMergeConflicts(await main.tree()), []);

  const snapshot = await main.createSnapshot();
  assert.equal(snapshot.stateDigest, await main.digest());
  assert.equal(treeDigest((await main.bootstrapRead()).state), await main.digest());
  const digestBeforeRestart = await main.digest();
  const restartPort = server.port;
  await stopServer(server, "initial");
  server = undefined;

  const emptyServer = await startServer(join(scratch, "wrong-state"), "wrong-storage");
  await assert.rejects(
    new StreamFs({ baseUrl: emptyServer.baseUrl }).openRepo("first-repository"),
    (error) => error?.code === "repo_not_found",
  );
  await stopServer(emptyServer, "wrong-storage");

  server = await startServer(
    sabotage === "restart-storage" ? join(scratch, "wrong-state") : stateDir,
    "restarted",
    restartPort,
  );
  main = await new StreamFs({ baseUrl: server.baseUrl }).openRepo("first-repository");
  feature = await main.openBranch("feature");
  assert.equal(await main.digest(), digestBeforeRestart);
  assert.equal(treeDigest((await main.bootstrapRead()).state), digestBeforeRestart);
  assert.notEqual(await feature.digest(), await main.digest());

  watcherA = startWatcher("A-resumed", server.baseUrl, main.metadataStreamId, pathsA);
  const resumedReady = await waitWatcherReady(watcherA);
  assert.equal(resumedReady.startedFrom, prefixHead);
  assert.ok(resumedReady.checkpoint >= prefixHead);
  assert.notEqual(resumedReady.pid, watcherAKilledPid);

  await main.createFile(
    "post-restart.txt",
    new TextEncoder().encode("persisted through the official file store\n"),
  );
  const race = await runRaceProbe(server.baseUrl);
  const finalDigest = await main.digest();
  const finalRaw = await main.rawDump();
  const finalHead = finalRaw.at(-1).offset;
  writeFileSync(pathsA.control, `${finalHead}\n`, "utf8");
  writeFileSync(pathsB.control, `${finalHead}\n`, "utf8");
  const [resultA, resultB] = await Promise.all([
    waitWatcherResult(watcherA),
    waitWatcherResult(watcherB),
  ]);
  watcherA = undefined;
  watcherB = undefined;
  assert.equal(resultA.digest, finalDigest);
  assert.equal(resultB.digest, finalDigest);
  assert.equal(resultA.checkpoint, finalHead);
  assert.equal(resultB.checkpoint, finalHead);
  assert.equal(readFileSync(pathsA.log, "utf8"), readFileSync(pathsB.log, "utf8"));
  const authoritativeRaw = `${finalRaw.map((record) => canonicalJson(record)).join("\n")}\n`;
  assert.equal(readFileSync(pathsA.log, "utf8"), authoritativeRaw);

  const clientA = await new StreamFs({ baseUrl: server.baseUrl }).openRepo("first-repository");
  const clientB = await new StreamFs({ baseUrl: server.baseUrl }).openRepo("first-repository");
  assert.equal(await clientA.digest(), finalDigest);
  assert.equal(await clientB.digest(), finalDigest);
  assert.equal(canonicalJson(await clientA.rawDump()), canonicalJson(await clientB.rawDump()));

  const resolvedDump = await main.resolvedDump();
  const resolvedPath = join(runArtifacts, "main-resolved.jsonl");
  writeJsonLines(resolvedPath, resolvedDump.map(stableRecord));
  const replay = runEf(["replay", resolvedPath, "--digest"]);
  assert.equal(replay.status, 0, `${replay.stdout}${replay.stderr}`);
  assert.equal(replay.stderr, "");
  assert.equal(replay.stdout.trim(), finalDigest);

  const portablePath = join(runArtifacts, "portable-materialization.jsonl");
  writeJsonLines(portablePath, await portableTreeDump(main));
  const materializedDir = join(scratch, "materialized");
  const materialize = runEf(["materialize", portablePath, "--out", materializedDir]);
  assert.equal(materialize.status, 0, `${materialize.stdout}${materialize.stderr}`);
  assert.equal(materialize.stderr, "");
  assert.equal(
    readFileSync(join(materializedDir, "post-restart.txt"), "utf8"),
    "persisted through the official file store\n",
  );
  assert.equal(
    readFileSync(join(materializedDir, "src/app.ts"), "utf8"),
    "export const side = 'feature';\n",
  );

  const mutated = readJsonLines(portablePath);
  const mutationIndex = mutated.findLastIndex((record) => record.type === "fs.file.write");
  assert.ok(mutationIndex >= 0);
  const originalDigest = mutated[mutationIndex].payload.contentSha256;
  if (sabotage !== "event-mutation") {
    mutated[mutationIndex] = {
      ...mutated[mutationIndex],
      payload: {
        ...mutated[mutationIndex].payload,
        contentSha256: `${originalDigest.slice(0, -1)}${originalDigest.endsWith("0") ? "1" : "0"}`,
      },
    };
  }
  const mutatedPath = join(scratch, "mutated.jsonl");
  writeJsonLines(mutatedPath, mutated);
  const mutatedReplay = runEf(["replay", mutatedPath, "--digest"]);
  assert.equal(mutatedReplay.status, 0);
  assert.notEqual(mutatedReplay.stdout.trim(), finalDigest);
  const mutatedOut = join(scratch, "mutated-out");
  const mutatedMaterialize = runEf(["materialize", mutatedPath, "--out", mutatedOut]);
  assert.notEqual(mutatedMaterialize.status, 0);

  const manifest = materializedManifest(materializedDir);
  assert.equal(manifest, await repoManifest(main));
  writeFileSync(join(runArtifacts, "materialized-manifest.txt"), manifest, "utf8");
  writeJsonLines(join(runArtifacts, "watcher.jsonl"), readJsonLines(pathsA.log).map(stableRecord));
  const summary = {
    applicationTransportConfiguration: "baseUrl-only",
    branchIsolation: true,
    conflictPaths: ["docs/readme.md"],
    eventCount: finalRaw.length,
    finalDigest,
    finalHead,
    invalidMergeRejected: true,
    materializedDigest: materialize.stdout.trim(),
    mutationDigest: mutatedReplay.stdout.trim(),
    mutationMaterializeRejected: true,
    processRestarted: true,
    publishedServerOnly: true,
    race,
    replayDigest: replay.stdout.trim(),
    snapshotDigest: snapshot.stateDigest,
    watcherAKilledAndResumed: true,
    watcherDigests: [resultA.digest, resultB.digest],
    watcherEventCounts: [resultA.eventCount, resultB.eventCount],
    watcherPidsDistinct: true,
    wrongStorageRejected: true,
  };
  writeFileSync(join(runArtifacts, "summary.json"), `${canonicalJson(summary)}\n`, "utf8");
  note(`final head=${finalHead} digest=${finalDigest} events=${finalRaw.length}`);
  note(`snapshot digest=${snapshot.stateDigest} offset=${snapshot.snapshotOffset}`);
  note(`watcher digests=${resultA.digest},${resultB.digest}`);
  note(`replay digest=${replay.stdout.trim()} materialize digest=${materialize.stdout.trim()}`);
  note(`mutation digest=${mutatedReplay.stdout.trim()} materializeRejected=true`);
  note(`race winner=${race.winner} loserRejected=${race.loserRejected}`);
  writeFileSync(join(runArtifacts, "transcript.txt"), `${transcript.join("\n")}\n`, "utf8");

  const stableFiles = [
    "main-resolved.jsonl",
    "materialized-manifest.txt",
    "portable-materialization.jsonl",
    "summary.json",
    "watcher.jsonl",
  ];
  if (updateEvidence) {
    mkdirSync(committedEvidence, { recursive: true });
    for (const name of [...stableFiles, "transcript.txt"]) {
      cpSync(join(runArtifacts, name), join(committedEvidence, name));
    }
    note(`updated evidence ${committedEvidence}`);
  } else {
    for (const name of stableFiles) {
      assert.ok(existsSync(join(committedEvidence, name)), `missing committed evidence ${name}`);
      assert.equal(
        readFileSync(join(runArtifacts, name), "utf8"),
        readFileSync(join(committedEvidence, name), "utf8"),
        `fresh capstone evidence drifted: ${name}`,
      );
    }
  }
  process.stdout.write(`${canonicalJson(summary)}\n`);
} finally {
  if (watcherA?.child !== undefined && watcherA.child.exitCode === null) watcherA.child.kill();
  if (watcherB?.child !== undefined && watcherB.child.exitCode === null) watcherB.child.kill();
  if (server !== undefined) await stopServer(server, "final");
  if (keep) note(`kept scratch ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}
