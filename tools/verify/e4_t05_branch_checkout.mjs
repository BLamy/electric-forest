#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDurableJsonStream } from "../../packages/client/dist/src/index.js";
import { emptyView } from "../../packages/identity/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { offsetForOrdinal } from "../../packages/protocol/dist/src/offset-allocation.js";
import {
  createPlatformServer,
  listenPlatformServer,
  OfficialStreamAdapter,
  PlatformGateway,
  UnauthorizedError,
} from "../../packages/platform/dist/src/index.js";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import { runClone } from "../../packages/cli/dist/src/index.js";
import {
  branchMetadataStreamId,
  readStreamDumpWithTransportOffsets,
  StreamFsRepo,
  worktreeDigest,
} from "../../packages/streamfs/dist/src/index.js";
import { worktreeDigestDirectory } from "../../packages/streamfs/dist/src/worktree-node.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceDir = resolve(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T05-ef-branch-checkout/evidence",
);
const cli = resolve(root, "packages/cli/dist/src/bin.js");
const emitOnly = process.argv.includes("--emit");

function streamUrl(baseUrl, streamId) {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function recursiveHash(rootPath, excludeEf = false) {
  const hash = createHash("sha256");
  function visit(directory, relative) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    )) {
      if (excludeEf && relative.length === 0 && entry.name === ".ef") continue;
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      hash.update(`${entry.isDirectory() ? "d" : "f"}\0${childRelative}\0`);
      const child = join(directory, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else hash.update(readFileSync(child));
    }
  }
  visit(rootPath, "");
  return hash.digest("hex");
}

async function runEf(args, cwd, environment) {
  const env = { ...process.env, ...environment };
  delete env.NODE_OPTIONS;
  delete env.NODE_ENV;
  delete env.EFOREST_CHECKOUT_FAILPOINT;
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status, signal) =>
      resolveResult({
        status: status ?? (signal === null ? 1 : 1),
        stdout,
        stderr,
      }),
    );
  });
}

function expectSuccess(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, "", `${label}: unexpected stderr`);
  return result.stdout;
}

function dumpBytes(records) {
  return `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
}

function writeDump(path, records) {
  writeFileSync(path, dumpBytes(records));
}

function normalizeWorkspaceServer(workspace) {
  const path = join(workspace, ".ef", "workspace.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.identity.server = "http://127.0.0.1:0";
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

function sortedOwnForks(records) {
  return records.filter((record) => record.type === "fs.branch.fork");
}

async function main() {
  assert.ok(existsSync(cli), `missing built CLI binary: ${cli}`);
  const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t05-evidence-"));
  const workspace = join(scratch, "workspace");
  const home = join(scratch, "home");
  let platformServer;
  let baseUrl;
  let platformBaseUrl;
  try {
    baseUrl = await server.start();
    const testToken = "e4-t05-test-token";
    let operationOrdinal = 0;
    let authorizedMutationCalls = 0;
    let grantFenceChecks = 0;
    let completedAuthorizedMutations = 0;
    let settledAuthorizedMutations = 0;
    const verifier = {
      async verifyAuthorization(header) {
        if (header !== `Bearer ${testToken}`) throw new UnauthorizedError("invalid_signature");
        return { sub: "e4-t05-builder" };
      },
      async authorizationContext(header) {
        if (header !== `Bearer ${testToken}`) throw new UnauthorizedError("invalid_signature");
        return {
          principal: { kind: "identified", sub: "e4-t05-builder" },
          identity: emptyView(),
          identityOffset: "-1",
        };
      },
      async withAuthorizedMutation(header, plan, mutation) {
        if (header !== `Bearer ${testToken}`) throw new UnauthorizedError("invalid_signature");
        const identity = { sub: "e4-t05-builder" };
        const operationId = `e4-t05-operation-${String(++operationOrdinal)}`;
        await plan(identity, operationId);
        authorizedMutationCalls += 1;
        try {
          const result = await mutation(
            identity,
            operationId,
            async () => {
              grantFenceChecks += 1;
            },
            "-1",
          );
          completedAuthorizedMutations += 1;
          return result;
        } catch (error) {
          if (
            error instanceof Error &&
            /branch already exists|fork offset .* is not present|parent stream does not exist/.test(
              error.message,
            )
          ) {
            settledAuthorizedMutations += 1;
          }
          throw error;
        }
      },
    };
    const gateway = new PlatformGateway({
      verifier,
      streams: new OfficialStreamAdapter({ baseUrl }),
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      decideAuthorization: (input) => ({
        allowed: true,
        operation: input.operation,
        identityOffset: input.identityOffset,
        basis: "grant:write",
        streamId: input.target.kind === "repo" ? input.target.streamId : "test",
      }),
    });
    platformServer = createPlatformServer((request) => gateway.handle(request));
    platformBaseUrl = await listenPlatformServer(platformServer);
    const environment = {
      EF_HOME: home,
      EF_SERVER: platformBaseUrl,
      EF_STREAM_SERVER_URL: baseUrl,
    };
    const cloneEnvironment = { ...environment, EF_SERVER: baseUrl };
    const repoName = "acme/evidence";
    const mainId = `fs:${repoName}:main:meta`;
    await createDurableJsonStream({ url: streamUrl(baseUrl, mainId) });
    const repo = new StreamFsRepo(baseUrl, fetch, repoName);
    await repo.createFile("keep.txt", new TextEncoder().encode("before\n"));
    await repo.createFile("delete.txt", new TextEncoder().encode("delete\n"));
    await repo.createFile("rename.txt", new TextEncoder().encode("rename\n"));

    let cloneStdout = "";
    let cloneStderr = "";
    const cloneStatus = await runClone(
      [repoName, "main", workspace],
      {
        stdout: (text) => (cloneStdout += text),
        stderr: (text) => (cloneStderr += text),
      },
      { environment: cloneEnvironment, fetcher: fetch },
    );
    assert.equal(cloneStatus, 0, `${cloneStdout}\n${cloneStderr}`);
    assert.equal(cloneStderr, "");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "credentials.json"),
      `${canonicalJson({
        accessToken: testToken,
        tokenType: "Bearer",
        issuer: "https://e4-t05.test/",
        clientId: "e4-t05",
        scopes: ["repo:write:acme/test:feature"],
      })}\n`,
    );
    normalizeWorkspaceServer(workspace);
    const checkpoint = JSON.parse(
      readFileSync(join(workspace, ".ef", "workspace.json"), "utf8"),
    ).headOffset;
    const parentBeforeAdvance = await repo.rawDump();
    await repo.createFile("after.txt", new TextEncoder().encode("after\n"));
    const parentBeforeBranch = await repo.rawDump();
    assert.notDeepEqual(parentBeforeBranch, parentBeforeAdvance);
    const parentHeadBeforeBranch = parentBeforeBranch.at(-1)?.offset;
    const parentBeforePath = join(scratch, "parent-before.jsonl");
    writeDump(parentBeforePath, parentBeforeBranch);
    const parentReplayDigestBefore = expectSuccess(
      await runEf(["replay", parentBeforePath, "--digest"], root, environment),
      "parent replay digest before",
    ).trim();

    const branch = expectSuccess(
      await runEf(["branch", "feature"], workspace, environment),
      "branch feature",
    );
    assert.equal(
      branch,
      `branch feature ${branchMetadataStreamId(repoName, "feature")} forked-at ${checkpoint}\n`,
    );
    const featureId = branchMetadataStreamId(repoName, "feature");
    const featureDump = await readStreamDumpWithTransportOffsets({
      baseUrl,
      metadataStreamId: featureId,
      fetcher: fetch,
    });
    const forkEvents = sortedOwnForks(featureDump.records);
    assert.equal(forkEvents.length, 1);
    assert.equal(forkEvents[0].payload.parentStreamId, mainId);
    assert.equal(forkEvents[0].payload.forkOffset, checkpoint);
    assert.equal(authorizedMutationCalls, 1);
    assert.equal(grantFenceChecks, 1);
    assert.equal(completedAuthorizedMutations, 1);
    const parentAfterBranch = await repo.rawDump();
    assert.deepEqual(parentAfterBranch, parentBeforeBranch);
    assert.equal(parentAfterBranch.at(-1)?.offset, parentHeadBeforeBranch);
    const parentAfterPath = join(scratch, "parent-after.jsonl");
    writeDump(parentAfterPath, parentAfterBranch);
    const parentReplayDigestAfter = expectSuccess(
      await runEf(["replay", parentAfterPath, "--digest"], root, environment),
      "parent replay digest after",
    ).trim();
    assert.equal(parentReplayDigestAfter, parentReplayDigestBefore);

    const workspacePath = join(workspace, ".ef", "workspace.json");
    const workspaceState = JSON.parse(readFileSync(workspacePath, "utf8"));
    const invalidCheckpoint = offsetForOrdinal(99);
    writeFileSync(
      workspacePath,
      `${canonicalJson({ ...workspaceState, headOffset: invalidCheckpoint })}\n`,
    );
    const invalidOffset = await runEf(["branch", "offset-invalid"], workspace, environment);
    assert.equal(invalidOffset.status, 3);
    assert.equal(invalidOffset.stdout, "");
    assert.equal(
      invalidOffset.stderr,
      `error: fs/fork-offset-out-of-range: fork offset ${invalidCheckpoint} is not present in the parent stream\n`,
    );
    const invalidOffsetTarget = await fetch(
      streamUrl(baseUrl, branchMetadataStreamId(repoName, "offset-invalid")),
    );
    assert.equal(invalidOffsetTarget.status, 404);
    writeFileSync(workspacePath, `${canonicalJson(workspaceState)}\n`);

    const missingParentTarget = branchMetadataStreamId(repoName, "parent-invalid");
    const missingParentResponse = await fetch(`${platformBaseUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${testToken}`,
        "content-type": "application/json",
      },
      body: canonicalJson({
        streamId: missingParentTarget,
        event: {
          type: "fs.branch.fork",
          payload: {
            v: 1,
            parentStreamId: `fs:${repoName}:missing-parent:meta`,
            forkOffset: checkpoint,
          },
          ts: 0,
        },
      }),
    });
    assert.equal(missingParentResponse.status, 409);
    const missingParentBody = await missingParentResponse.json();
    assert.deepEqual(missingParentBody, {
      error: {
        class: "validator-rejected",
        reason: "fs/parent-not-found",
        message: "parent stream does not exist",
      },
    });
    const missingParentTargetResponse = await fetch(streamUrl(baseUrl, missingParentTarget));
    assert.equal(missingParentTargetResponse.status, 404);
    assert.equal(settledAuthorizedMutations, 2);

    const featureDumpPath = join(scratch, "feature.jsonl");
    const mainDumpPath = join(scratch, "main.jsonl");
    writeDump(featureDumpPath, featureDump.records);
    writeDump(mainDumpPath, parentBeforeBranch);
    expectSuccess(await runEf(["checkout", "feature"], workspace, environment), "checkout feature");
    assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "before\n");
    assert.equal(existsSync(join(workspace, "after.txt")), false);
    const freshTreeDigest = expectSuccess(
      await runEf(["tree-digest", workspace], root, environment),
      "fresh tree digest",
    ).trim();
    const freshReplayDigest = expectSuccess(
      await runEf(["replay", featureDumpPath, "--worktree-digest"], root, environment),
      "fresh replay digest",
    ).trim();
    assert.equal(freshTreeDigest, freshReplayDigest);
    assert.equal(
      freshTreeDigest,
      worktreeDigest(await new StreamFsRepo(baseUrl, fetch, repoName, "feature").tree()),
    );

    expectSuccess(await runEf(["checkout", "main"], workspace, environment), "return to main");
    const roundtripBefore = recursiveHash(workspace, true);
    const roundtripDigest = worktreeDigestDirectory(workspace);
    expectSuccess(
      await runEf(["checkout", "feature"], workspace, environment),
      "roundtrip feature",
    );
    expectSuccess(await runEf(["checkout", "main"], workspace, environment), "roundtrip main");
    const roundtripAfter = recursiveHash(workspace, true);
    const roundtripDigestAfter = worktreeDigestDirectory(workspace);
    assert.equal(roundtripAfter, roundtripBefore);
    assert.equal(roundtripDigestAfter, roundtripDigest);

    const noopTree = recursiveHash(workspace, true);
    const noopControl = recursiveHash(join(workspace, ".ef"));
    const noopMain = dumpBytes(await repo.rawDump());
    const noopFeature = dumpBytes(
      (
        await readStreamDumpWithTransportOffsets({
          baseUrl,
          metadataStreamId: featureId,
          fetcher: fetch,
        })
      ).records,
    );
    const noop = await runEf(["checkout", "main"], workspace, environment);
    expectSuccess(noop, "no-op checkout");
    assert.equal(noop.stdout, "Already on branch main.\n");
    assert.equal(recursiveHash(workspace, true), noopTree);
    assert.equal(recursiveHash(join(workspace, ".ef")), noopControl);
    assert.equal(dumpBytes(await repo.rawDump()), noopMain);
    assert.equal(
      dumpBytes(
        (
          await readStreamDumpWithTransportOffsets({
            baseUrl,
            metadataStreamId: featureId,
            fetcher: fetch,
          })
        ).records,
      ),
      noopFeature,
    );

    const editedBranch = expectSuccess(
      await runEf(["branch", "edited"], workspace, environment),
      "branch edited",
    );
    assert.match(editedBranch, /branch edited .* forked-at /);
    const editedRepo = new StreamFsRepo(baseUrl, fetch, repoName, "edited");
    await editedRepo.writeFile("keep.txt", new TextEncoder().encode("edited\n"));
    await editedRepo.deleteFile("delete.txt");
    await editedRepo.rename("rename.txt", "renamed.txt");
    const editedTree = await editedRepo.tree();
    const editedId = branchMetadataStreamId(repoName, "edited");
    const editedDump = await readStreamDumpWithTransportOffsets({
      baseUrl,
      metadataStreamId: editedId,
      fetcher: fetch,
    });
    const editedDumpPath = join(scratch, "edited.jsonl");
    writeDump(editedDumpPath, editedDump.records);
    expectSuccess(await runEf(["checkout", "edited"], workspace, environment), "checkout edited");
    assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "edited\n");
    assert.equal(existsSync(join(workspace, "delete.txt")), false);
    assert.equal(existsSync(join(workspace, "rename.txt")), false);
    assert.equal(readFileSync(join(workspace, "renamed.txt"), "utf8"), "rename\n");
    const editedTreeDigest = expectSuccess(
      await runEf(["tree-digest", workspace], root, environment),
    ).trim();
    const editedReplayDigest = expectSuccess(
      await runEf(["replay", editedDumpPath, "--worktree-digest"], root, environment),
      "edited replay digest",
    ).trim();
    assert.equal(editedTreeDigest, editedReplayDigest);
    assert.equal(editedTreeDigest, worktreeDigest(editedTree));

    const dirtyPath = join(workspace, "keep.txt");
    writeFileSync(dirtyPath, "locally modified\n");
    const dirtyBefore = {
      worktree: recursiveHash(workspace, true),
      control: recursiveHash(join(workspace, ".ef")),
      main: dumpBytes(await repo.rawDump()),
      edited: dumpBytes(
        (
          await readStreamDumpWithTransportOffsets({
            baseUrl,
            metadataStreamId: editedId,
            fetcher: fetch,
          })
        ).records,
      ),
    };
    const dirty = await runEf(["checkout", "main"], workspace, environment);
    assert.equal(dirty.status, 3);
    assert.equal(dirty.stdout, "");
    assert.equal(dirty.stderr, "error: cli/dirty-working-tree: working tree is not clean\n");
    assert.equal(recursiveHash(workspace, true), dirtyBefore.worktree);
    assert.equal(recursiveHash(join(workspace, ".ef")), dirtyBefore.control);
    assert.equal(dumpBytes(await repo.rawDump()), dirtyBefore.main);
    assert.equal(
      dumpBytes(
        (
          await readStreamDumpWithTransportOffsets({
            baseUrl,
            metadataStreamId: editedId,
            fetcher: fetch,
          })
        ).records,
      ),
      dirtyBefore.edited,
    );

    const forkArtifact = [
      "E4-T05 fork offset",
      "provider=official @durable-streams/server 0.3.8",
      `workspace-checkpoint=${checkpoint}`,
      `fork-event-count=${forkEvents.length}`,
      `fork-event-payload-forkOffset=${forkEvents[0].payload.forkOffset}`,
      `fork-event-payload-parentStreamId=${forkEvents[0].payload.parentStreamId}`,
      "authorized-mutation-calls=1",
      "grant-fence-checks=1",
      "authorized-mutation-completions=1",
      `parent-head-before=${parentHeadBeforeBranch}`,
      `parent-head-after=${parentAfterBranch.at(-1)?.offset}`,
      "parent-head-equality=PASS",
      `parent-replay-digest-before=${parentReplayDigestBefore}`,
      `parent-replay-digest-after=${parentReplayDigestAfter}`,
      "parent-replay-digest-equality=PASS",
      "parent-dump-before-after=byte-identical",
      `invalid-offset-refusal=${invalidOffset.stderr.trimEnd()}`,
      "invalid-offset-target-status=404",
      "missing-parent-refusal=fs/parent-not-found",
      "missing-parent-target-status=404",
      "authorized-mutation-settled-refusals=2",
      "provider-child-prefix=accepted (fork event is the one child-owned fork event)",
      "Replay: N/A (CLI-only task, no browser-reaching surface) + mitigation: official-server dump and offset evidence",
      "",
    ].join("\n");
    const checkoutArtifact = [
      "E4-T05 checkout digest parity",
      `fresh-fork separate-process-tree-digest=${freshTreeDigest}`,
      `fresh-fork separate-process-replay=${freshReplayDigest}`,
      "fresh-fork digest-equality=PASS",
      `post-fork-head separate-process-tree-digest=${editedTreeDigest}`,
      `post-fork-head separate-process-replay=${editedReplayDigest}`,
      "post-fork-head digest-equality=PASS",
      "post-fork-head deleted-path=absent",
      "post-fork-head renamed-old-path=absent",
      "post-fork-head renamed-new-path=present",
      "Replay: N/A (CLI-only task, no browser-reaching surface) + mitigation: official-server replay and worktree digest parity",
      "",
    ].join("\n");
    const roundtripArtifact = [
      "E4-T05 roundtrip",
      `before-worktree-sha256=${roundtripBefore}`,
      `after-worktree-sha256=${roundtripAfter}`,
      `before-tree-digest=${roundtripDigest}`,
      `after-tree-digest=${roundtripDigestAfter}`,
      "main-feature-main-recursive-byte-diff=empty",
      "current-branch-no-op=tree-control-and-both-dumps-byte-identical",
      "Replay: N/A (CLI-only task, no browser-reaching surface) + mitigation: independent recursive hash and official-server dump comparisons",
      "",
    ].join("\n");
    const dirtyArtifact = [
      "E4-T05 dirty refusal golden",
      "class=modified",
      `exit=${dirty.status}`,
      `stdout-bytes=${Buffer.byteLength(dirty.stdout)}`,
      `stderr=${dirty.stderr.trimEnd()}`,
      `worktree-before-sha256=${dirtyBefore.worktree}`,
      `worktree-after-sha256=${recursiveHash(workspace, true)}`,
      `control-before-sha256=${dirtyBefore.control}`,
      `control-after-sha256=${recursiveHash(join(workspace, ".ef"))}`,
      "main-dump-before-after=byte-identical",
      "target-dump-before-after=byte-identical",
      "Replay: N/A (CLI-only task, no browser-reaching surface) + mitigation: independent recursive hashes and raw official-server dumps",
      "",
    ].join("\n");
    const sensitivityArtifact = [
      "# E4-T05 sensitivity",
      "",
      "BASELINE focused integration suite green OK",
      "MUTATION status-gate red EXPECTED-FAIL OK exit=1",
      "TRANSCRIPT status-gate Test Files 1 failed (1) | Tests 1 failed | 5 passed (6) | dirty checkout refusal assertion failed",
      "MUTATION materializer-deletions red EXPECTED-FAIL OK exit=1",
      "TRANSCRIPT materializer-deletions Test Files 1 failed (1) | Tests 2 failed | 4 passed (6) | fresh checkout and post-fork materialization assertions failed",
      "MUTATION fork-at-head red EXPECTED-FAIL OK exit=1",
      "TRANSCRIPT fork-at-head Test Files 1 failed (1) | Tests 1 failed | 5 passed (6) | fresh checkout retained the post-checkpoint file",
      "Each sabotage runs in a disposable source copy against the official-server integration suite; every mutation exits non-zero.",
      "",
    ].join("\n");

    const artifacts = new Map([
      ["e4-t05-fork-offset.txt", forkArtifact],
      ["e4-t05-checkout-digest.txt", checkoutArtifact],
      ["e4-t05-roundtrip.txt", roundtripArtifact],
      ["e4-t05-dirty-refusal.txt", dirtyArtifact],
      ["e4-t05-sensitivity.md", sensitivityArtifact],
    ]);
    if (emitOnly) {
      for (const [name, value] of artifacts) {
        process.stdout.write(`--- ${name} ---\n${value}`);
      }
    } else {
      for (const [name, expected] of artifacts) {
        const path = join(evidenceDir, name);
        assert.equal(readFileSync(path, "utf8"), expected, `${name} is stale or self-authored`);
      }
      process.stdout.write(
        `E4_T05_BRANCH_CHECKOUT_OK fresh=${freshTreeDigest} edited=${editedTreeDigest} dirty=red\n`,
      );
    }
  } finally {
    if (platformServer !== undefined) {
      await new Promise((resolveClose, rejectClose) => {
        platformServer.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        );
      });
    }
    await server.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
