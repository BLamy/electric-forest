import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHttpServer, FileStreamStore } from "../../packages/server/dist/src/index.js";
import {
  StreamFs,
  createStreamFsServerOptions,
  isBranchContentStreamId,
  resolveBranchLog,
} from "../../packages/streamfs/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = join(root, ".eforest/tasks/epic-1-the-trunk/E1-T08-branch-fork-cow/evidence");
const workRoot = join(evidence, "..", "work");
const ef = join(root, "packages/cli/dist/src/bin.js");
const reducer = join(root, "packages/streamfs/reducer.mjs");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const updateEvidence = process.argv.includes("--update-evidence");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function bytes(value) {
  return encoder.encode(value);
}

function text(value) {
  return decoder.decode(value);
}

function normalizedRecords(records) {
  return records.map((record) => ({
    offset: record.offset,
    payload: record.payload,
    ts: 0,
    type: record.type,
  }));
}

function dumpText(records) {
  return (
    normalizedRecords(records)
      .map((record) => canonicalJson(record))
      .join("\n") + "\n"
  );
}

function writeDump(path, records) {
  writeFileSync(path, dumpText(records), "utf8");
}

function dumpRecords(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split("\n").map((line) => JSON.parse(line));
}

function dumpHead(value) {
  return dumpRecords(value).at(-1)?.offset ?? "-1";
}

function textSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dumpSha256(value) {
  return textSha256(dumpText(dumpRecords(value)));
}

function writeEvidence(name, value) {
  const path = join(evidence, name);
  if (updateEvidence) {
    writeFileSync(path, value, "utf8");
    return;
  }
  check(existsSync(path), `frozen evidence is missing: ${name}`);
  check(
    readFileSync(path, "utf8") === value,
    `frozen evidence mismatch: ${name}; run with --update-evidence once`,
  );
}

function streamFiles(dataDir) {
  return new Set(readdirSync(join(dataDir, "streams")).sort());
}

function difference(after, before) {
  return [...after].filter((entry) => !before.has(entry));
}

async function startServer(dataDir) {
  const server = createHttpServer(new FileStreamStore(dataDir), createStreamFsServerOptions());
  await new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  check(address && typeof address !== "string", "branch verifier server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function rawText(baseUrl, streamId, suffix = "/dump") {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}${suffix}`);
  return { response, text: await response.text() };
}

async function createRawStream(baseUrl, streamId) {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: canonicalJson({ type: "fs-meta", version: "fs-v2" }),
  });
  check(response.ok, `could not create raw stream ${streamId}: ${response.status}`);
}

async function dispatchFork(baseUrl, streamId, parentStreamId, forkOffset) {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "fs.branch.fork",
      payload: { v: 1, parentStreamId, forkOffset },
      ts: 0,
    }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { response, body };
}

async function refusal(
  baseUrl,
  streamId,
  parentStreamId,
  forkOffset,
  reason,
  payloadParentStreamId = parentStreamId,
) {
  const parentBefore = await rawText(baseUrl, parentStreamId);
  const branchBefore = await rawText(baseUrl, streamId);
  const result = await dispatchFork(baseUrl, streamId, payloadParentStreamId, forkOffset);
  const parentAfter = await rawText(baseUrl, parentStreamId);
  const branchAfter = await rawText(baseUrl, streamId);
  check(
    result.response.status === 409,
    `${reason} stream=${streamId}: expected HTTP 409 got ${result.response.status} body=${JSON.stringify(result.body)}`,
  );
  check(result.body?.error?.class === "validator-rejected", `${reason}: wrong error class`);
  check(
    result.body?.error?.reason === reason,
    `${reason} stream=${streamId}: wrong reason got ${JSON.stringify(result.body)}`,
  );
  check(parentBefore.text === parentAfter.text, `${reason}: parent log moved`);
  check(branchBefore.text === branchAfter.text, `${reason}: branch log moved`);
  return `${reason} status=409 parent-neutral=true branch-neutral=true`;
}

function runEf(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [ef, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ pid: child.pid, status, stdout, stderr }));
  });
}

async function replay(path, options = {}) {
  const args = ["replay", path];
  for (const parent of options.parents ?? []) args.push("--parent", parent);
  if (options.until !== undefined) args.push("--until", options.until);
  if (options.emit !== undefined) args.push("--emit-log", options.emit);
  args.push("--digest");
  const result = await runEf(args);
  check(result.status === 0, `ef replay failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function bisect(a, b) {
  const result = await runEf(["bisect", a, b, "--reducer", reducer, "--stats"]);
  check(
    result.status === 1,
    `ef bisect did not report divergence: ${result.stdout}${result.stderr}`,
  );
  return { result: JSON.parse(result.stdout), stats: result.stderr.trim() };
}

function mutateModel(value, index, replacement) {
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

async function runFuzz(baseUrl, seed, evidenceLines) {
  const main = await new StreamFs({ baseUrl }).createRepo(`e1-t08-fuzz-${seed}`);
  let parentModel = `seed-${seed}-${"A".repeat(260)}`;
  await main.createFile("f.txt", bytes(parentModel));
  const fork = await main.createBranch("branch");
  const branch = await main.openBranch("branch");
  const mainBefore = await main.dump();
  const parentDigestAtFork = await main.digest();
  const branchDigestAtFork = await branch.digest();
  check(branchDigestAtFork === parentDigestAtFork, `fuzz ${seed}: fork identity mismatch`);
  let branchModel = parentModel;
  for (let round = 0; round < 40; round += 1) {
    if (round % 2 === 0) {
      const index = (round * 17 + seed.length) % 250;
      branchModel = mutateModel(branchModel, index, String.fromCharCode(66 + (round % 20)));
      await branch.writeFile("f.txt", bytes(branchModel));
    } else {
      const index = (round * 13 + seed.length) % 250;
      parentModel = mutateModel(parentModel, index, String.fromCharCode(90 - (round % 20)));
      await main.writeFile("f.txt", bytes(parentModel));
    }
    check(
      text(await branch.readFile("f.txt")) === branchModel,
      `fuzz ${seed}: branch model mismatch`,
    );
    check(
      text(await main.readFile("f.txt")) === parentModel,
      `fuzz ${seed}: parent model mismatch`,
    );
  }

  const invalidStream = `fs:e1-t08-fuzz-${seed}:bad-offset:meta`;
  await createRawStream(baseUrl, invalidStream);
  const invalid = await refusal(
    baseUrl,
    invalidStream,
    main.metadataStreamId,
    `${fork.forkOffset}0`,
    "fs/fork-offset-out-of-range",
  );

  const taskScratch = join(workRoot, `fuzz-${seed}`);
  mkdirSync(taskScratch, { recursive: true });
  const mainPath = join(taskScratch, "main.jsonl");
  const branchPath = join(taskScratch, "branch.jsonl");
  const resolvedPath = join(taskScratch, "resolved.jsonl");
  writeDump(mainPath, await main.dump());
  writeDump(branchPath, await branch.dump());
  await replay(branchPath, { parents: [mainPath], emit: resolvedPath });
  const parentPrefixCount = mainBefore.filter((record) => record.offset <= fork.forkOffset).length;
  const bisectResult = await bisect(resolvedPath, mainPath);
  const resolvedRecords = JSON.parse(
    `[${readFileSync(resolvedPath, "utf8").trim().replaceAll("\n", ",")}]`,
  );
  check(bisectResult.result.index === parentPrefixCount + 1, `fuzz ${seed}: wrong bisect index`);
  check(
    bisectResult.result.aOffset === resolvedRecords[parentPrefixCount].offset,
    `fuzz ${seed}: wrong first branch offset`,
  );
  evidenceLines.push(
    `seed=${seed} operations=40 model=independent-diff-apply parentDigestAtFork=${parentDigestAtFork} branchDigestAtFork=${branchDigestAtFork} parentDigestFinal=${await main.digest()} branchDigestFinal=${await branch.digest()} forkIdentity=true invalidOffset=${invalid} bisectIndex=${bisectResult.result.index} firstBranchOffset=${bisectResult.result.aOffset}`,
  );
}

async function main() {
  mkdirSync(evidence, { recursive: true });
  const dataDir = resolve(`${process.env.TMPDIR ?? "/tmp"}/eforest-e1-t08-${process.pid}`);
  const { server, baseUrl } = await startServer(dataDir);
  try {
    const repo = await new StreamFs({ baseUrl }).createRepo("e1-t08-golden");
    await repo.mkdir("src");
    await repo.createFile("src/shared.txt", bytes("shared-parent"));
    await repo.createFile("src/renamed.txt", bytes("rename-me"));
    await repo.createFile("src/dead.txt", bytes("tombstone-me"));
    await repo.deleteFile("src/dead.txt");
    await repo.createFile("src/branch-delete.txt", bytes("delete-parent"));
    const patchBase = `header-${"A".repeat(320)}-footer`;
    await repo.createFile("src/patched.txt", bytes(patchBase));
    await repo.writeFile("src/patched.txt", bytes(`header-B${"A".repeat(319)}-footer`));
    const parentAtFork = await repo.dump();
    const forkOffset = parentAtFork.at(-1).offset;
    const parentDigestAtFork = await repo.digest();
    const parentFilesBefore = streamFiles(dataDir);
    const parentContentIds = {
      shared: (await repo.tree()).files["src/shared.txt"].contentStreamId,
      patched: (await repo.tree()).files["src/patched.txt"].contentStreamId,
    };
    const parentContentBefore = {};
    for (const id of Object.values(parentContentIds)) {
      const contentDump = (await rawText(baseUrl, id)).text;
      parentContentBefore[id] = {
        text: contentDump,
        sha256: dumpSha256(contentDump),
        head: dumpHead(contentDump),
      };
    }

    const feature = await repo.createBranch("feature");
    const featureRepo = await repo.openBranch("feature");
    const featureFilesAfter = streamFiles(dataDir);
    const branchDelta = difference(featureFilesAfter, parentFilesBefore);
    check(branchDelta.length === 1, `fork created unexpected streams: ${branchDelta.join(",")}`);
    check((await featureRepo.dump()).length === 1, "fork metadata stream is not O(1)");
    check((await featureRepo.digest()) === parentDigestAtFork, "fork identity digest mismatch");
    check(
      text(await featureRepo.readFile("src/renamed.txt")) === "rename-me",
      "rename did not resolve",
    );
    check(!("src/dead.txt" in (await featureRepo.tree()).files), "tombstone was resurrected");
    check(
      text(await featureRepo.readFile("src/patched.txt")) === `header-B${"A".repeat(319)}-footer`,
      "pre-fork patch did not resolve",
    );

    await featureRepo.deleteFile("src/branch-delete.txt");
    check(
      !("src/branch-delete.txt" in (await featureRepo.tree()).files),
      "branch delete did not apply",
    );
    check("src/branch-delete.txt" in (await repo.tree()).files, "branch delete moved to parent");
    await featureRepo.mkdir("src/branch-dir");
    await featureRepo.createFile("src/branch-dir/created.txt", bytes("created-on-branch"));
    await featureRepo.rename("src/branch-dir", "src/renamed-dir");
    await featureRepo.deleteFile("src/renamed-dir/created.txt");
    await featureRepo.rmdir("src/renamed-dir");
    const branchMutationTypes = new Set((await featureRepo.dump()).map((record) => record.type));
    for (const type of [
      "fs.dir.create",
      "fs.file.create",
      "fs.file.delete",
      "fs.rename",
      "fs.dir.remove",
    ]) {
      check(branchMutationTypes.has(type), `branch mutation was not recorded: ${type}`);
    }
    check(
      JSON.stringify(await repo.dump()) === JSON.stringify(parentAtFork),
      "branch metadata mutation moved parent",
    );

    const parentDigestBeforeBranchEdits = await repo.digest();
    await featureRepo.writeFile("src/shared.txt", bytes("shared-feature"), { forceFull: true });
    await featureRepo.writeFile("src/patched.txt", bytes(`header-C${"A".repeat(319)}-footer`));
    const parentDigestAfterBranchEdits = await repo.digest();
    check(
      parentDigestAfterBranchEdits === parentDigestBeforeBranchEdits,
      "branch edit moved parent digest",
    );
    const featureTree = await featureRepo.tree();
    check(
      isBranchContentStreamId(featureTree.files["src/shared.txt"].contentStreamId),
      "full CoW stream is not branch-owned",
    );
    check(
      isBranchContentStreamId(featureTree.files["src/patched.txt"].contentStreamId),
      "patch CoW stream is not branch-owned",
    );
    check(
      (await featureRepo.dump()).some((record) => record.type === "fs.file.patch"),
      "branch patch event missing",
    );
    const parentForensics = [];
    for (const [id, before] of Object.entries(parentContentBefore)) {
      const after = (await rawText(baseUrl, id)).text;
      check(after === before.text, `parent content stream moved: ${id}`);
      check(dumpHead(after) === before.head, `parent content stream head moved: ${id}`);
      parentForensics.push(
        `${id} beforeSha256=${before.sha256} afterSha256=${dumpSha256(after)} beforeHead=${before.head} afterHead=${dumpHead(after)} byteIdentical=true`,
      );
    }

    const featureDigestBeforeParentEdit = await featureRepo.digest();
    await repo.writeFile("src/renamed.txt", bytes("rename-parent-after-fork"), { forceFull: true });
    await repo.writeFile("src/patched.txt", bytes(`header-Z${"A".repeat(319)}-footer`), {
      forceFull: true,
    });
    const branchDigestAfterParentEdit = await featureRepo.digest();
    check(
      branchDigestAfterParentEdit === featureDigestBeforeParentEdit,
      "parent edit moved branch digest",
    );

    const historical = await repo.createBranch("historical", { at: forkOffset });
    const historicalRepo = await repo.openBranch("historical");
    await historicalRepo.writeFile("src/patched.txt", bytes(`header-H${"A".repeat(319)}-footer`));
    check(
      text(await historicalRepo.readFile("src/patched.txt")) ===
        `header-H${"A".repeat(319)}-footer`,
      "historical patch used parent head content",
    );
    check(
      (await historicalRepo.dump()).some((record) => record.type === "fs.file.patch"),
      "historical cross-boundary patch missing",
    );
    await repo.createFile("src/after-fork.txt", bytes("invisible"));
    check(
      !("src/after-fork.txt" in (await historicalRepo.tree()).files),
      "historical fork moved with parent",
    );

    const featureDigestAtNested = await featureRepo.digest();
    const nested = await featureRepo.createBranch("nested");
    const nestedRepo = await featureRepo.openBranch("nested");
    const nestedDigestAtFork = await nestedRepo.digest();
    check(
      nestedDigestAtFork === featureDigestAtNested,
      "nested fork live identity digest mismatch",
    );
    await nestedRepo.writeFile("src/shared.txt", bytes("shared-nested"), { forceFull: true });
    await featureRepo.writeFile("src/renamed.txt", bytes("rename-feature-after-nested"), {
      forceFull: true,
    });
    check((await nestedRepo.digest()) !== nestedDigestAtFork, "nested branch edit did not diverge");
    check(
      text(await nestedRepo.readFile("src/renamed.txt")) === "rename-me",
      "nested branch followed parent after fork",
    );

    const scratch = join(workRoot, "golden");
    mkdirSync(scratch, { recursive: true });
    const paths = {
      main: join(scratch, "main.jsonl"),
      feature: join(scratch, "feature.jsonl"),
      nested: join(scratch, "nested.jsonl"),
      historical: join(scratch, "historical.jsonl"),
      mainResolved: join(scratch, "main-resolved.jsonl"),
      featureResolved: join(scratch, "feature-resolved.jsonl"),
      nestedResolved: join(scratch, "nested-resolved.jsonl"),
      historicalResolved: join(scratch, "historical-resolved.jsonl"),
    };
    writeDump(paths.main, await repo.dump());
    writeDump(paths.feature, await featureRepo.dump());
    writeDump(paths.nested, await nestedRepo.dump());
    writeDump(paths.historical, await historicalRepo.dump());
    await replay(paths.main, { emit: paths.mainResolved });
    const featureResolvedDigest = await replay(paths.feature, {
      parents: [paths.main],
      emit: paths.featureResolved,
    });
    const nestedResolvedDigest = await replay(paths.nested, {
      parents: [paths.feature, paths.main],
      emit: paths.nestedResolved,
    });
    const historicalDigest = await replay(paths.historical, {
      parents: [paths.main],
      until: forkOffset,
      emit: paths.historicalResolved,
    });
    check(
      historicalDigest === parentDigestAtFork,
      "historical replay digest differs from fork prefix",
    );
    const nestedIdentity = await replay(paths.nested, {
      parents: [paths.feature, paths.main],
      until: nested.forkOffset,
    });
    check(
      nestedIdentity === featureDigestAtNested,
      `nested fork identity digest mismatch expected=${featureDigestAtNested} actual=${nestedIdentity}`,
    );
    const identityFirst = await runEf([
      "replay",
      paths.feature,
      "--parent",
      paths.main,
      "--until",
      forkOffset,
      "--digest",
    ]);
    check(identityFirst.status === 0, "first identity process failed");
    const featureIdentity = identityFirst.stdout.trim();
    const parentIdentity = await replay(paths.main, { until: forkOffset });
    check(featureIdentity === parentIdentity, "CLI fork identity digest mismatch");
    const identitySecond = await runEf([
      "replay",
      paths.feature,
      "--parent",
      paths.main,
      "--until",
      forkOffset,
      "--digest",
    ]);
    check(
      identitySecond.status === 0 && identitySecond.stdout.trim() === featureIdentity,
      "second identity process disagreed",
    );
    check(
      identityFirst.pid !== identitySecond.pid,
      "identity checks did not use distinct processes",
    );

    const featureBisect = await bisect(paths.featureResolved, paths.mainResolved);
    const featureResolvedRecords = JSON.parse(
      `[${readFileSync(paths.featureResolved, "utf8").trim().replaceAll("\n", ",")}]`,
    );
    const parentPrefixCount = parentAtFork.filter((record) => record.offset <= forkOffset).length;
    check(featureBisect.result.index === parentPrefixCount + 1, "feature bisect did not pin N+1");
    check(
      featureBisect.result.aOffset === featureResolvedRecords[parentPrefixCount].offset,
      "feature bisect aOffset mismatch",
    );
    const nestedBisect = await bisect(paths.nestedResolved, paths.featureResolved);
    const nestedResolvedRecords = JSON.parse(
      `[${readFileSync(paths.nestedResolved, "utf8").trim().replaceAll("\n", ",")}]`,
    );
    const featureRawAtNested = (await featureRepo.dump()).filter(
      (record) => record.type !== "fs.branch.fork" && record.offset <= nested.forkOffset,
    ).length;
    const featureAtNested = parentAtFork.length + featureRawAtNested;
    check(
      nestedBisect.result.index === featureAtNested + 1,
      `nested bisect did not pin N+1 expected=${featureAtNested + 1} actual=${nestedBisect.result.index}`,
    );
    check(
      nestedBisect.result.aOffset === nestedResolvedRecords[featureAtNested].offset,
      "nested bisect aOffset mismatch",
    );

    const refusalLines = [];
    await createRawStream(baseUrl, "fs:e1-t08-golden:missing-parent:meta");
    refusalLines.push(
      await refusal(
        baseUrl,
        "fs:e1-t08-golden:missing-parent:meta",
        repo.metadataStreamId,
        forkOffset,
        "fs/parent-not-found",
        "fs:e1-t08-golden:no-such:meta",
      ),
    );
    for (const [name, offset] of [
      ["offset-before", "-1"],
      ["offset-future", `${forkOffset}0`],
      ["offset-gap", `${parentAtFork[0].offset}0`],
    ]) {
      const streamId = `fs:e1-t08-golden:${name}:meta`;
      await createRawStream(baseUrl, streamId);
      refusalLines.push(
        await refusal(
          baseUrl,
          streamId,
          repo.metadataStreamId,
          offset,
          "fs/fork-offset-out-of-range",
        ),
      );
    }
    for (const branchName of ["", "main", "a:b", "file"]) {
      const streamId = `fs:e1-t08-golden:${branchName}:meta`;
      if (branchName !== "main") await createRawStream(baseUrl, streamId);
      refusalLines.push(
        await refusal(
          baseUrl,
          streamId,
          repo.metadataStreamId,
          forkOffset,
          "fs/invalid-branch-name",
        ),
      );
    }
    const manual = "fs:e1-t08-golden:manual:meta";
    await createRawStream(baseUrl, manual);
    const manualDir = await fetch(`${baseUrl}/streams/${encodeURIComponent(manual)}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fs.dir.create", payload: { v: 2, path: "manual" }, ts: 0 }),
    });
    check(manualDir.status === 201, "manual non-fork setup was refused");
    refusalLines.push(
      await refusal(baseUrl, manual, repo.metadataStreamId, forkOffset, "fs/fork-not-first-event"),
    );
    refusalLines.push(
      await refusal(
        baseUrl,
        feature.streamId,
        repo.metadataStreamId,
        forkOffset,
        "fs/branch-exists",
      ),
    );
    const cycleRecord = {
      offset: "0000000000000000_0000000000000000",
      payload: { v: 1, parentStreamId: "cycle", forkOffset: "0000000000000000_0000000000000000" },
      ts: 0,
      type: "fs.branch.fork",
    };
    let cycleRejected = false;
    try {
      resolveBranchLog([
        { streamId: "cycle", records: [cycleRecord] },
        { streamId: "cycle", records: [cycleRecord] },
        { streamId: "cycle", records: [cycleRecord] },
      ]);
    } catch (error) {
      cycleRejected = error?.code === "branch/cycle";
    }
    check(cycleRejected, "resolver cycle sabotage was not rejected");

    const fuzzLines = [];
    for (const seed of ["alpha", "bravo", "charlie", "delta", "echo"]) {
      await runFuzz(baseUrl, seed, fuzzLines);
    }

    const goldenFiles = [
      ["e1-t08-golden-main.jsonl", paths.main],
      ["e1-t08-golden-feature.jsonl", paths.feature],
      ["e1-t08-golden-nested.jsonl", paths.nested],
      ["e1-t08-golden-historical.jsonl", paths.historical],
    ];
    for (const [name, source] of goldenFiles) writeEvidence(name, readFileSync(source, "utf8"));
    writeEvidence(
      "e1-t08-fork-identity.txt",
      `parentStreamId=${repo.metadataStreamId}\nforkOffset=${forkOffset}\nparentDigestAtFork=${parentIdentity}\nbranchDigestAtFork=${featureIdentity}\nidentityProcesses=distinct\n`,
    );
    writeEvidence(
      "e1-t08-independence.txt",
      `parentDigestBeforeBranchEdits=${parentDigestBeforeBranchEdits}\nparentDigestAfterBranchEdits=${parentDigestAfterBranchEdits}\nbranchDigestBeforeParentEdit=${featureDigestBeforeParentEdit}\nbranchDigestAfterParentEdit=${branchDigestAfterParentEdit}\npatchCrossBoundary=true\n`,
    );
    writeEvidence("e1-t08-parent-forensics.txt", `${parentForensics.join("\n")}\n`);
    writeEvidence(
      "e1-t08-bisect.txt",
      `feature index=${featureBisect.result.index} aOffset=${featureBisect.result.aOffset} kind=${featureBisect.result.kind}\nnested index=${nestedBisect.result.index} aOffset=${nestedBisect.result.aOffset} kind=${nestedBisect.result.kind}\n${featureBisect.stats}\n${nestedBisect.stats}\n`,
    );
    const chainArtifact = `${JSON.stringify(
      {
        links: [
          {
            branch: "feature",
            parentStreamId: repo.metadataStreamId,
            forkOffset,
            parentDigestAtFork: parentIdentity,
            branchDigestAtFork: featureIdentity,
            firstDivergentIndex: featureBisect.result.index,
            firstDivergentOffset: featureBisect.result.aOffset,
          },
          {
            branch: "nested",
            parentStreamId: featureRepo.metadataStreamId,
            forkOffset: nested.forkOffset,
            parentDigestAtFork: featureDigestAtNested,
            branchDigestAtFork: nestedIdentity,
            firstDivergentIndex: nestedBisect.result.index,
            firstDivergentOffset: nestedBisect.result.aOffset,
          },
        ],
        twoParentResolutionDigest: nestedResolvedDigest,
      },
      null,
      2,
    )}\n`;
    writeEvidence("e1-t08-chain.txt", chainArtifact);
    writeEvidence("e1-t08-refusal-neutrality.txt", `${refusalLines.join("\n")}\n`);
    writeEvidence("e1-t08-fuzz.txt", `${fuzzLines.join("\n")}\ntotalOperations=200\n`);
    writeEvidence(
      "e1-t08-golden.expected.json",
      `${JSON.stringify(
        {
          fsEnvelopeVersion: 2,
          chain: [
            {
              branch: "feature",
              parentStreamId: repo.metadataStreamId,
              forkOffset,
              parentDigestAtFork: parentIdentity,
              branchDigestAtFork: featureIdentity,
              firstDivergentIndex: featureBisect.result.index,
              firstDivergentOffset: featureBisect.result.aOffset,
            },
            {
              branch: "nested",
              parentStreamId: featureRepo.metadataStreamId,
              forkOffset: nested.forkOffset,
              parentDigestAtFork: featureDigestAtNested,
              branchDigestAtFork: nestedIdentity,
              firstDivergentIndex: nestedBisect.result.index,
              firstDivergentOffset: nestedBisect.result.aOffset,
            },
          ],
          finalParentDigest: await repo.digest(),
          finalBranchDigest: nestedResolvedDigest,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `branch-fork golden identity=${featureIdentity} featureBisect=${featureBisect.result.index} nestedBisect=${nestedBisect.result.index} fuzzSeeds=5 fuzzOperations=200 refusalNeutrality=OK`,
    );
  } finally {
    await stopServer(server);
  }
}

await main();
