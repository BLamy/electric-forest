import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(process.cwd());
const evidenceDir = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function startServer(dataDir) {
  const child = spawn(
    process.execPath,
    ["packages/server/dist/src/bin.js", "--store=file", `--data-dir=${dataDir}`, "--port=0"],
    { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  const base = await new Promise((resolveUrl, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/LISTENING (http:\/\/[^\s]+)/);
      if (match) resolveUrl(match[1]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `file server exited before listening: code=${code} signal=${signal} stderr=${stderr}`,
        ),
      );
    });
    child.once("error", reject);
  });
  return { child, base };
}

function findServerChildren() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match &&
      match[2] === String(process.pid) &&
      match[3].includes("packages/server/dist/src/bin.js")
      ? [Number(match[1])]
      : [];
  });
}

async function killServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGKILL");
  const pids = new Set([child.pid, ...findServerChildren()].filter((pid) => pid));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      process.kill(-pid, "SIGKILL");
    } catch {
      // The child may have exited between the two kill attempts.
    }
  }
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`file server pid ${child.pid} did not exit after SIGKILL`);
  }
}

function writeLog(path, records) {
  writeFileSync(path, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
}

function replayDigest(path) {
  const result = spawn(
    process.execPath,
    ["packages/cli/dist/src/bin.js", "replay", path, "--digest"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolveDigest, reject) => {
    let stdout = "";
    let stderr = "";
    result.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    result.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    result.once("error", reject);
    result.once("exit", (code) => {
      if (code !== 0 || !/^[0-9a-f]{64}\n$/.test(stdout)) {
        reject(
          new Error(`ef replay failed for ${path}: code=${code} stdout=${stdout} stderr=${stderr}`),
        );
        return;
      }
      resolveDigest(stdout.trim());
    });
  });
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "eforest-e0-t07-restart-"));
  const evidenceTemp = mkdtempSync(join(tmpdir(), "eforest-e0-t07-evidence-"));
  let first;
  let second;
  try {
    first = await startServer(dataDir);
    const streamId = "restart";
    let response = await request(first.base, `/streams/${streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamId, durable: true }),
    });
    assert(response.status === 201, `create returned ${response.status}`);
    const batches = [
      [
        { type: "set", payload: 1, ts: 1 },
        { type: "push", payload: "two", ts: 2 },
      ],
      [{ type: "increment", payload: 3, ts: 3 }],
      [
        { type: "meta", payload: { phase: "pre-kill" }, ts: 4 },
        { type: "push", payload: "five", ts: 5 },
      ],
    ];
    const allRecords = [];
    for (const [sequence, events] of batches.entries()) {
      response = await request(first.base, `/streams/${streamId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": String(sequence) },
        body: JSON.stringify({ events }),
      });
      assert(response.status === 201, `pre-kill append ${sequence} returned ${response.status}`);
      allRecords.push(...JSON.parse(response.body).events);
    }
    const savedOffsets = [allRecords[0].offset, allRecords[2].offset, allRecords[3].offset];
    const preSuffixes = [];
    for (const offset of savedOffsets) {
      response = await request(
        first.base,
        `/${"streams"}/${streamId}?offset=${encodeURIComponent(offset)}`,
      );
      assert(response.status === 200, `pre-kill suffix ${offset} returned ${response.status}`);
      preSuffixes.push(JSON.parse(response.body));
    }
    response = await request(first.base, `/${"streams"}/${streamId}?offset=-1`);
    const preKill = JSON.parse(response.body);
    assert(preKill.length === allRecords.length, "pre-kill GET lost acknowledged records");
    await killServer(first.child);
    first = undefined;

    second = await startServer(dataDir);
    response = await request(second.base, `/${"streams"}/${streamId}?offset=-1`);
    const postRestart = JSON.parse(response.body);
    assert(
      JSON.stringify(postRestart) === JSON.stringify(preKill),
      "post-restart full log differs",
    );
    const postSuffixes = [];
    for (const [index, offset] of savedOffsets.entries()) {
      response = await request(
        second.base,
        `/${"streams"}/${streamId}?offset=${encodeURIComponent(offset)}`,
      );
      assert(response.status === 200, `post-restart suffix ${offset} returned ${response.status}`);
      const suffix = JSON.parse(response.body);
      postSuffixes.push(suffix);
      assert(
        JSON.stringify(suffix) === JSON.stringify(preSuffixes[index]),
        `suffix changed at ${offset}`,
      );
    }
    const afterRestartEvents = [{ type: "push", payload: "after-restart", ts: 6 }];
    response = await request(second.base, `/${"streams"}/${streamId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "3" },
      body: JSON.stringify({ events: afterRestartEvents }),
    });
    assert(response.status === 201, `post-restart append returned ${response.status}`);
    const afterRestartRecord = JSON.parse(response.body).events[0];
    assert(
      afterRestartRecord.offset > preKill.at(-1).offset,
      "post-restart offset did not advance",
    );
    response = await request(second.base, `/${"streams"}/${streamId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "2" },
      body: JSON.stringify({ events: [{ type: "stale", payload: true, ts: 7 }] }),
    });
    assert(response.status === 409, "stale post-restart sequence was accepted");
    assert(
      response.headers.get("stream-seq") === "3",
      "stale response reported the wrong sequence",
    );

    const paths = {
      prekill: join(evidenceTemp, "e0-t07-prekill.jsonl"),
      postrestart: join(evidenceTemp, "e0-t07-postrestart.jsonl"),
      preSuffix0: join(evidenceTemp, "e0-t07-pre-suffix-0.jsonl"),
      preSuffix1: join(evidenceTemp, "e0-t07-pre-suffix-1.jsonl"),
      preSuffix2: join(evidenceTemp, "e0-t07-pre-suffix-2.jsonl"),
      postSuffix0: join(evidenceTemp, "e0-t07-post-suffix-0.jsonl"),
      postSuffix1: join(evidenceTemp, "e0-t07-post-suffix-1.jsonl"),
      postSuffix2: join(evidenceTemp, "e0-t07-post-suffix-2.jsonl"),
    };
    writeLog(paths.prekill, preKill);
    writeLog(paths.postrestart, postRestart);
    preSuffixes.forEach((records, index) => writeLog(paths[`preSuffix${index}`], records));
    postSuffixes.forEach((records, index) => writeLog(paths[`postSuffix${index}`], records));
    const digests = {};
    for (const [name, path] of Object.entries(paths)) digests[name] = await replayDigest(path);
    assert(digests.prekill === digests.postrestart, "pre-kill/post-restart digest mismatch");
    for (let index = 0; index < savedOffsets.length; index += 1) {
      assert(
        digests[`preSuffix${index}`] === digests[`postSuffix${index}`],
        `suffix digest mismatch at ${index}`,
      );
    }
    const summary = {
      task: "E0-T07",
      savedOffsets,
      acknowledgedRecords: preKill.length,
      postRestartOffset: afterRestartRecord.offset,
      staleStatus: 409,
      digests,
    };
    const serialized = `${JSON.stringify(summary, null, 2)}\n`;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      for (const [name, path] of Object.entries(paths)) {
        writeFileSync(join(evidenceDir, path.split("/").at(-1)), readFileSync(path));
      }
      writeFileSync(
        join(evidenceDir, "e0-t07-digests.txt"),
        `${Object.entries(digests)
          .map(([name, digest]) => `${name} ${digest}`)
          .join("\n")}\n`,
      );
      writeFileSync(join(evidenceDir, "e0-t07-restart-summary.json"), serialized);
    }
    process.stdout.write(`${serialized}`);
  } finally {
    if (first) await killServer(first.child);
    if (second) await killServer(second.child);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(evidenceTemp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
