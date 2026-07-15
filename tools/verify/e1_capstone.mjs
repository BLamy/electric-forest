import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDurableJson } from "../../packages/client/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  StreamFs,
  applyThreeWayMerge,
  planThreeWayMerge,
  resolveMergeConflict,
  treeDigest,
  unresolvedMergeConflicts,
} from "../../packages/streamfs/dist/src/index.js";
import { readJournalCheckpoint } from "./e1_capstone_journal.mjs";

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
const argumentValue = (name) =>
  arguments_.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const externalBaseUrl = argumentValue("base-url") ?? process.env.EFOREST_CAPSTONE_BASE_URL;
const repoName = argumentValue("repo-name") ?? "first-repository";
const endpointMode = externalBaseUrl === undefined ? "managed-local" : "external";
const authorization = process.env.EFOREST_CAPSTONE_AUTHORIZATION;
const sabotageArgument = arguments_.find((argument) => argument.startsWith("--sabotage="));
const sabotage = sabotageArgument?.slice("--sabotage=".length);
const sabotages = new Set([
  "app-auth-header",
  "evidence-drift",
  "event-mutation",
  "invalid-merge",
  "materialized-output",
  "restart-storage",
  "transport-closure",
  "watcher-auth-header",
  "watcher-order",
  "writer-race",
]);

if (
  arguments_.some(
    (argument) =>
      !["--update-evidence", "--keep"].includes(argument) &&
      !argument.startsWith("--sabotage=") &&
      !argument.startsWith("--base-url=") &&
      !argument.startsWith("--repo-name="),
  ) ||
  (sabotage !== undefined && !sabotages.has(sabotage)) ||
  (externalBaseUrl !== undefined && updateEvidence)
) {
  throw new Error(
    "usage: node tools/verify/e1_capstone.mjs [--base-url=<url>] [--repo-name=<name>] [--update-evidence] [--keep]",
  );
}

const scratch = mkdtempSync(join(tmpdir(), "eforest-e1-t11-"));
const runArtifacts = join(scratch, "artifacts");
mkdirSync(runArtifacts);
const transcript = [];
let tick = 1_800_000_000_000;
let configuredFetchRequestCount = 0;
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

function configuredFetch(input, init = {}) {
  configuredFetchRequestCount += 1;
  const headers = new Headers(init.headers);
  headers.set("X-Eforest-Capstone-Client", "application");
  if (sabotage === "app-auth-header") headers.delete("Authorization");
  else headers.set("Authorization", authorization);
  return fetch(input, { ...init, headers });
}

function transport(baseUrl) {
  return {
    baseUrl,
    ...(authorization === undefined ? {} : { fetch: configuredFetch }),
  };
}

function streamUrl(baseUrl, streamId) {
  return `${baseUrl.replace(/\/+$/, "")}/streams/${encodeURIComponent(streamId)}`;
}

function collectContentStreamIds(value, output = new Set()) {
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectContentStreamIds(item, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "contentStreamId" && typeof child === "string") output.add(child);
    collectContentStreamIds(child, output);
  }
  return output;
}

async function actualContentDump(repo, metadata) {
  const records = [];
  const streamIds = [...collectContentStreamIds(metadata)].sort();
  for (const streamId of streamIds) {
    const segment = await readDurableJson({
      url: streamUrl(repo.baseUrl, streamId),
      fetch: repo.fetcher,
    });
    assert.ok(segment.length > 0, `referenced content stream is empty: ${streamId}`);
    for (const record of segment) {
      assert.equal(record.type, "fs.file.content", `non-content record in ${streamId}`);
      assert.equal(
        record.payload.contentStreamId,
        streamId,
        `content provenance mismatch ${streamId}`,
      );
      records.push(stableRecord(record));
    }
  }
  return { records, streamIds };
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesBelow(directory) {
  const paths = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) paths.push(...filesBelow(path));
    else paths.push(path);
  }
  return paths;
}

function publishedPackageFiles(packageRoot) {
  return filesBelow(packageRoot).filter(
    (path) => !relative(packageRoot, path).split(/[\\/]/).includes("node_modules"),
  );
}

function transportProvenance() {
  const closure = [
    join(root, "Makefile"),
    join(root, "package.json"),
    join(root, "pnpm-lock.yaml"),
    join(root, "packages/protocol/package.json"),
    ...filesBelow(join(root, "packages/protocol/src")),
    join(root, "packages/client/package.json"),
    ...filesBelow(join(root, "packages/client/src")),
    join(root, "packages/server/package.json"),
    ...filesBelow(join(root, "packages/server/src")),
    join(root, "packages/streamfs/package.json"),
    ...filesBelow(join(root, "packages/streamfs/src")),
    join(root, "packages/cli/package.json"),
    ...filesBelow(join(root, "packages/cli/src")),
    join(root, "tools/verify/e1_capstone.mjs"),
    join(root, "tools/verify/e1_content_causality.mjs"),
    join(root, "tools/verify/e1_capstone_external.mjs"),
    join(root, "tools/verify/e1_capstone_journal.mjs"),
    join(root, "tools/verify/e1_capstone_journal_test.mjs"),
    join(root, "tools/verify/e1_capstone_sabotage.mjs"),
    join(root, "tools/verify/e1_capstone_watcher.mjs"),
  ].sort();
  const files = closure.map((path) => ({
    path: relative(root, path).split("\\").join("/"),
    sha256: digestBytes(readFileSync(path)),
  }));
  const serverSources = filesBelow(join(root, "packages/server/src"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const auditedServerSources =
    sabotage === "transport-closure"
      ? `${serverSources}\nimport { createServer } from "node:http";`
      : serverSources;
  assert.match(auditedServerSources, /from "@durable-streams\/server"/);
  assert.doesNotMatch(auditedServerSources, /node:http|createServer\(|express\(|fastify\(/);
  assert.match(
    readFileSync(join(root, "packages/client/src/durable.ts"), "utf8"),
    /from "@durable-streams\/client"/,
  );
  const installedPackages = [
    [
      "@durable-streams/client",
      realpathSync(join(root, "packages/client/node_modules/@durable-streams/client")),
    ],
    [
      "@durable-streams/server",
      realpathSync(join(root, "packages/server/node_modules/@durable-streams/server")),
    ],
  ].map(([name, packageRoot]) => ({
    files: publishedPackageFiles(packageRoot).map((path) => ({
      path: relative(packageRoot, path).split("\\").join("/"),
      sha256: digestBytes(readFileSync(path)),
    })),
    name,
    version: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
  }));
  return {
    applicationInjection: ["baseUrl", "fetch"],
    dependencyClosure: "pnpm-lock.yaml",
    files,
    installedPackageScope: "published package files excluding install-generated node_modules shims",
    installedPackages,
    publishedClient: "@durable-streams/client",
    publishedServer: "@durable-streams/server",
    scope:
      "E1-T11 evidence runtime: lockfile, application/protocol/materializer sources, verifier entrypoints, and installed published transport bytes",
  };
}

function stableTranscript() {
  return `${transcript
    .map((line) =>
      line
        .replaceAll(scratch, "<scratch>")
        .replace(/pid=\d+/g, "pid=<process>")
        .replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:<port>"),
    )
    .join("\n")}\n`;
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
    faultMarker: join(scratch, `${name}.fault-marker`),
    faultRelease: join(scratch, `${name}.fault-release`),
    faultRequest: join(scratch, `${name}.fault-request`),
    log: join(scratch, `${name}.jsonl`),
    ready: join(scratch, `${name}.ready.json`),
    result: join(scratch, `${name}.result.json`),
  };
}

function startWatcher(name, baseUrl, streamId, paths, options = {}) {
  rmSync(paths.ready, { force: true });
  rmSync(paths.result, { force: true });
  const watcherArguments = [
    watcherBin,
    `--base-url=${baseUrl}`,
    `--stream-id=${streamId}`,
    `--log=${paths.log}`,
    `--checkpoint=${paths.checkpoint}`,
    `--control=${paths.control}`,
    `--ready=${paths.ready}`,
    `--result=${paths.result}`,
  ];
  if (options.faultBoundary === true) {
    watcherArguments.push(
      `--fault-request=${paths.faultRequest}`,
      `--fault-marker=${paths.faultMarker}`,
      `--fault-release=${paths.faultRelease}`,
    );
  }
  const child = spawn(process.execPath, watcherArguments, {
    cwd: root,
    env: {
      ...processEnvironment(),
      EFOREST_CAPSTONE_OBSERVER_LABEL: `watcher-${name}`,
      ...(sabotage === "watcher-auth-header" ? { EFOREST_CAPSTONE_DROP_AUTHORIZATION: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  const raceRepoName = `${repoName}-race`;
  const setup = await new StreamFs(transport(baseUrl)).createRepo(raceRepoName);
  await setup.createFile("race.txt", new TextEncoder().encode("base"));
  const metadataUrl = `${baseUrl}/streams/${encodeURIComponent(setup.metadataStreamId)}`;
  const paused = deferred();
  const release = deferred();
  const loserFetch = async (input, init) => {
    if (requestMethod(input, init) === "POST" && requestUrl(input) === metadataUrl) {
      paused.resolve();
      await release.promise;
      if (sabotage === "writer-race") {
        const headers = new Headers(init?.headers);
        headers.delete("Stream-Seq");
        return (authorization === undefined ? fetch : configuredFetch)(input, { ...init, headers });
      }
    }
    return (authorization === undefined ? fetch : configuredFetch)(input, init);
  };
  const loser = await new StreamFs({ baseUrl, fetch: loserFetch }).openRepo(raceRepoName);
  const winner = await new StreamFs(transport(baseUrl)).openRepo(raceRepoName);
  const losingWrite = loser.writeFile("race.txt", new TextEncoder().encode("A"), {
    forceFull: true,
  });
  await paused.promise;
  await winner.writeFile("race.txt", new TextEncoder().encode("B"), { forceFull: true });
  release.resolve();
  await assert.rejects(losingWrite, (error) => error?.body?.error?.reason === "stale-base");
  const fresh = await new StreamFs(transport(baseUrl)).openRepo(raceRepoName);
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
  let activeBaseUrl;
  if (externalBaseUrl === undefined) {
    server = await startServer(stateDir, "initial");
    activeBaseUrl = server.baseUrl;
  } else {
    activeBaseUrl = externalBaseUrl;
    note(`external endpoint configured url=${activeBaseUrl}`);
  }

  const client = new StreamFs(transport(activeBaseUrl));
  let main = await client.createRepo(repoName);
  await main.mkdir("docs");
  await main.mkdir("src");
  const baseReadme = textLines("base");
  await main.createFile("docs/readme.md", encodeLines(baseReadme));
  await main.createFile("src/app.ts", new TextEncoder().encode("export const side = 'base';\n"));

  const pathsA = watcherPaths("watcher-a");
  const pathsB = watcherPaths("watcher-b");
  watcherA = startWatcher("A", activeBaseUrl, main.metadataStreamId, pathsA, {
    faultBoundary: true,
  });
  watcherB = startWatcher("B", activeBaseUrl, main.metadataStreamId, pathsB);
  const readyA = await waitWatcherReady(watcherA);
  const readyB = await waitWatcherReady(watcherB);
  assert.notEqual(readyA.pid, readyB.pid);
  assert.equal(readyA.authorizationConfigured, authorization !== undefined);
  assert.equal(readyB.authorizationConfigured, authorization !== undefined);
  if (authorization !== undefined) {
    assert.equal(readyA.configuredFetchExercised, true);
    assert.equal(readyB.configuredFetchExercised, true);
  }

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
  const checkpointBeforeCrash = readJournalCheckpoint(pathsA.checkpoint).offset;
  writeFileSync(pathsA.faultRequest, "pause-after-next-append\n", "utf8");
  await main.writeFile("docs/readme.md", encodeLines(targetReadme));
  const crashEventHead = (await main.rawDump()).at(-1).offset;
  await waitFor(
    () =>
      existsSync(pathsA.faultMarker) &&
      readFileSync(pathsA.faultMarker, "utf8").trim() === crashEventHead,
    "watcher append-before-checkpoint fault boundary",
  );
  assert.equal(readJournalCheckpoint(pathsA.checkpoint).offset, checkpointBeforeCrash);
  assert.equal(readJsonLines(pathsA.log).at(-1).offset, crashEventHead);
  const watcherAKilledPid = watcherA.child.pid;
  const killed = new Promise((resolveExit) => {
    watcherA.child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  watcherA.child.kill("SIGKILL");
  assert.deepEqual(await killed, { code: null, signal: "SIGKILL" });
  note(
    `A watcher pid=${watcherAKilledPid} killed after journal append=${crashEventHead} before checkpoint=${checkpointBeforeCrash}`,
  );

  const sourceReadme = [...baseReadme];
  sourceReadme[12] = "source-012";
  await feature.writeFile("docs/readme.md", encodeLines(sourceReadme));

  const unrelated = await client.createRepo(`${repoName}-unrelated-source`);
  const beforeInvalid = canonicalJson(await main.rawDump());
  let invalidMergeRejected = false;
  try {
    await planThreeWayMerge(main, unrelated);
  } catch (error) {
    if (error?.code !== "merge/unrelated-source") throw error;
    invalidMergeRejected = true;
  }
  if (sabotage === "invalid-merge") {
    await main.createFile("invalid-merge-leak.txt", new TextEncoder().encode("leaked\n"));
  }
  assert.equal(canonicalJson(await main.rawDump()), beforeInvalid);
  assert.equal(invalidMergeRejected, true);

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
  if (externalBaseUrl === undefined) {
    const restartPort = server.port;
    await stopServer(server, "initial");
    server = undefined;

    const emptyServer = await startServer(join(scratch, "wrong-state"), "wrong-storage");
    await assert.rejects(
      new StreamFs(transport(emptyServer.baseUrl)).openRepo(repoName),
      (error) => error?.code === "repo_not_found",
    );
    await stopServer(emptyServer, "wrong-storage");

    server = await startServer(
      sabotage === "restart-storage" ? join(scratch, "wrong-state") : stateDir,
      "restarted",
      restartPort,
    );
    activeBaseUrl = server.baseUrl;
  }
  main = await new StreamFs(transport(activeBaseUrl)).openRepo(repoName);
  feature = await main.openBranch("feature");
  assert.equal(await main.digest(), digestBeforeRestart);
  assert.equal(treeDigest((await main.bootstrapRead()).state), digestBeforeRestart);
  assert.notEqual(await feature.digest(), await main.digest());

  watcherA = startWatcher("A-resumed", activeBaseUrl, main.metadataStreamId, pathsA);
  const resumedReady = await waitWatcherReady(watcherA);
  assert.equal(resumedReady.startedFrom, checkpointBeforeCrash);
  assert.ok(resumedReady.checkpoint >= crashEventHead);
  assert.equal(resumedReady.recoveredTailEvents, 1);
  assert.notEqual(resumedReady.pid, watcherAKilledPid);
  assert.equal(resumedReady.authorizationConfigured, authorization !== undefined);
  if (authorization !== undefined) assert.equal(resumedReady.configuredFetchExercised, true);

  await main.createFile(
    "post-restart.txt",
    new TextEncoder().encode("persisted through the official file store\n"),
  );
  const race = await runRaceProbe(activeBaseUrl);
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
  assert.equal(resultA.authorizationConfigured, authorization !== undefined);
  assert.equal(resultB.authorizationConfigured, authorization !== undefined);
  if (authorization !== undefined) {
    assert.equal(resultA.configuredFetchExercised, true);
    assert.equal(resultB.configuredFetchExercised, true);
  }
  if (sabotage === "watcher-order") {
    const records = readJsonLines(pathsB.log);
    [records[1], records[2]] = [records[2], records[1]];
    writeJsonLines(pathsB.log, records);
  }
  assert.equal(readFileSync(pathsA.log, "utf8"), readFileSync(pathsB.log, "utf8"));
  const authoritativeRaw = `${finalRaw.map((record) => canonicalJson(record)).join("\n")}\n`;
  assert.equal(readFileSync(pathsA.log, "utf8"), authoritativeRaw);

  const clientA = await new StreamFs(transport(activeBaseUrl)).openRepo(repoName);
  const clientB = await new StreamFs(transport(activeBaseUrl)).openRepo(repoName);
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

  const contentExport = await actualContentDump(main, resolvedDump);
  const contentPath = join(runArtifacts, "content-streams.jsonl");
  writeJsonLines(contentPath, contentExport.records);
  const materializedDir = join(scratch, "materialized");
  const materialize = runEf([
    "materialize",
    resolvedPath,
    "--content",
    contentPath,
    "--out",
    materializedDir,
  ]);
  assert.equal(materialize.status, 0, `${materialize.stdout}${materialize.stderr}`);
  assert.equal(materialize.stderr, "");
  assert.equal(materialize.stdout.trim(), finalDigest);
  assert.equal(
    readFileSync(join(materializedDir, "post-restart.txt"), "utf8"),
    "persisted through the official file store\n",
  );
  assert.equal(
    readFileSync(join(materializedDir, "src/app.ts"), "utf8"),
    "export const side = 'feature';\n",
  );

  const mutated = readJsonLines(contentPath);
  const mutationStreamId = (await main.tree()).files["post-restart.txt"].contentStreamId;
  const mutationIndex = mutated.findLastIndex(
    (record) =>
      record.type === "fs.file.content" && record.payload.contentStreamId === mutationStreamId,
  );
  assert.ok(mutationIndex >= 0);
  const originalBytes = Buffer.from(mutated[mutationIndex].payload.contentBase64, "base64");
  if (sabotage !== "event-mutation") {
    originalBytes[0] ^= 1;
    mutated[mutationIndex] = {
      ...mutated[mutationIndex],
      payload: {
        ...mutated[mutationIndex].payload,
        contentBase64: originalBytes.toString("base64"),
      },
    };
  }
  const mutatedPath = join(scratch, "mutated-content.jsonl");
  writeJsonLines(mutatedPath, mutated);
  const mutatedOut = join(scratch, "mutated-out");
  const mutatedMaterialize = runEf([
    "materialize",
    resolvedPath,
    "--content",
    mutatedPath,
    "--out",
    mutatedOut,
  ]);
  assert.notEqual(mutatedMaterialize.status, 0);

  if (sabotage === "materialized-output") {
    writeFileSync(join(materializedDir, "src/app.ts"), "corrupted\n", "utf8");
  }
  const manifest = materializedManifest(materializedDir);
  assert.equal(manifest, await repoManifest(main));
  writeFileSync(join(runArtifacts, "materialized-manifest.txt"), manifest, "utf8");
  writeJsonLines(join(runArtifacts, "watcher.jsonl"), readJsonLines(pathsA.log).map(stableRecord));
  const summary = {
    actualContentEventCount: contentExport.records.length,
    actualContentStreamCount: contentExport.streamIds.length,
    applicationTransportConfiguration:
      authorization === undefined ? "injected-baseUrl" : "injected-baseUrl-and-fetch",
    authorizationConfigured: authorization !== undefined,
    branchIsolation: true,
    conflictPaths: ["docs/readme.md"],
    configuredFetchExercised: configuredFetchRequestCount > 0,
    eventCount: finalRaw.length,
    finalDigest,
    finalHead,
    endpointMode,
    externalEndpointConfigured: externalBaseUrl !== undefined,
    invalidMergeRejected: true,
    materializedDigest: materialize.stdout.trim(),
    mutationMaterializeRejected: true,
    processRestarted: externalBaseUrl === undefined,
    publishedServerOnly: true,
    race,
    replayDigest: replay.stdout.trim(),
    snapshotDigest: snapshot.stateDigest,
    watcherCrashWindowRecovered: true,
    watcherConfiguredFetchExercised:
      resultA.configuredFetchExercised && resultB.configuredFetchExercised,
    watcherDigests: [resultA.digest, resultB.digest],
    watcherEventCounts: [resultA.eventCount, resultB.eventCount],
    watcherRecoveredTailEvents: resultA.recoveredTailEvents,
    watcherPidsDistinct: true,
    wrongStorageRejected: externalBaseUrl === undefined,
  };
  writeFileSync(join(runArtifacts, "summary.json"), `${canonicalJson(summary)}\n`, "utf8");
  note(`final head=${finalHead} digest=${finalDigest} events=${finalRaw.length}`);
  note(`snapshot digest=${snapshot.stateDigest} offset=${snapshot.snapshotOffset}`);
  note(`watcher digests=${resultA.digest},${resultB.digest}`);
  note(`replay digest=${replay.stdout.trim()} materialize digest=${materialize.stdout.trim()}`);
  note(
    `actual content streams=${contentExport.streamIds.length} events=${contentExport.records.length}`,
  );
  note("mutated actual content materializeRejected=true");
  note(`race winner=${race.winner} loserRejected=${race.loserRejected}`);
  writeFileSync(join(runArtifacts, "transcript.txt"), stableTranscript(), "utf8");
  writeFileSync(
    join(runArtifacts, "transport-provenance.json"),
    `${canonicalJson(transportProvenance())}\n`,
    "utf8",
  );

  const stableFiles = [
    "content-streams.jsonl",
    "main-resolved.jsonl",
    "materialized-manifest.txt",
    "summary.json",
    "transcript.txt",
    "transport-provenance.json",
    "watcher.jsonl",
  ];
  const supportingFiles = [
    "content-causality.json",
    "external-endpoint-summary.json",
    "journal-contract.json",
    "sabotage-summary.json",
  ];
  for (const name of supportingFiles) {
    assert.ok(existsSync(join(committedEvidence, name)), `missing supporting evidence ${name}`);
  }
  const evidenceManifest = {
    artifacts: Object.fromEntries(
      stableFiles.map((name) => [name, digestBytes(readFileSync(join(runArtifacts, name)))]),
    ),
    contentStreamIds: contentExport.streamIds,
    metadata: {
      digest: finalDigest,
      eventCount: resolvedDump.length,
      streamId: main.metadataStreamId,
    },
    schema: 1,
    supportingArtifacts: Object.fromEntries(
      supportingFiles.map((name) => [
        name,
        digestBytes(readFileSync(join(committedEvidence, name))),
      ]),
    ),
  };
  writeFileSync(
    join(runArtifacts, "evidence-manifest.json"),
    `${canonicalJson(evidenceManifest)}\n`,
    "utf8",
  );
  stableFiles.push("evidence-manifest.json");
  if (updateEvidence) {
    mkdirSync(committedEvidence, { recursive: true });
    rmSync(join(committedEvidence, "portable-materialization.jsonl"), { force: true });
    for (const name of stableFiles) {
      cpSync(join(runArtifacts, name), join(committedEvidence, name));
    }
    note(`updated evidence ${committedEvidence}`);
  } else if (externalBaseUrl === undefined) {
    for (const name of stableFiles) {
      assert.ok(existsSync(join(committedEvidence, name)), `missing committed evidence ${name}`);
      const committed = readFileSync(join(committedEvidence, name), "utf8");
      assert.equal(
        readFileSync(join(runArtifacts, name), "utf8"),
        sabotage === "evidence-drift" && name === "transcript.txt"
          ? `TAMPERED\n${committed}`
          : committed,
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
