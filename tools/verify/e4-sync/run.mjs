#!/usr/bin/env node
import { once } from "node:events";
import {
  cpSync,
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
const mutateSideArg = process.argv.indexOf("--mutate-side");
const corruptArg = process.argv.indexOf("--corrupt");
const interruptArg = process.argv.indexOf("--interrupt-after");
const teardownArg = process.argv.indexOf("--teardown-report");
const scenarioArg = process.argv.indexOf("--scenario");
const loserOutputArg = process.argv.indexOf("--loser-output");
const conflictOutputArg = process.argv.indexOf("--conflict-output");
const contentOutputArg = process.argv.indexOf("--content-output");
const evidenceDirArg = process.argv.indexOf("--evidence-dir");
const convergenceBoundArg = process.argv.indexOf("--convergence-bound-ms");
const sabotageCatchupArg = process.argv.indexOf("--sabotage-catchup-offset");
const sabotageConflictBytesArg = process.argv.indexOf("--sabotage-conflict-bytes");
const capstoneArg = process.argv.indexOf("--capstone");
const externalStreamArg = process.argv.indexOf("--stream-url");
const externalPlatformArg = process.argv.indexOf("--platform-url");
const browserControlArg = process.argv.indexOf("--browser-control");
const seed = Number(seedArg >= 0 ? process.argv[seedArg + 1] : "1");
const mode = modeArg >= 0 ? process.argv[modeArg + 1] : "lockstep";
const profile = profileArg >= 0 ? process.argv[profileArg + 1] : "default";
const mutationPath = mutateArg >= 0 ? process.argv[mutateArg + 1] : undefined;
const mutationSide = mutateSideArg >= 0 ? process.argv[mutateSideArg + 1] : "A";
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
const contentOutput =
  contentOutputArg >= 0
    ? resolve(process.argv[contentOutputArg + 1] ?? "content.jsonl")
    : undefined;
const evidenceDir =
  evidenceDirArg >= 0 ? resolve(process.argv[evidenceDirArg + 1] ?? "evidence") : undefined;
const convergenceBoundMs =
  convergenceBoundArg >= 0 ? Number(process.argv[convergenceBoundArg + 1]) : undefined;
const sabotageCatchupOffset = sabotageCatchupArg >= 0;
const sabotageConflictBytes = sabotageConflictBytesArg >= 0;
const capstone = capstoneArg >= 0;
const externalStreamUrl = externalStreamArg >= 0 ? process.argv[externalStreamArg + 1] : undefined;
const externalPlatformUrl =
  externalPlatformArg >= 0 ? process.argv[externalPlatformArg + 1] : undefined;
const browserControl =
  browserControlArg >= 0
    ? resolve(process.argv[browserControlArg + 1] ?? "browser-control.json")
    : undefined;
const external = externalStreamUrl !== undefined || externalPlatformUrl !== undefined;
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
  (mutateSideArg >= 0 && mutationSide !== "A" && mutationSide !== "B") ||
  (corruptArg >= 0 && !["delete", "stray", "swap"].includes(corruption)) ||
  (interruptArg >= 0 && (!Number.isSafeInteger(interruptAfter) || interruptAfter < 0)) ||
  (teardownArg >= 0 && teardownReport === undefined) ||
  (scenarioArg >= 0 &&
    !["offline-remote-only", "offline-local-only", "true-conflict", "mixed"].includes(scenario)) ||
  (loserOutputArg >= 0 && loserOutput === undefined) ||
  (conflictOutputArg >= 0 && conflictOutput === undefined) ||
  (contentOutputArg >= 0 && contentOutput === undefined) ||
  (evidenceDirArg >= 0 && evidenceDir === undefined) ||
  (convergenceBoundArg >= 0 &&
    (!Number.isSafeInteger(convergenceBoundMs) || convergenceBoundMs < 0)) ||
  (sabotageCatchupArg >= 0 && scenario === undefined) ||
  (externalStreamArg >= 0 && externalStreamUrl === undefined) ||
  (externalPlatformArg >= 0 && externalPlatformUrl === undefined) ||
  (external && (externalStreamUrl === undefined || externalPlatformUrl === undefined))
) {
  console.error(
    "usage: run.mjs --seed <non-negative integer> [--profile default|offline] [--mode lockstep|free] [--scenario offline-remote-only|offline-local-only|true-conflict|mixed] [--capstone] [--stream-url url --platform-url url] [--browser-control path] [--out path] [--branch-dump path] [--content-output path] [--evidence-dir path] [--loser-output path] [--conflict-output path] [--decision-log-a path] [--decision-log-b path] [--topology path] [--mutate relative-file] [--mutate-side A|B] [--corrupt delete|stray|swap] [--interrupt-after step] [--teardown-report path] [--convergence-bound-ms non-negative integer] [--sabotage-catchup-offset]",
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
  materializer,
  workspace,
] = await Promise.all([
  importDist("packages/sync-harness/dist/src/index.js"),
  importDist("packages/protocol/dist/src/index.js"),
  importDist("packages/client/dist/src/index.js"),
  importDist("packages/streamfs/dist/src/index.js"),
  importDist("packages/streamfs/dist/src/worktree-node.js"),
  importDist("packages/platform/dist/src/index.js"),
  importDist("packages/identity/dist/src/index.js"),
  importDist("packages/cli/dist/src/tree-materializer.js"),
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
const observedConvergenceMs = [];
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

function browserControlState() {
  if (browserControl === undefined || !existsSync(browserControl)) return {};
  try {
    return JSON.parse(readFileSync(browserControl, "utf8"));
  } catch {
    return {};
  }
}

function writeBrowserControl(patch) {
  if (browserControl === undefined) return;
  mkdirSync(dirname(browserControl), { recursive: true });
  writeFileSync(browserControl, `${JSON.stringify({ ...browserControlState(), ...patch })}\n`);
}

async function waitForBrowserControl(key, value, timeoutMs = 120_000) {
  if (browserControl === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browserControlState()[key] === value) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`browser control timeout key=${key} value=${String(value)}`);
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
    throw new Error(
      `authenticated clone namespace preflight failed: ${namespace.status} ${await namespace.text()}`,
    );
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
  rmSync(join(target, ".ef/watch.error"), { force: true });
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
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error(`target=${target} watch start timed out after 10000ms ${stderr}`));
    }, 10_000);
    child.once("exit", (code) => {
      globalThis.clearTimeout(timeout);
      if (code === 0) {
        resolveResult({ pid: Number(readFileSync(join(target, ".ef/watch.pid"), "utf8")) });
        return;
      }
      rejectResult(
        new Error(
          `target=${target} ${stderr}${existsSync(join(target, ".ef/watch.error")) ? readFileSync(join(target, ".ef/watch.error"), "utf8") : ""}`,
        ),
      );
    });
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
  const startedAt = Date.now();
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
  if (convergenceBoundMs !== undefined) {
    const elapsed = Date.now() - startedAt;
    observedConvergenceMs.push(elapsed);
    if (elapsed > convergenceBoundMs)
      throw new Error(
        `convergence bound exceeded boundMs=${convergenceBoundMs} observedMs=${elapsed}`,
      );
  }
  return previous;
}

async function waitForStreamAdvance(repo, previousLength) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await repo.rawDump()).length > previousLength) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `stream did not advance after live filesystem edit previousLength=${previousLength}`,
  );
}

async function waitForConvergence(repo, left, right) {
  const startedAt = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const leftDigest = worktreeNode.worktreeDigestDirectory(left);
    const rightDigest = worktreeNode.worktreeDigestDirectory(right);
    const replayDigest = streamfs.worktreeDigest(await repo.tree());
    if (
      leftDigest === rightDigest &&
      leftDigest === replayDigest &&
      compareWorktrees(left, right).length === 0
    ) {
      if (convergenceBoundMs !== undefined) {
        const elapsed = Date.now() - startedAt;
        observedConvergenceMs.push(elapsed);
        if (elapsed > convergenceBoundMs)
          throw new Error(
            `convergence bound exceeded boundMs=${convergenceBoundMs} observedMs=${elapsed}`,
          );
      }
      return { leftDigest, rightDigest, replayDigest };
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (convergenceBoundMs !== undefined) {
    const elapsed = Date.now() - startedAt;
    observedConvergenceMs.push(elapsed);
    if (elapsed > convergenceBoundMs)
      throw new Error(
        `convergence bound exceeded boundMs=${convergenceBoundMs} observedMs=${elapsed}`,
      );
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

function assertJournalBijection(rootPath, expectedOffsets) {
  const journal = join(rootPath, ".ef", "apply-journal");
  const offsets = readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).offset);
  if (new Set(offsets).size !== offsets.length)
    throw new Error(`journal bijection duplicate offset in ${rootPath}`);
  if (JSON.stringify(offsets) !== JSON.stringify(expectedOffsets))
    throw new Error(`journal bijection mismatch in ${rootPath}`);
}

async function main() {
  const stream = external
    ? { child: undefined, url: externalStreamUrl }
    : await startStreamServer();
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
  const gateway = external
    ? undefined
    : new platform.PlatformGateway({
        verifier,
        streams: new platform.OfficialStreamAdapter({ baseUrl: stream.url }),
        namespaceViewReader: {
          viewFor: async () => ({
            orgs: {
              e4: {
                owner: "machine-a",
                projects: { convergence: { owner: "machine-a" } },
                repos: {
                  convergence: {
                    owner: "machine-a",
                    project: "convergence",
                    visibility: "private",
                  },
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
  const platformUrl =
    externalPlatformUrl ??
    (await (async () => {
      platformServer = platform.createPlatformServer((request) => gateway.handle(request));
      return platform.listenPlatformServer(platformServer);
    })());
  const repo = new streamfs.StreamFsRepo(stream.url, fetch, "e4/convergence");
  try {
    await client.createDurableJsonStream({
      url: `${stream.url}/streams/${encodeURIComponent(repo.metadataStreamId)}`,
    });
  } catch (error) {
    if (!external || !/already exists|409|conflict/i.test(String(error))) throw error;
  }
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
  writeBrowserControl({ phase: "live", harnessReady: true, platformUrl, streamUrl: stream.url });
  await waitForBrowserControl("browserReady", true);
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
  let scenarioTimeline;
  if (scenario !== undefined) {
    const livePartition = scenario === "mixed" && capstone;
    if (livePartition) {
      await repo.createFile("docs/mixed-conflict.bin", new TextEncoder().encode("shared base\n"));
      await waitForQuiescence(repo, [machineA, machineB]);
      const deadline = Date.now() + 15_000;
      while (
        (!existsSync(join(machineB, "docs/mixed-conflict.bin")) ||
          readFileSync(join(machineB, "docs/mixed-conflict.bin"), "utf8") !== "shared base\n") &&
        Date.now() < deadline
      )
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      if (
        !existsSync(join(machineB, "docs/mixed-conflict.bin")) ||
        readFileSync(join(machineB, "docs/mixed-conflict.bin"), "utf8") !== "shared base\n"
      )
        throw new Error("mixed conflict common base did not converge to B");
    }
    if (livePartition) {
      await stopWatcher(machineB);
      activeTargets.delete(machineB);
      writeBrowserControl({
        phase: "partition",
        partitionHeadOffset: (await repo.rawDump()).at(-1)?.offset ?? "-1",
        watcherA: watcherPids.get(machineA),
        watcherB: watcherPids.get(machineB),
      });
      await waitForBrowserControl("partitionReady", true);
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    } else {
      await stopWatcher(machineA);
      await stopWatcher(machineB);
      activeTargets.clear();
    }
    const partitionHeadOffset = (await repo.rawDump()).at(-1)?.offset ?? "-1";
    const dumpBeforePartitionEdits = (await repo.rawDump()).map((record) => record.offset);
    const bCheckpointBefore = workspace.load(machineB).headOffset;
    const bJournalPath = join(machineB, ".ef/journal.jsonl");
    const bJournalBefore = existsSync(bJournalPath) ? readFileSync(bJournalPath, "utf8") : "";
    const localBytes = Buffer.from("local loser\n");
    const remoteBytes = Buffer.from("remote winner\n");
    if (livePartition) {
      scenarioLoserBytes = localBytes;
      writeFileSync(join(machineA, "docs/mixed-conflict.bin"), scenarioLoserBytes);
      writeFileSync(join(machineA, "docs/mixed-local.txt"), Buffer.from("kept local\n"));
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      await waitForStreamAdvance(repo, dumpBeforePartitionEdits.length);
      await waitForQuiescence(repo, [machineA]);
      writeFileSync(join(machineB, "docs/mixed-conflict.bin"), remoteBytes);
      scenarioLoserBytes = readFileSync(join(machineB, "docs/mixed-conflict.bin"));
      writeFileSync(join(machineB, "docs/mixed-remote.txt"), Buffer.from("kept remote\n"));
      writeFileSync(join(machineA, "docs/mixed-after-b.txt"), Buffer.from("A stayed live\n"));
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      await waitForStreamAdvance(repo, dumpBeforePartitionEdits.length);
      await waitForQuiescence(repo, [machineA]);
      await stopWatcher(machineA);
      activeTargets.delete(machineA);
    } else if (scenario === "offline-remote-only") {
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
    const bCheckpointAfterEdits = workspace.load(machineB).headOffset;
    if (bCheckpointAfterEdits !== bCheckpointBefore)
      throw new Error(
        `partition checkpoint changed while B stopped before=${bCheckpointBefore} after=${bCheckpointAfterEdits}`,
      );
    const dumpAfterPartitionEdits = (await repo.rawDump()).map((record) => record.offset);
    const dumpPrefixMatches = dumpBeforePartitionEdits.every(
      (offset, index) => dumpAfterPartitionEdits[index] === offset,
    );
    if (
      livePartition &&
      (!dumpPrefixMatches || dumpAfterPartitionEdits.length <= dumpBeforePartitionEdits.length)
    )
      throw new Error(
        `partition A edits did not append while B watcher was stopped before=${dumpBeforePartitionEdits.length} after=${dumpAfterPartitionEdits.length} aHead=${workspace.load(machineA).headOffset} bHead=${workspace.load(machineB).headOffset} aPid=${watcherPids.get(machineA)} aAlive=${watcherPids.has(machineA)}`,
      );
    if (
      !livePartition &&
      JSON.stringify(dumpAfterPartitionEdits) !== JSON.stringify(dumpBeforePartitionEdits)
    )
      throw new Error("partition dump changed while both watchers were stopped");
    const bJournalAfter = existsSync(bJournalPath) ? readFileSync(bJournalPath, "utf8") : "";
    if (bJournalAfter !== bJournalBefore)
      throw new Error("B journal changed while B watcher was stopped");
    if (livePartition) {
      writeBrowserControl({ phase: "partition", partitionComplete: true });
      await waitForBrowserControl("partitionSampleReady", true);
      writeBrowserControl({ phase: "reunion", partitionComplete: true });
      await waitForBrowserControl("reunionReady", true);
    }
    if (sabotageCatchupOffset) {
      const statePath = join(machineB, ".ef/workspace.json");
      const journalPath = join(machineB, ".ef/apply-journal");
      const basePath = join(machineB, ".ef/apply-base");
      const staleCheckpoint = "-1";
      if (!(await repo.rawDump()).at(0))
        throw new Error("catch-up sabotage has no valid checkpoint evidence");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.headOffset = staleCheckpoint;
      materializer.clearWorktree(machineB);
      await materializer.materializeTree(machineB, await repo.treeAt(staleCheckpoint), (path) =>
        repo.readFileAt(path, staleCheckpoint),
      );
      writeFileSync(statePath, `${canonicalJson(state)}\n`);
      writeFileSync(journalPath, "");
      writeFileSync(basePath, `${canonicalJson({ v: 1, baseOffset: staleCheckpoint })}\n`);
    }
    writeBrowserControl({ phase: "reunion-starting-b" });
    let machineBStarted = false;
    let machineBStartError;
    for (let attempt = 0; attempt < 3 && !machineBStarted; attempt += 1) {
      try {
        await startWatcher(machineB, "remote-token", "machine-b", stream.url, platformUrl);
        machineBStarted = true;
      } catch (error) {
        machineBStartError = error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    }
    if (!machineBStarted) {
      throw machineBStartError ?? new Error("machine B watcher failed to start");
    }
    writeBrowserControl({ phase: "reunion-b-ready" });
    activeTargets.add(machineB);
    await waitForQuiescence(repo, [machineB]);
    const catchupHeadOffset = workspace.load(machineB).headOffset;
    writeBrowserControl({ phase: "reunion-starting-a" });
    await startWatcher(machineA, "local-token", "machine-a", stream.url, platformUrl);
    writeBrowserControl({ phase: "reunion-a-ready" });
    activeTargets.add(machineA);
    await waitForQuiescence(repo, [machineA, machineB]);
    scenarioTimeline = {
      partitionHeadOffset,
      bCheckpointBefore,
      bCheckpointAfterEdits,
      dumpBeforePartitionEdits,
      dumpAfterPartitionEdits,
      aPartitionOffsets: dumpAfterPartitionEdits.slice(dumpBeforePartitionEdits.length),
      catchupOffsetSabotaged: sabotageCatchupOffset,
      catchupHeadOffset,
      reunionHeadOffset: (await repo.rawDump()).at(-1)?.offset ?? "-1",
    };
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
    const targetRoot = mutationSide === "B" ? machineB : machineA;
    const target = mutationPath === undefined ? undefined : join(targetRoot, mutationPath);
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
  if (contentOutput !== undefined) {
    const contentStreamIds = new Set(
      records.flatMap((record) => {
        const payload = record.payload;
        return payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof payload.contentStreamId === "string"
          ? [payload.contentStreamId]
          : [];
      }),
    );
    const contentRecords = [];
    for (const contentStreamId of [...contentStreamIds].sort()) {
      const streamRecords = await client.readDurableJson({
        url: `${stream.url}/streams/${encodeURIComponent(contentStreamId)}`,
      });
      contentRecords.push(...streamRecords);
    }
    mkdirSync(dirname(contentOutput), { recursive: true });
    writeFileSync(
      contentOutput,
      `${contentRecords.map((record) => canonicalJson({ ...record, ts: 0 })).join("\n")}${contentRecords.length ? "\n" : ""}`,
    );
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
  const expectedOffsetsA = records.slice(initialRecords.length).map((record) => record.offset);
  const expectedOffsetsB = sabotageCatchupOffset
    ? records.map((record) => record.offset)
    : expectedOffsetsA;
  const appliedA = assertAppliedOffsets(
    machineA,
    records,
    initialRecords.length,
    mode === "lockstep" || scenario !== undefined,
  );
  const appliedB = assertAppliedOffsets(
    machineB,
    records,
    sabotageCatchupOffset ? 0 : initialRecords.length,
    mode === "lockstep" || scenario !== undefined,
  );
  if (scenario !== undefined) {
    assertJournalBijection(machineA, expectedOffsetsA);
    assertJournalBijection(machineB, expectedOffsetsB);
  }
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
    if (process.env.EFOREST_E4_T12_DISABLE_CONFLICT_FILE === "1") {
      for (const machine of [machineA, machineB]) {
        for (const entry of readdirSync(join(machine, "docs"))) {
          if (entry.includes(".conflict-")) rmSync(join(machine, "docs", entry), { force: true });
        }
      }
    }
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
      if (sabotageConflictBytes) {
        for (const machine of [machineA, machineB]) {
          const conflictPath = join(machine, "docs", conflictFiles[0][0]);
          writeFileSync(
            conflictPath,
            Buffer.concat([readFileSync(conflictPath), Buffer.from([0])]),
          );
        }
      }
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
  if (evidenceDir !== undefined) {
    mkdirSync(evidenceDir, { recursive: true });
    cpSync(machineA, join(evidenceDir, "machine-a"), { recursive: true });
    cpSync(machineB, join(evidenceDir, "machine-b"), { recursive: true });
  }
  const transcript = canonicalTranscript({
    version: 1,
    seed,
    profile,
    mode,
    steps: transcriptSteps,
    ...(scenarioTimeline === undefined ? {} : { scenarioTimeline }),
    final: {
      digestA,
      digestB,
      replayDigest,
      ...(replayTreeFromCli === undefined ? {} : { replayTreeDigest: replayTreeFromCli }),
      appliedOffsetsA: appliedA,
      appliedOffsetsB: appliedB,
      ...(convergenceBoundMs === undefined
        ? {}
        : {
            convergenceBoundMs,
            observedConvergenceMs,
            maxConvergenceMs: Math.max(...observedConvergenceMs, 0),
          }),
    },
  });
  if (convergenceBoundMs !== undefined) {
    const maxConvergenceMs = Math.max(...observedConvergenceMs, 0);
    if (maxConvergenceMs > convergenceBoundMs)
      throw new Error(
        `convergence bound exceeded boundMs=${convergenceBoundMs} observedMs=${maxConvergenceMs}`,
      );
  }
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
  writeBrowserControl({
    phase: "done",
    harnessDone: true,
    finalHeadOffset: records.at(-1)?.offset ?? "-1",
    finalDigest: treeDigestFromRepo,
  });
  await waitForBrowserControl("browserDone", true);
  await stopWatcher(machineA);
  await stopWatcher(machineB);
  if (platformServer !== undefined) {
    await new Promise((resolveDone) => platformServer.close(() => resolveDone()));
    platformServer = undefined;
  }
  stream.child?.kill("SIGTERM");
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
