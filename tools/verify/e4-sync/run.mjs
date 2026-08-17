#!/usr/bin/env node
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const cli = join(root, "packages/cli/dist/src/bin.js");
const serverBin = join(root, "packages/server/dist/src/bin.js");
const outArg = process.argv.indexOf("--out");
const branchArg = process.argv.indexOf("--branch-dump");
const topologyArg = process.argv.indexOf("--topology");
const seedArg = process.argv.indexOf("--seed");
const modeArg = process.argv.indexOf("--mode");
const mutateArg = process.argv.indexOf("--mutate");
const seed = Number(seedArg >= 0 ? process.argv[seedArg + 1] : "1");
const mode = modeArg >= 0 ? process.argv[modeArg + 1] : "lockstep";
const mutationPath = mutateArg >= 0 ? process.argv[mutateArg + 1] : undefined;
const output = outArg >= 0 ? resolve(process.argv[outArg + 1] ?? "transcript.txt") : undefined;
const branchOutput =
  branchArg >= 0 ? resolve(process.argv[branchArg + 1] ?? "branch.jsonl") : undefined;
const topologyOutput =
  topologyArg >= 0 ? resolve(process.argv[topologyArg + 1] ?? "topology.json") : undefined;
if (
  !Number.isSafeInteger(seed) ||
  seed < 0 ||
  (mode !== "lockstep" && mode !== "free") ||
  (branchArg >= 0 && branchOutput === undefined) ||
  (topologyArg >= 0 && topologyOutput === undefined) ||
  (mutateArg >= 0 && (mutationPath === undefined || mutationPath.includes("..")))
) {
  console.error(
    "usage: run.mjs --seed <non-negative integer> [--mode lockstep|free] [--out path] [--branch-dump path] [--topology path] [--mutate relative-file]",
  );
  process.exit(2);
}

const importDist = async (relativePath) => import(pathToFileURL(join(root, relativePath)).href);
const [
  { expandSchedule, canonicalTranscript, compareWorktrees, expectedMutationCount },
  { canonicalJson },
  client,
  streamfs,
  worktreeNode,
  platform,
  identity,
  workspace,
] = await Promise.all([
  importDist("packages/sync-harness/dist/src/index.js"),
  importDist("packages/protocol/dist/src/index.js"),
  importDist("packages/client/dist/src/index.js"),
  importDist("packages/streamfs/dist/src/index.js"),
  importDist("packages/streamfs/dist/src/worktree-node.js"),
  importDist("packages/platform/dist/src/index.js"),
  importDist("packages/identity/dist/src/index.js"),
  importDist("packages/workspace/dist/src/index.js"),
]);

const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t09-"));
const home = join(scratch, "ef-home");
const cloneHome = join(scratch, "clone-home");
const machineA = join(scratch, "machine-a");
const machineB = join(scratch, "machine-b");
mkdirSync(home, { recursive: true });
mkdirSync(cloneHome, { recursive: true });
mkdirSync(machineA, { recursive: true });
mkdirSync(machineB, { recursive: true });
const children = new Set();
const watcherPids = new Map();
let streamChild;
let platformServer;
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  for (const pid of watcherPids.values()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The watcher already exited.
    }
  }
  streamChild?.kill("SIGKILL");
});

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function startStreamServer() {
  const child = spawnTracked(process.execPath, [serverBin, "--port", "0"], { cwd: root });
  let outputText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (outputText += chunk));
  const deadline = Date.now() + 15_000;
  while (!outputText.includes("LISTENING ")) {
    if (child.exitCode !== null) throw new Error(`stream server exited: ${outputText}`);
    if (Date.now() > deadline) throw new Error("stream server did not become ready");
    await new Promise((done) => setTimeout(done, 25));
  }
  streamChild = child;
  return { child, url: outputText.match(/LISTENING (\S+)/)?.[1] };
}

function credentials(token) {
  return (
    JSON.stringify({
      accessToken: token,
      tokenType: "Bearer",
      issuer: "https://local.e4-t09",
      clientId: "e4-t09",
      scopes: ["repo:read", "repo:write"],
    }) + "\n"
  );
}

function writeCredentials(token) {
  writeFileSync(join(home, "credentials.json"), credentials(token), { mode: 0o600 });
}

function cloneWorkspace(target, token, serverUrl, streamUrl) {
  execFileSync(
    process.execPath,
    [cli, "clone", "e4/convergence", "main", target, "--server", streamUrl],
    {
      cwd: root,
      env: {
        ...process.env,
        EF_HOME: cloneHome,
        EF_SERVER_URL: streamUrl,
        EF_STREAM_SERVER_URL: streamUrl,
      },
      encoding: "utf8",
      maxBuffer: 2 ** 20,
    },
  );
}

async function startWatcher(target, token, writerId, streamUrl, platformUrl) {
  writeCredentials(token);
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawnTracked(process.execPath, [cli, "watch", "start", "--dir", target], {
      cwd: target,
      env: {
        ...process.env,
        EF_HOME: home,
        EF_SERVER_URL: platformUrl,
        EF_STREAM_SERVER_URL: streamUrl,
        EF_WRITER_ID: writerId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", rejectResult);
    child.once("exit", (code) =>
      code === 0
        ? resolveResult({ pid: Number(readFileSync(join(target, ".ef/watch.pid"), "utf8")) })
        : rejectResult(new Error(stderr)),
    );
  });
  watcherPids.set(target, result.pid);
  return result;
}

async function stopWatcher(target) {
  const child = spawnTracked(process.execPath, [cli, "watch", "stop", "--dir", target], {
    cwd: target,
    env: { ...process.env, EF_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child, "exit");
  watcherPids.delete(target);
}

async function killWatcher(target) {
  const pidPath = join(target, ".ef/watch.pid");
  const pid = Number(readFileSync(pidPath, "utf8"));
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      rmSync(pidPath, { force: true });
      watcherPids.delete(target);
      return;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  rmSync(pidPath, { force: true });
  watcherPids.delete(target);
  throw new Error(`watcher ${pid} did not die after SIGKILL`);
}

async function waitForQuiescence(repo, activeTargets) {
  let stable = 0;
  let previous = "-1";
  const deadline = Date.now() + 30_000;
  while (stable < 4) {
    if (interrupted) throw new Error("harness interrupted during quiescence");
    if (Date.now() >= deadline) throw new Error("watchers did not reach checkpoint quiescence");
    await new Promise((done) => setTimeout(done, 100));
    const records = await repo.rawDump();
    const current = records.at(-1)?.offset ?? "-1";
    const activeAtHead = activeTargets.every((target) => {
      try {
        return workspace.load(target).headOffset === current;
      } catch {
        return false;
      }
    });
    if (current === previous && activeAtHead) stable += 1;
    else {
      stable = 0;
      previous = current;
    }
  }
  return previous;
}

async function waitForConvergence(repo, left, right) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const leftDigest = worktreeNode.worktreeDigestDirectory(left);
    const rightDigest = worktreeNode.worktreeDigestDirectory(right);
    const replayDigest = streamfs.worktreeDigest(await repo.tree());
    if (
      leftDigest === rightDigest &&
      leftDigest === replayDigest &&
      compareWorktrees(left, right).length === 0
    )
      return { leftDigest, rightDigest, replayDigest };
    await new Promise((done) => setTimeout(done, 100));
  }
  return {
    leftDigest: worktreeNode.worktreeDigestDirectory(left),
    rightDigest: worktreeNode.worktreeDigestDirectory(right),
    replayDigest: streamfs.worktreeDigest(await repo.tree()),
  };
}

function bisectEvidence(records, branchDump, targetPath) {
  const changed = records.findIndex((record) => {
    const payload = record.payload;
    return (
      record.type.startsWith("fs.file.") &&
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload.path === targetPath
    );
  });
  if (changed < 0) return "unavailable";
  const corruptDump = join(scratch, "corrupt-branch.jsonl");
  const record = records[changed];
  const payload = record.payload;
  const corruptRecord = {
    ...record,
    payload:
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload, path: `${payload.path}.corrupt` }
        : payload,
  };
  const corrupted = records.map((candidate, index) =>
    index === changed ? corruptRecord : candidate,
  );
  writeFileSync(
    corruptDump,
    `${corrupted.map((candidate) => canonicalJson(candidate)).join("\n")}\n`,
  );
  const result = spawnSync(process.execPath, [cli, "bisect", branchDump, corruptDump], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout?.trim() || result.stderr?.trim() || "unavailable";
}

async function main() {
  const stream = await startStreamServer();
  if (!stream.url) throw new Error("stream server did not report a URL");
  const tokens = new Map([
    ["local-token", "machine-a"],
    ["remote-token", "machine-b"],
  ]);
  const verifier = {
    verifyAuthorization: async (header) => {
      const subject = tokens.get(header?.replace(/^Bearer /, ""));
      if (!subject) throw new platform.UnauthorizedError("invalid_signature");
      return { sub: subject };
    },
    authorizationContext: async (header) => {
      const subject = tokens.get(header?.replace(/^Bearer /, ""));
      if (!subject) throw new platform.UnauthorizedError("invalid_signature");
      return {
        principal: { kind: "identified", sub: subject },
        identity: identity.emptyView(),
        identityOffset: "-1",
      };
    },
  };
  const gateway = new platform.PlatformGateway({
    verifier,
    streams: new platform.OfficialStreamAdapter({ baseUrl: stream.url }),
    namespaceViewReader: {
      viewFor: async () => ({
        orgs: {
          e4: {
            owner: "machine-a",
            projects: { convergence: { owner: "machine-a" } },
            repos: {
              convergence: { owner: "machine-a", project: "convergence", visibility: "private" },
            },
          },
        },
      }),
    },
    decideAuthorization: (input) => ({
      allowed: true,
      operation: input.operation,
      identityOffset: input.identityOffset,
      basis: "grant:write",
      streamId: input.target.kind === "repo" ? input.target.streamId : "test",
    }),
  });
  platformServer = platform.createPlatformServer((request) => gateway.handle(request));
  const platformUrl = await platform.listenPlatformServer(platformServer);
  const repo = new streamfs.StreamFsRepo(stream.url, fetch, "e4/convergence");
  await client.createDurableJsonStream({
    url: `${stream.url}/streams/${encodeURIComponent(repo.metadataStreamId)}`,
  });
  for (const directory of ["docs", "src", "nested", "notes"]) await repo.mkdir(directory);
  await repo.createFile("docs/readme.txt", new TextEncoder().encode("base\n"));
  await repo.createFile("src/naïve.bin", new TextEncoder().encode("seed\n"));
  await repo.createFile("nested/機械.json", new TextEncoder().encode("{}\n"));
  await repo.createFile("notes/todo.md", new TextEncoder().encode("todo\n"));
  cloneWorkspace(machineA, "local-token", platformUrl, stream.url);
  cloneWorkspace(machineB, "remote-token", platformUrl, stream.url);
  const initialRecords = await repo.rawDump();
  await startWatcher(machineA, "local-token", "machine-a", stream.url, platformUrl);
  await startWatcher(machineB, "remote-token", "machine-b", stream.url, platformUrl);
  if (topologyOutput !== undefined) {
    mkdirSync(dirname(topologyOutput), { recursive: true });
    writeFileSync(
      topologyOutput,
      `${canonicalJson({
        branch: "e4/convergence:main",
        machines: [
          { name: "A", pid: watcherPids.get(machineA), root: machineA },
          { name: "B", pid: watcherPids.get(machineB), root: machineB },
        ],
      })}\n`,
    );
  }

  const schedule = expandSchedule(seed);
  const transcriptSteps = [];
  const content = (ref) => Buffer.from(ref === "alpha" ? "alpha\n" : `${ref}\n`);
  const activeTargets = new Set([machineA, machineB]);
  for (const step of schedule.steps) {
    const target = step.machine === "A" ? machineA : machineB;
    const op = step.op;
    if (op.type === "stop") {
      await stopWatcher(op.machine === "A" ? machineA : machineB);
      activeTargets.delete(op.machine === "A" ? machineA : machineB);
    } else if (op.type === "kill") {
      await killWatcher(op.machine === "A" ? machineA : machineB);
      activeTargets.delete(op.machine === "A" ? machineA : machineB);
    } else if (op.type === "restart") {
      await startWatcher(
        op.machine === "A" ? machineA : machineB,
        op.machine === "A" ? "local-token" : "remote-token",
        op.machine === "A" ? "machine-a" : "machine-b",
        stream.url,
        platformUrl,
      );
      activeTargets.add(op.machine === "A" ? machineA : machineB);
    } else if (op.type === "write") {
      mkdirSync(dirname(join(target, op.path)), { recursive: true });
      writeFileSync(join(target, op.path), content(op.contentRef));
    } else if (op.type === "append")
      writeFileSync(
        join(target, op.path),
        Buffer.concat([readFileSync(join(target, op.path)), content(op.contentRef)]),
      );
    else if (op.type === "delete") rmSync(join(target, op.path), { force: true });
    else if (op.type === "rename") {
      mkdirSync(dirname(join(target, op.to)), { recursive: true });
      writeFileSync(join(target, op.to), readFileSync(join(target, op.from)));
      rmSync(join(target, op.from), { force: true });
    }
    if (mode === "lockstep") await waitForQuiescence(repo, [...activeTargets]);
    const headOffset = (await repo.rawDump()).at(-1)?.offset ?? "-1";
    const digestA = worktreeNode.worktreeDigestDirectory(machineA);
    const digestB = worktreeNode.worktreeDigestDirectory(machineB);
    transcriptSteps.push({
      step: step.step,
      machine: step.machine,
      op: step.op,
      digestA,
      digestB,
      headOffset,
    });
  }
  if (mutationPath !== undefined) {
    await stopWatcher(machineA);
    await stopWatcher(machineB);
    const target = join(machineA, mutationPath);
    const bytes = readFileSync(target);
    if (bytes.byteLength === 0) throw new Error(`cannot mutate empty file: ${mutationPath}`);
    bytes[0] ^= 1;
    writeFileSync(target, bytes);
  } else {
    await waitForQuiescence(repo, [machineA, machineB]);
  }
  const records = await repo.rawDump();
  const stableRecords = records.map((record) => ({ ...record, ts: 0 }));
  const branchDump = join(scratch, "branch.jsonl");
  writeFileSync(branchDump, `${stableRecords.map((record) => canonicalJson(record)).join("\n")}\n`);
  if (branchOutput !== undefined) {
    mkdirSync(dirname(branchOutput), { recursive: true });
    writeFileSync(branchOutput, readFileSync(branchDump));
  }
  const replayFromCli = execFileSync(
    process.execPath,
    [cli, "replay", branchDump, "--worktree-digest"],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();
  const isMutation = (record) =>
    record.type === "fs.file.write" || record.type === "fs.file.delete";
  const initialMutationCount = initialRecords.filter(isMutation).length;
  const finalMutationCount = records.filter(isMutation).length;
  const expected = expectedMutationCount(schedule);
  if (mode === "lockstep" && finalMutationCount - initialMutationCount !== expected)
    throw new Error(
      `mutation count mismatch: expected=${expected} actual=${finalMutationCount - initialMutationCount} types=${JSON.stringify(records.map((record) => record.type))}`,
    );
  const converged = await waitForConvergence(repo, machineA, machineB);
  const { replayDigest, leftDigest: digestA, rightDigest: digestB } = converged;
  const mismatches = compareWorktrees(machineA, machineB);
  if (
    mismatches.length ||
    digestA !== digestB ||
    digestA !== replayDigest ||
    replayFromCli !== replayDigest
  )
    throw new Error(
      `convergence mismatch path=${JSON.stringify(mismatches)} first-divergent-offset=${bisectEvidence(stableRecords, branchDump, mutationPath)} digestA=${digestA} digestB=${digestB} replay=${replayDigest}`,
    );
  const transcript = canonicalTranscript({
    version: 1,
    seed,
    profile: "default",
    mode,
    steps: transcriptSteps,
    final: { digestA, digestB, replayDigest },
  });
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, transcript);
  }
  process.stdout.write(transcript);
  await stopWatcher(machineA);
  await stopWatcher(machineB);
  await new Promise((resolveDone) => platformServer.close(() => resolveDone()));
  platformServer = undefined;
  stream.child.kill("SIGTERM");
  streamChild = undefined;
}

try {
  await main();
} finally {
  for (const pid of watcherPids.values()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The watcher already exited.
    }
  }
  if (platformServer !== undefined) platformServer.close();
  if (streamChild !== undefined) streamChild.kill("SIGKILL");
  for (const child of children) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}
