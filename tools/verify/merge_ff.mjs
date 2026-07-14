import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHttpServer, FileStreamStore } from "../../packages/server/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  StreamFs,
  createStreamFsServerOptions,
  mergeFastForward,
} from "../../packages/streamfs/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = join(root, ".eforest/tasks/epic-1-the-trunk/E1-T09-fast-forward-merge/evidence");
const updateEvidence = process.argv.includes("--update-evidence");
const encoder = new TextEncoder();

function dumpText(records) {
  return `${records.map((record) => canonicalJson({ ...record, ts: 0 })).join("\n")}\n`;
}

function frozen(name, value) {
  const path = join(evidence, name);
  if (updateEvidence) {
    writeFileSync(path, value, "utf8");
    return;
  }
  if (!existsSync(path) || readFileSync(path, "utf8") !== value) {
    throw new Error(`frozen evidence mismatch: ${name}`);
  }
}

async function startServer(dataDir) {
  const server = createHttpServer(new FileStreamStore(dataDir), createStreamFsServerOptions());
  await new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("merge verifier server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function main() {
  mkdirSync(evidence, { recursive: true });
  const dataDir = resolve(`${process.env.TMPDIR ?? "/tmp"}/eforest-e1-t09-${process.pid}`);
  const { server, baseUrl } = await startServer(dataDir);
  try {
    const repo = await new StreamFs({ baseUrl }).createRepo("e1-t09-golden");
    await repo.mkdir("src");
    await repo.createFile("src/a.txt", encoder.encode("main"));
    const preMergeTarget = await repo.dump();
    const preMergeTargetDigest = await repo.digest();
    await repo.createBranch("feature");
    const source = await repo.openBranch("feature");
    await source.writeFile("src/a.txt", encoder.encode("feature"), { forceFull: true });
    const sourceRecords = await source.dump();
    const sourceDigest = await source.digest();
    const sourceBefore = dumpText(sourceRecords);
    const receipt = await mergeFastForward(repo, source);
    const mergedTarget = await repo.dump();
    const mergedDigest = await repo.digest();
    if (mergedTarget.length !== preMergeTarget.length + 1)
      throw new Error("merge was not one event");
    if (mergedTarget.at(-1)?.type !== "fs.branch.merge") throw new Error("merge event missing");
    if (mergedDigest !== sourceDigest || receipt.treeDigest !== sourceDigest) {
      throw new Error(`merged digest mismatch target=${mergedDigest} source=${sourceDigest}`);
    }
    if (dumpText(await source.dump()) !== sourceBefore) throw new Error("source stream changed");

    frozen("golden-merged-target.jsonl", dumpText(mergedTarget));
    frozen("golden-source.jsonl", sourceBefore);
    frozen("golden-premerge-target.jsonl", dumpText(preMergeTarget));
    frozen("golden-merged.digest", `${mergedDigest}\n`);
    frozen("golden-merge-offset.txt", `${receipt.mergeOffset}\n`);
    frozen(
      "golden-expected.json",
      `${JSON.stringify(
        {
          fsEnvelopeVersion: 2,
          forkOffset: mergedTarget.at(-1).payload.forkOffset,
          mergedThroughOffset: mergedTarget.at(-1).payload.mergedThroughOffset,
          mergeOffset: receipt.mergeOffset,
          preMergeTargetDigest,
          sourceResolvedDigest: sourceDigest,
          postMergeTargetDigest: mergedDigest,
        },
        null,
        2,
      )}\n`,
    );

    const refusalRepo = await new StreamFs({ baseUrl }).createRepo("e1-t09-refusal");
    await refusalRepo.createFile("a.txt", encoder.encode("main"));
    await refusalRepo.createBranch("feature");
    const refusalSource = await refusalRepo.openBranch("feature");
    await refusalSource.writeFile("a.txt", encoder.encode("feature"), { forceFull: true });
    await refusalRepo.writeFile("a.txt", encoder.encode("advanced"), { forceFull: true });
    const refusalBefore = dumpText(await refusalRepo.dump());
    let refusalReason = "";
    try {
      await mergeFastForward(refusalRepo, refusalSource);
    } catch (error) {
      refusalReason = error?.body?.error?.reason ?? "";
    }
    if (refusalReason !== "fs/merge-not-fast-forward")
      throw new Error(`wrong refusal ${refusalReason}`);
    const refusalAfter = dumpText(await refusalRepo.dump());
    if (refusalBefore !== refusalAfter) throw new Error("refused merge moved target log");
    frozen("refusal-before.jsonl", refusalBefore);
    frozen("refusal-after.jsonl", refusalAfter);
    console.log(
      `merge-ff golden mergeOffset=${receipt.mergeOffset} digest=${mergedDigest} sourceInvariant=true refusalNeutrality=true`,
    );
  } finally {
    await stopServer(server);
  }
}

await main();
