#!/usr/bin/env node
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const cli = join(root, "packages/cli/dist/src/bin.js");
const serverBin = join(root, "packages/server/dist/src/bin.js");
const outArg = process.argv.indexOf("--out");
const branchArg = process.argv.indexOf("--branch-dump");
const decisionAArg = process.argv.indexOf("--decision-log-a");
const decisionBArg = process.argv.indexOf("--decision-log-b");
const topologyArg = process.argv.indexOf("--topology");
const seedArg = process.argv.indexOf("--seed");
const modeArg = process.argv.indexOf("--mode");
const profileArg = process.argv.indexOf("--profile");
const mutateArg = process.argv.indexOf("--mutate");
const corruptArg = process.argv.indexOf("--corrupt");
const interruptArg = process.argv.indexOf("--interrupt-after");
const teardownArg = process.argv.indexOf("--teardown-report");
const scenarioArg = process.argv.indexOf("--scenario");
const loserOutputArg = process.argv.indexOf("--loser-output");
const conflictOutputArg = process.argv.indexOf("--conflict-output");
const seed = Number(seedArg >= 0 ? process.argv[seedArg + 1] : "1");
const mode = modeArg >= 0 ? process.argv[modeArg + 1] : "lockstep";
const profile = profileArg >= 0 ? process.argv[profileArg + 1] : "default";
const mutationPath = mutateArg >= 0 ? process.argv[mutateArg + 1] : undefined;
const corruption = corruptArg >= 0 ? process.argv[corruptArg + 1] : undefined;
const interruptAfter = interruptArg >= 0 ? Number(process.argv[interruptArg + 1]) : undefined;
const teardownReport =
  teardownArg >= 0 ? resolve(process.argv[teardownArg + 1] ?? "teardown.json") : undefined;
const scenario = scenarioArg >= 0 ? process.argv[scenarioArg + 1] : undefined;
const loserOutput =
  loserOutputArg >= 0 ? resolve(process.argv[loserOutputArg + 1] ?? "loser.bin") : undefined;
const conflictOutput =
  conflictOutputArg >= 0
    ? resolve(process.argv[conflictOutputArg + 1] ?? "conflict.bin")
    : undefined;
const output = outArg >= 0 ? resolve(process.argv[outArg + 1] ?? "transcript.txt") : undefined;
const branchOutput =
  branchArg >= 0 ? resolve(process.argv[branchArg + 1] ?? "branch.jsonl") : undefined;
const decisionAOutput =
  decisionAArg >= 0 ? resolve(process.argv[decisionAArg + 1] ?? "decision-a.jsonl") : undefined;
const decisionBOutput =
  decisionBArg >= 0 ? resolve(process.argv[decisionBArg + 1] ?? "decision-b.jsonl") : undefined;
const topologyOutput =
  topologyArg >= 0 ? resolve(process.argv[topologyArg + 1] ?? "topology.json") : undefined;
if (
  !Number.isSafeInteger(seed) ||
  seed < 0 ||
  (mode !== "lockstep" && mode !== "free") ||
  (profile !== "default" && profile !== "offline") ||
  (branchArg >= 0 && branchOutput === undefined) ||
  (decisionAArg >= 0 && decisionAOutput === undefined) ||
  (decisionBArg >= 0 && decisionBOutput === undefined) ||
  (topologyArg >= 0 && topologyOutput === undefined) ||
  (mutateArg >= 0 && (mutationPath === undefined || mutationPath.includes(".."))) ||
  (corruptArg >= 0 && !["delete", "stray", "swap"].includes(corruption)) ||
  (interruptArg >= 0 && (!Number.isSafeInteger(interruptAfter) || interruptAfter < 0)) ||
  (teardownArg >= 0 && teardownReport === undefined) ||
  (scenarioArg >= 0 &&
    !["offline-remote-only", "offline-local-only", "true-conflict", "mixed"].includes(scenario)) ||
  (loserOutputArg >= 0 && loserOutput === undefined) ||
  (conflictOutputArg >= 0 && conflictOutput === undefined)
) {
  console.error(
    "usage: run.mjs --seed <non-negative integer> [--profile default|offline] [--mode lockstep|free] [--scenario offline-remote-only|offline-local-only|true-conflict|mixed] [--out path] [--branch-dump path] [--loser-output path] [--conflict-output path] [--decision-log-a path] [--decision-log-b path] [--topology path] [--mutate relative-file] [--corrupt delete|stray|swap] [--interrupt-after step] [--teardown-report path]",
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
const serverDataDir = join(scratch, "server-data");
const machineA = join(scratch, "machine-a");
const machineB = join(scratch, "machine-b");
mkdirSync(home, { recursive: true });
mkdirSync(cloneHome, { recursive: true });
mkdirSync(machineA, { recursive: true });
mkdirSync(machineB, { recursive: true });
const children = new Set();
const childPids = new Set();
const watcherPids = new Map();
const allWatcherPids = new Set();
let platformServer;
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.add(child);
  if (child.pid !== undefined) childPids.add(child.pid);
  child.once("exit", () => children.delete(child));
  return child;
}

async function startStreamServer() {
  const child = spawnTracked(
    process.execPath,
    [serverBin, "--port", "0", "--store", "file", "--data-dir", serverDataDir],
    { cwd: root },
  );
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

async function cloneWorkspace(target, token, serverUrl, streamUrl) {
  writeFileSync(join(cloneHome, "credentials.json"), credentials(token), { mode: 0o600 });
  const namespace = await fetch(`${serverUrl}/api/namespaces/e4/convergence`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!namespace.ok)
    throw new Error(`authenticated clone namespace preflight failed: ${namespace.status}`);
  rmSync(join(cloneHome, "credentials.json"), { force: true });
  execFileSync(
    process.execPath,
    [cli, "clone", "e4/convergence", "main", target, "--server", streamUrl],
    {
      cwd: root,
      env: {
        ...process.env,
        EF_HOME: cloneHome,
        EF_SERVER_URL: serverUrl,
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
  allWatcherPids.add(result.pid);
  return result;
}

async function stopWatcher(target) {
  const pid = watcherPids.get(target);
  if (pid === undefined) return;
  const child = spawnTracked(process.execPath, [cli, "watch", "stop", "--dir", target], {
    cwd: target,
    env: { ...process.env, EF_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "exit");
  if (code !== 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        watcherPids.delete(target);
        return;
      }
    }
    throw new Error(`watch stop failed for ${target}: exit=${code}`);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        watcherPids.delete(target);
        return;
      }
      throw error;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`watcher ${pid} did not exit after watch stop: ${target}`);
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
  const fallbackPath = records
    .map((record) => record.payload)
    .find(
      (payload) =>
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof payload.path === "string",
    )?.path;
  const path = targetPath ?? fallbackPath;
  const changed = records.findLastIndex((record) => {
    const payload = record.payload;
    return (
      record.type.startsWith("fs.file.") &&
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload.path === path
    );
  });
  if (changed < 0) return "unavailable";
  const prefixDump = join(scratch, "prefix-branch.jsonl");
  // Compare the actual branch log with its real prefix immediately before the
  // event that established the offending path. This makes ef bisect locate a
  // boundary in the recorded stream rather than comparing the log to a
  // self-mutated copy whose answer is known in advance.
  const prefix = records.slice(0, changed);
  writeFileSync(
    prefixDump,
    `${prefix.map((candidate) => canonicalJson(candidate)).join("\n")}${prefix.length ? "\n" : ""}`,
  );
  const result = spawnSync(process.execPath, [cli, "bisect", branchDump, prefixDump], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout?.trim() || result.stderr?.trim() || "unavailable";
}

function assertAppliedOffsets(rootPath, branchRecords, initialLength, exact) {
  const journal = join(rootPath, ".ef", "apply-journal");
  if (!existsSync(journal)) throw new Error(`missing applied-offset journal: ${rootPath}`);
  const applied = readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line);
      if (record === null || typeof record !== "object" || typeof record.offset !== "string")
        throw new Error(`malformed applied offset in ${rootPath}`);
      return record.offset;
    });
  const expected = branchRecords.slice(initialLength).map((record) => record.offset);
  if (exact && JSON.stringify(applied) !== JSON.stringify(expected))
    throw new Error(
      `applied-offset journal mismatch in ${rootPath}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(applied)}`,
    );
  return applied.length;
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
  await cloneWorkspace(machineA, "local-token", platformUrl, stream.url);
  await cloneWorkspace(machineB, "remote-token", platformUrl, stream.url);
  const initialRecords = await repo.rawDump();
  await startWatcher(machineA, "local-token", "machine-a", stream.url, platformUrl);
  await startWatcher(machineB, "remote-token", "machine-b", stream.url, platformUrl);
  if (topologyOutput !== undefined) {
    mkdirSync(dirname(topologyOutput), { recursive: true });
    writeFileSync(
      topologyOutput,
      `${canonicalJson({
        server: { pid: stream.child.pid, dataDir: serverDataDir, store: "file" },
        branch: "e4/convergence:main",
        machines: [
          {
            name: "A",
            pid: watcherPids.get(machineA),
            root: machineA,
            identity: workspace.load(machineA).identity,
          },
          {
            name: "B",
            pid: watcherPids.get(machineB),
            root: machineB,
            identity: workspace.load(machineB).identity,
          },
        ],
      })}\n`,
    );
  }

  const schedule = expandSchedule(seed, profile);
  const transcriptSteps = [];
  const content = (ref) => Buffer.from(ref === "alpha" ? "alpha\n" : `${ref}\n`);
  const activeTargets = new Set([machineA, machineB]);
  const scenarioSteps = scenario === undefined ? schedule.steps : [];
  let scenarioLoserBytes;
  if (scenario !== undefined) {
    await stopWatcher(machineA);
    await stopWatcher(machineB);
    activeTargets.clear();
    const localBytes = Buffer.from("local loser\n");
    const remoteBytes = Buffer.from("remote winner\n");
    if (scenario === "offline-remote-only") {
      writeFileSync(join(machineB, "docs/remote-only.txt"), remoteBytes);
    } else if (scenario === "offline-local-only") {
      writeFileSync(join(machineA, "docs/local-only.txt"), localBytes);
    } else if (scenario === "true-conflict") {
      scenarioLoserBytes = Buffer.from([0, 1, 2, 255]);
      writeFileSync(join(machineA, "docs/conflict.bin"), scenarioLoserBytes);
      writeFileSync(join(machineB, "docs/conflict.bin"), remoteBytes);
    } else {
      scenarioLoserBytes = localBytes;
      writeFileSync(join(machineA, "docs/mixed-conflict.bin"), scenarioLoserBytes);
      writeFileSync(join(machineA, "docs/mixed-local.txt"), Buffer.from("kept local\n"));
      writeFileSync(join(machineB, "docs/mixed-conflict.bin"), remoteBytes);
      writeFileSync(join(machineB, "docs/mixed-remote.txt"), Buffer.from("kept remote\n"));
    }
    await startWatcher(machineB, "remote-token", "machine-b", stream.url, platformUrl);
    activeTargets.add(machineB);
    await waitForQuiescence(repo, [machineB]);
    await startWatcher(machineA, "local-token", "machine-a", stream.url, platformUrl);
    activeTargets.add(machineA);
    await waitForQuiescence(repo, [machineA, machineB]);
    transcriptSteps.push({ step: 1, machine: "A+B", op: { type: "scenario", name: scenario } });
  }
  for (const step of scenarioSteps) {
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
    if (mode === "lockstep" || op.type === "barrier")
      await waitForQuiescence(repo, [...activeTargets]);
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
    if (interruptAfter === step.step) process.kill(process.pid, "SIGINT");
    if (interrupted) throw new Error(`interrupted after schedule step ${step.step}`);
  }
  if (mutationPath !== undefined || corruption !== undefined) {
    await stopWatcher(machineA);
    await stopWatcher(machineB);
    const target = mutationPath === undefined ? undefined : join(machineA, mutationPath);
    if (corruption === "delete") {
      rmSync(target ?? join(machineA, "notes/todo.md"), { force: true });
    } else if (corruption === "stray") {
      writeFileSync(join(machineA, "stray-e4-t09.txt"), "unexpected\n");
    } else if (corruption === "swap") {
      const first = join(machineA, "docs/renamed.txt");
      const second = join(machineA, "notes/todo.md");
      const firstBytes = readFileSync(first);
      writeFileSync(first, readFileSync(second));
      writeFileSync(second, firstBytes);
    } else {
      if (target === undefined) throw new Error("mutation path is required");
      const bytes = readFileSync(target);
      if (bytes.byteLength === 0) throw new Error(`cannot mutate empty file: ${mutationPath}`);
      bytes[0] ^= 1;
      writeFileSync(target, bytes);
    }
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
  const replayTreeFromCli =
    scenario === undefined
      ? undefined
      : execFileSync(
          process.execPath,
          [
            cli,
            "replay",
            branchDump,
            "--digest",
            "--reducer",
            join(root, "packages/streamfs/reducer.mjs"),
          ],
          { cwd: root, encoding: "utf8" },
        ).trim();
  const treeDigestFromRepo =
    scenario === undefined ? undefined : streamfs.treeDigest(await repo.tree());
  const isMutation = (record) =>
    record.type === "fs.file.write" || record.type === "fs.file.delete";
  const initialMutationCount = initialRecords.filter(isMutation).length;
  const finalMutationCount = records.filter(isMutation).length;
  // The stream mutation audit below counts metadata deletes and writes; a
  // rename's destination create is intentionally not a second mutation.
  const expected =
    profile === "offline"
      ? expectedMutationCount(schedule) -
        schedule.steps.filter(({ op }) => op.type === "rename").length
      : expectedMutationCount(schedule);
  if (
    scenario === undefined &&
    mode === "lockstep" &&
    finalMutationCount - initialMutationCount !== expected
  )
    throw new Error(
      `mutation count mismatch: expected=${expected} actual=${finalMutationCount - initialMutationCount} types=${JSON.stringify(records.map((record) => record.type))}`,
    );
  const appliedA = assertAppliedOffsets(
    machineA,
    records,
    initialRecords.length,
    mode === "lockstep",
  );
  const appliedB = assertAppliedOffsets(
    machineB,
    records,
    initialRecords.length,
    mode === "lockstep",
  );
  const converged = await waitForConvergence(repo, machineA, machineB);
  const { replayDigest, leftDigest: digestA, rightDigest: digestB } = converged;
  const mismatches = compareWorktrees(machineA, machineB);
  if (
    mismatches.length ||
    digestA !== digestB ||
    digestA !== replayDigest ||
    replayFromCli !== replayDigest ||
    (scenario !== undefined && replayTreeFromCli !== treeDigestFromRepo)
  )
    throw new Error(
      `convergence mismatch path=${JSON.stringify(mismatches)} first-divergent-offset=${bisectEvidence(stableRecords, branchDump, mutationPath ?? mismatches[0]?.path)} digestA=${digestA} digestB=${digestB} replay=${replayDigest}`,
    );
  if (scenario !== undefined) {
    const conflicts = records.filter((record) => record.type === "sync/conflict");
    const conflictFiles = [machineA, machineB].map((machine) =>
      readdirSync(join(machine, "docs"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.includes(".conflict-"))
        .map((entry) => entry.name)
        .sort(),
    );
    const shouldConflict = scenario === "true-conflict" || scenario === "mixed";
    if ((shouldConflict && conflicts.length !== 1) || (!shouldConflict && conflicts.length !== 0))
      throw new Error(`scenario ${scenario} conflict-event count=${conflicts.length}`);
    if (
      (shouldConflict && (conflictFiles[0].length !== 1 || conflictFiles[1].length !== 1)) ||
      (!shouldConflict && (conflictFiles[0].length !== 0 || conflictFiles[1].length !== 0))
    )
      throw new Error(
        `scenario ${scenario} conflict-file mismatch=${JSON.stringify(conflictFiles)}`,
      );
    transcriptSteps[0].conflictEvents = conflicts.length;
    transcriptSteps[0].conflictFiles = conflictFiles;
    if (shouldConflict) {
      if (loserOutput !== undefined) {
        mkdirSync(dirname(loserOutput), { recursive: true });
        writeFileSync(loserOutput, scenarioLoserBytes);
      }
      if (conflictOutput !== undefined) {
        mkdirSync(dirname(conflictOutput), { recursive: true });
        writeFileSync(conflictOutput, readFileSync(join(machineA, "docs", conflictFiles[0][0])));
      }
    }
  }
  const transcript = canonicalTranscript({
    version: 1,
    seed,
    profile,
    mode,
    steps: transcriptSteps,
    final: {
      digestA,
      digestB,
      replayDigest,
      ...(replayTreeFromCli === undefined ? {} : { replayTreeDigest: replayTreeFromCli }),
      appliedOffsetsA: appliedA,
      appliedOffsetsB: appliedB,
    },
  });
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, transcript);
  }
  for (const [path, machine] of [
    [decisionAOutput, machineA],
    [decisionBOutput, machineB],
  ]) {
    if (path === undefined) continue;
    mkdirSync(dirname(path), { recursive: true });
    const source = join(machine, ".ef", "reconcile.jsonl");
    writeFileSync(path, existsSync(source) ? readFileSync(source) : "");
  }
  process.stdout.write(transcript);
  await stopWatcher(machineA);
  await stopWatcher(machineB);
  await new Promise((resolveDone) => platformServer.close(() => resolveDone()));
  platformServer = undefined;
  stream.child.kill("SIGTERM");
}

async function cleanup() {
  for (const pid of allWatcherPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The watcher already exited.
    }
  }
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child already exited.
    }
  }
  await new Promise((done) => setTimeout(done, 25));
  if (platformServer !== undefined) platformServer.close();
  rmSync(scratch, { recursive: true, force: true });
  if (teardownReport !== undefined) {
    const survivingPids = [...childPids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    mkdirSync(dirname(teardownReport), { recursive: true });
    writeFileSync(
      teardownReport,
      `${JSON.stringify({ scratchRemoved: !existsSync(scratch), survivingPids })}\n`,
    );
  }
}

try {
  await main();
} finally {
  await cleanup();
}
