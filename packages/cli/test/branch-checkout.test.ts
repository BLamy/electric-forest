import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendDurableJson, createDurableJsonStream } from "@eforest/client";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  branchMetadataStreamId,
  readStreamDumpWithTransportOffsets,
  StreamFsRepo,
  worktreeDigest,
} from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import { load as loadWorkspace } from "@eforest/workspace";
import { runBranch, runCheckout } from "../src/branch-checkout-command.js";
import {
  checkoutMarkerPath,
  removeCheckoutMarker,
  writeCheckoutMarker,
} from "../src/checkout-marker.js";
import { runClone } from "../src/clone-command.js";
import { runStatus } from "../src/status.js";

const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
let baseUrl: string;

function streamUrl(streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function environment(home: string): NodeJS.ProcessEnv {
  return {
    EF_HOME: join(home, "home"),
    EF_SERVER: baseUrl,
    EF_STREAM_SERVER_URL: baseUrl,
  };
}

function ioCapture(): {
  readonly io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
  readonly output: () => { readonly stdout: string; readonly stderr: string };
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    output: () => ({ stdout, stderr }),
  };
}

function repoMetadataId(repo: string): string {
  return `fs:acme/${repo}:main:meta`;
}

async function makeRepo(repo: string): Promise<StreamFsRepo> {
  const metadataStreamId = repoMetadataId(repo);
  await createDurableJsonStream({ url: streamUrl(metadataStreamId) });
  return new StreamFsRepo(baseUrl, fetch, `acme/${repo}`);
}

function recursiveHash(root: string, excludeEf = false): string {
  const hash = createHash("sha256");
  function visit(directory: string, relative: string): void {
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
  visit(root, "");
  return hash.digest("hex");
}

async function cloneWorkspace(repo: string, root: string, home: string): Promise<void> {
  const captured = ioCapture();
  const status = await runClone([`acme/${repo}`, "main", root], captured.io, {
    environment: environment(home),
  });
  expect(status).toBe(0);
  expect(captured.output().stderr).toBe("");
}

describe("ef branch and checkout on the official Durable Streams server", () => {
  beforeAll(async () => {
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("forks at the workspace checkpoint and round-trips a clean checkout", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t05-"));
    const workspace = join(scratch, "workspace");
    try {
      const repo = await makeRepo("branch-roundtrip");
      await repo.createFile("before.txt", new TextEncoder().encode("before\n"));
      const parentBefore = JSON.stringify(await repo.rawDump());
      await cloneWorkspace("branch-roundtrip", workspace, scratch);
      const checkpoint = loadWorkspace(workspace).headOffset;
      await repo.createFile("after.txt", new TextEncoder().encode("after\n"));
      const parentBeforeBranch = JSON.stringify(await repo.rawDump());
      expect(parentBeforeBranch).not.toBe(parentBefore);

      const branchCapture = ioCapture();
      const branchStatus = await runBranch(["feature"], branchCapture.io, {
        cwd: workspace,
        environment: environment(scratch),
      });
      expect(branchStatus).toBe(0);
      expect(branchCapture.output().stderr).toBe("");
      expect(branchCapture.output().stdout).toBe(
        `branch feature ${branchMetadataStreamId("acme/branch-roundtrip", "feature")} forked-at ${checkpoint}\n`,
      );

      const branchId = branchMetadataStreamId("acme/branch-roundtrip", "feature");
      const branchDump = await readStreamDumpWithTransportOffsets({
        baseUrl,
        metadataStreamId: branchId,
        fetcher: fetch,
      });
      const fork = branchDump.records.find((record) => record.type === "fs.branch.fork");
      expect(fork?.payload).toEqual({
        v: 1,
        parentStreamId: repoMetadataId("branch-roundtrip"),
        forkOffset: checkpoint,
      });
      expect(JSON.stringify(await repo.rawDump())).toBe(parentBeforeBranch);

      const checkoutCapture = ioCapture();
      const checkoutStatus = await runCheckout(["feature"], checkoutCapture.io, {
        cwd: workspace,
        environment: environment(scratch),
      });
      expect(checkoutStatus).toBe(0);
      expect(checkoutCapture.output().stderr).toBe("");
      expect(readFileSync(join(workspace, "before.txt"), "utf8")).toBe("before\n");
      expect(existsSync(join(workspace, "after.txt"))).toBe(false);

      const featureRepo = new StreamFsRepo(baseUrl, fetch, "acme/branch-roundtrip", "feature");
      expect(worktreeDigestDirectory(workspace)).toBe(worktreeDigest(await featureRepo.tree()));

      const backCapture = ioCapture();
      const backStatus = await runCheckout(["main"], backCapture.io, {
        cwd: workspace,
        environment: environment(scratch),
      });
      expect(backStatus).toBe(0);
      expect(backCapture.output().stderr).toBe("");
      expect(existsSync(join(workspace, "after.txt"))).toBe(true);

      const beforeRoundTrip = recursiveHash(workspace, true);
      const toFeature = ioCapture();
      expect(
        await runCheckout(["feature"], toFeature.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);
      const toMain = ioCapture();
      expect(
        await runCheckout(["main"], toMain.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);
      expect(recursiveHash(workspace, true)).toBe(beforeRoundTrip);

      const noopBeforeTree = recursiveHash(workspace, true);
      const noopBeforeControl = recursiveHash(join(workspace, ".ef"));
      const noopBeforeMainDump = JSON.stringify(await repo.rawDump());
      const noopBeforeFeatureDump = JSON.stringify(await featureRepo.rawDump());
      const noopCapture = ioCapture();
      expect(
        await runCheckout(["main"], noopCapture.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);
      expect(noopCapture.output().stdout).toBe("Already on branch main.\n");
      expect(recursiveHash(workspace, true)).toBe(noopBeforeTree);
      expect(recursiveHash(join(workspace, ".ef"))).toBe(noopBeforeControl);
      expect(JSON.stringify(await repo.rawDump())).toBe(noopBeforeMainDump);
      expect(JSON.stringify(await featureRepo.rawDump())).toBe(noopBeforeFeatureDump);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses a dirty checkout and typed command errors without stdout", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t05-refusal-"));
    const workspace = join(scratch, "workspace");
    try {
      const repo = await makeRepo("branch-refusal");
      await repo.createFile("file.txt", new TextEncoder().encode("clean\n"));
      await cloneWorkspace("branch-refusal", workspace, scratch);
      const branchCapture = ioCapture();
      expect(
        await runBranch(["feature"], branchCapture.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);
      const featureRepo = new StreamFsRepo(baseUrl, fetch, "acme/branch-refusal", "feature");
      const dirt = [
        {
          name: "modified",
          apply: () => writeFileSync(join(workspace, "file.txt"), "modified\n"),
          restore: () => writeFileSync(join(workspace, "file.txt"), "clean\n"),
        },
        {
          name: "added",
          apply: () => writeFileSync(join(workspace, "added.txt"), "added\n"),
          restore: () => rmSync(join(workspace, "added.txt"), { force: true }),
        },
        {
          name: "deleted",
          apply: () => rmSync(join(workspace, "file.txt")),
          restore: () => writeFileSync(join(workspace, "file.txt"), "clean\n"),
        },
        {
          name: "renamed",
          apply: () => renameSync(join(workspace, "file.txt"), join(workspace, "renamed.txt")),
          restore: () => renameSync(join(workspace, "renamed.txt"), join(workspace, "file.txt")),
        },
        {
          name: "untracked",
          apply: () => writeFileSync(join(workspace, "untracked.txt"), "untracked\n"),
          restore: () => rmSync(join(workspace, "untracked.txt"), { force: true }),
        },
      ] as const;
      for (const dirty of dirt) {
        dirty.apply();
        const before = {
          tree: recursiveHash(workspace, true),
          control: recursiveHash(join(workspace, ".ef")),
          mainDump: JSON.stringify(await repo.rawDump()),
          featureDump: JSON.stringify(await featureRepo.rawDump()),
        };
        const dirtyCapture = ioCapture();
        expect(
          await runCheckout(["feature"], dirtyCapture.io, {
            cwd: workspace,
            environment: environment(scratch),
          }),
          dirty.name,
        ).toBe(3);
        expect(dirtyCapture.output(), dirty.name).toEqual({
          stdout: "",
          stderr: "error: cli/dirty-working-tree: working tree is not clean\n",
        });
        expect(recursiveHash(workspace, true), dirty.name).toBe(before.tree);
        expect(recursiveHash(join(workspace, ".ef")), dirty.name).toBe(before.control);
        expect(JSON.stringify(await repo.rawDump()), dirty.name).toBe(before.mainDump);
        expect(JSON.stringify(await featureRepo.rawDump()), dirty.name).toBe(before.featureDump);
        dirty.restore();
      }

      const usage = ioCapture();
      expect(await runCheckout([], usage.io)).toBe(2);
      expect(usage.output()).toEqual({
        stdout: "",
        stderr: "Usage: ef checkout <branch>\n",
      });

      const missing = ioCapture();
      expect(
        await runCheckout(["missing"], missing.io, {
          cwd: join(scratch, "no-workspace"),
          environment: environment(scratch),
        }),
      ).toBe(3);
      expect(missing.output().stdout).toBe("");
      expect(missing.output().stderr).toMatch(/^error: cli\/not-a-workspace: /);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("materializes post-fork writes, deletions, and renames at the target head", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t05-head-"));
    const workspace = join(scratch, "workspace");
    try {
      const repo = await makeRepo("branch-head");
      await repo.createFile("keep.txt", new TextEncoder().encode("before\n"));
      await repo.createFile("delete.txt", new TextEncoder().encode("remove me\n"));
      await repo.createFile("rename.txt", new TextEncoder().encode("move me\n"));
      await cloneWorkspace("branch-head", workspace, scratch);
      const branch = ioCapture();
      expect(
        await runBranch(["feature"], branch.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);

      const featureRepo = new StreamFsRepo(baseUrl, fetch, "acme/branch-head", "feature");
      await featureRepo.writeFile("keep.txt", new TextEncoder().encode("after\n"));
      await featureRepo.deleteFile("delete.txt");
      await featureRepo.rename("rename.txt", "renamed.txt");
      const expectedTree = await featureRepo.tree();

      const checkout = ioCapture();
      expect(
        await runCheckout(["feature"], checkout.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);
      expect(checkout.output().stderr).toBe("");
      expect(readFileSync(join(workspace, "keep.txt"), "utf8")).toBe("after\n");
      expect(existsSync(join(workspace, "delete.txt"))).toBe(false);
      expect(existsSync(join(workspace, "rename.txt"))).toBe(false);
      expect(readFileSync(join(workspace, "renamed.txt"), "utf8")).toBe("move me\n");
      expect(worktreeDigestDirectory(workspace)).toBe(worktreeDigest(expectedTree));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("pins branch-exists, unknown-branch, invalid-name, usage, and journal refusals", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t05-typed-"));
    const workspace = join(scratch, "workspace");
    try {
      const repo = await makeRepo("branch-typed");
      await repo.createFile("file.txt", new TextEncoder().encode("clean\n"));
      await cloneWorkspace("branch-typed", workspace, scratch);
      const cleanEnvironment = environment(scratch);
      const first = ioCapture();
      expect(
        await runBranch(["feature"], first.io, {
          cwd: workspace,
          environment: cleanEnvironment,
        }),
      ).toBe(0);

      const beforeMain = JSON.stringify(await repo.rawDump());
      const duplicate = ioCapture();
      expect(
        await runBranch(["feature"], duplicate.io, {
          cwd: workspace,
          environment: cleanEnvironment,
        }),
      ).toBe(3);
      expect(duplicate.output()).toEqual({
        stdout: "",
        stderr: "error: fs/branch-exists: branch already exists\n",
      });
      expect(JSON.stringify(await repo.rawDump())).toBe(beforeMain);

      const invalid = ioCapture();
      expect(
        await runBranch(["bad.name"], invalid.io, {
          cwd: workspace,
          environment: cleanEnvironment,
        }),
      ).toBe(3);
      expect(invalid.output()).toEqual({
        stdout: "",
        stderr: 'error: fs/invalid-branch-name: invalid branch name "bad.name"\n',
      });

      const branchUsage = ioCapture();
      expect(await runBranch([], branchUsage.io)).toBe(2);
      expect(branchUsage.output()).toEqual({
        stdout: "",
        stderr: "Usage: ef branch <name>\n",
      });

      const missing = ioCapture();
      expect(
        await runCheckout(["missing"], missing.io, {
          cwd: workspace,
          environment: cleanEnvironment,
        }),
      ).toBe(3);
      expect(missing.output()).toEqual({
        stdout: "",
        stderr: "error: cli/unknown-branch: branch was not found\n",
      });

      writeCheckoutMarker(workspace, {
        v: 1,
        branch: "feature",
        offset: loadWorkspace(workspace).headOffset,
      });
      expect(existsSync(checkoutMarkerPath(workspace))).toBe(true);
      const interruptedCheckout = ioCapture();
      expect(
        await runCheckout(["feature"], interruptedCheckout.io, {
          cwd: workspace,
          environment: cleanEnvironment,
        }),
      ).toBe(3);
      expect(interruptedCheckout.output()).toEqual({
        stdout: "",
        stderr: "error: cli/interrupted-checkout: checkout journal is present\n",
      });
      const interruptedBranch = ioCapture();
      expect(
        await runBranch(["other"], interruptedBranch.io, {
          cwd: workspace,
          environment: cleanEnvironment,
        }),
      ).toBe(3);
      expect(interruptedBranch.output()).toEqual(interruptedCheckout.output());
      const interruptedStatus = ioCapture();
      expect(
        await runStatus([], interruptedStatus.io, {
          cwd: workspace,
          environment: cleanEnvironment,
        }),
      ).toBe(3);
      expect(interruptedStatus.output()).toEqual(interruptedCheckout.output());
      removeCheckoutMarker(workspace);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("leaves the journal when an injected failure interrupts the commit", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t05-journal-"));
    const workspace = join(scratch, "workspace");
    try {
      const repo = await makeRepo("branch-journal");
      await repo.createFile("file.txt", new TextEncoder().encode("clean\n"));
      await cloneWorkspace("branch-journal", workspace, scratch);
      const branch = ioCapture();
      expect(
        await runBranch(["feature"], branch.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);
      const interrupted = ioCapture();
      expect(
        await runCheckout(["feature"], interrupted.io, {
          cwd: workspace,
          environment: {
            ...environment(scratch),
            EFOREST_CHECKOUT_FAILPOINT: "before-workspace-save",
          },
        }),
      ).toBe(3);
      expect(interrupted.output()).toEqual({
        stdout: "",
        stderr: "error: cli/checkout-integrity: injected checkout failure before workspace save\n",
      });
      expect(existsSync(checkoutMarkerPath(workspace))).toBe(true);
      const status = ioCapture();
      expect(
        await runStatus([], status.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(3);
      expect(status.output()).toEqual({
        stdout: "",
        stderr: "error: cli/interrupted-checkout: checkout journal is present\n",
      });
      removeCheckoutMarker(workspace);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects an invalid replay path before changing the tree", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t05-unsafe-"));
    const workspace = join(scratch, "workspace");
    try {
      const repo = await makeRepo("branch-unsafe");
      await repo.createFile("file.txt", new TextEncoder().encode("clean\n"));
      await cloneWorkspace("branch-unsafe", workspace, scratch);
      const branch = ioCapture();
      expect(
        await runBranch(["feature"], branch.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(0);
      const branchId = branchMetadataStreamId("acme/branch-unsafe", "feature");
      const dump = await readStreamDumpWithTransportOffsets({
        baseUrl,
        metadataStreamId: branchId,
        fetcher: fetch,
      });
      const invalidOffset = offsetForOrdinal(dump.records.length);
      await appendDurableJson(
        { url: streamUrl(branchId) },
        {
          offset: invalidOffset,
          type: "fs.file.create",
          payload: {
            v: 2,
            path: "../escape.txt",
            contentStreamId: "fs:acme/branch-unsafe:feature:file:escape",
          },
          ts: 0,
        },
        invalidOffset,
      );
      const beforeTree = recursiveHash(workspace, true);
      const beforeControl = recursiveHash(join(workspace, ".ef"));
      const beforeBranch = JSON.stringify(
        (
          await readStreamDumpWithTransportOffsets({
            baseUrl,
            metadataStreamId: branchId,
            fetcher: fetch,
          })
        ).records,
      );
      const checkout = ioCapture();
      expect(
        await runCheckout(["feature"], checkout.io, {
          cwd: workspace,
          environment: environment(scratch),
        }),
      ).toBe(3);
      expect(checkout.output()).toEqual({
        stdout: "",
        stderr: expect.stringMatching(/^error: cli\/unsafe-path: /),
      });
      expect(recursiveHash(workspace, true)).toBe(beforeTree);
      expect(recursiveHash(join(workspace, ".ef"))).toBe(beforeControl);
      expect(
        JSON.stringify(
          (
            await readStreamDumpWithTransportOffsets({
              baseUrl,
              metadataStreamId: branchId,
              fetcher: fetch,
            })
          ).records,
        ),
      ).toBe(beforeBranch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
