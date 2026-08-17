import { appendDurableJson, createDurableJsonStream, readDurableJson } from "@eforest/client";
import { canonicalJson, sha256Hex, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import { worktreeDigest } from "@eforest/streamfs";
import { save as saveWorkspace, type WorkspaceState } from "@eforest/workspace";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyWorkingTree } from "./classify.js";
import { runStatus } from "./status.js";

const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
let serverUrl: string;

function file(content: string): { readonly contentSha256: string; readonly size: number } {
  const bytes = Buffer.from(content, "utf8");
  return { contentSha256: sha256Hex(bytes), size: bytes.byteLength };
}

function workspace(
  root: string,
  streamId: string,
  headOffset: Offset,
  files: WorkspaceState["files"],
): void {
  saveWorkspace(root, {
    v: 1,
    identity: {
      server: "http://127.0.0.1",
      project: "project",
      repo: "repo",
      branch: "main",
      metadataStreamId: streamId,
    },
    headOffset,
    files,
  });
}

async function capture(
  args: readonly string[],
  dependencies: Parameters<typeof runStatus>[2] = {},
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const status = await runStatus(
    args,
    { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    dependencies,
  );
  return { status, stdout, stderr };
}

describe("ef status classification", () => {
  it("classifies content changes, additions, deletions, mtime-only touches, and UTF-8 order", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-classify-"));
    const originalMtime = new Date("2020-01-01T00:00:00.000Z");
    try {
      const base = {
        "same-size.txt": { ...file("abcd"), base: "BASE_NONE" },
        "delete.txt": { ...file("gone"), base: "BASE_NONE" },
        "clean.txt": { ...file("same"), base: "BASE_NONE" },
        "é.txt": { ...file("unicode"), base: "BASE_NONE" },
      };
      await writeFile(join(root, "same-size.txt"), "wxyz");
      await writeFile(join(root, "clean.txt"), "same");
      await writeFile(join(root, "é.txt"), "unicode");
      await writeFile(join(root, "added.txt"), "new");
      await writeFile(join(root, ".txt"), "bmp");
      await writeFile(join(root, "𐀀.txt"), "astral");
      await utimes(join(root, "clean.txt"), originalMtime, originalMtime);
      workspace(root, "fs:project/repo:main:meta", "-1" as Offset, base);

      expect(
        classifyWorkingTree(root, {
          v: 1,
          identity: {
            server: "http://127.0.0.1",
            project: "project",
            repo: "repo",
            branch: "main",
            metadataStreamId: "fs:project/repo:main:meta",
          },
          headOffset: "-1",
          files: base,
        }),
      ).toEqual({
        added: ["added.txt", ".txt", "𐀀.txt"],
        deleted: ["delete.txt"],
        modified: ["same-size.txt"],
        clean: ["clean.txt", "é.txt"],
        conflicted: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a rename as a deletion plus an addition and handles an empty ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-rename-"));
    try {
      await writeFile(join(root, "new.txt"), "same bytes");
      const renamed = {
        "old.txt": { ...file("same bytes"), base: "BASE_NONE" },
      };
      const result = classifyWorkingTree(root, {
        v: 1,
        identity: {
          server: "http://127.0.0.1",
          project: "project",
          repo: "repo",
          branch: "main",
          metadataStreamId: "fs:project/repo:main:meta",
        },
        headOffset: "-1",
        files: renamed,
      });
      expect(result).toEqual({
        added: ["new.txt"],
        deleted: ["old.txt"],
        modified: [],
        clean: [],
        conflicted: [],
      });

      await rm(join(root, "new.txt"));
      expect(
        classifyWorkingTree(root, {
          v: 1,
          identity: {
            server: "http://127.0.0.1",
            project: "project",
            repo: "repo",
            branch: "main",
            metadataStreamId: "fs:project/repo:main:meta",
          },
          headOffset: "-1",
          files: {},
        }),
      ).toEqual({ added: [], deleted: [], modified: [], clean: [], conflicted: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports conflict files separately from ordinary working-tree changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-conflict-"));
    try {
      const conflictFile = "docs/readme.md.conflict-0002";
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, conflictFile), "loser");
      workspace(root, "fs:project/repo:main:meta", "-1" as Offset, {});
      const result = await capture(["--json", "--offline"], {
        cwd: root,
        environment: { EF_HOME: join(root, "no-credentials") },
        fetcher: async () => {
          throw new Error("offline status attempted a network request");
        },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        v: 2,
        clean: false,
        paths: {
          added: [],
          deleted: [],
          modified: [],
          conflicted: [{ path: "docs/readme.md", conflictFile, offset: "0002" }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects appended and truncated bytes as content changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-size-"));
    try {
      const original = Buffer.from("abcdef", "utf8");
      const base = { "data.bin": { ...file(original.toString("utf8")), base: "BASE_NONE" } };
      await writeFile(join(root, "data.bin"), Buffer.concat([original, Buffer.from("!", "utf8")]));
      const ledger = {
        v: 1 as const,
        identity: {
          server: "http://127.0.0.1",
          project: "project",
          repo: "repo",
          branch: "main",
          metadataStreamId: "fs:project/repo:main:meta",
        },
        headOffset: "-1",
        files: base,
      } satisfies WorkspaceState;
      expect(classifyWorkingTree(root, ledger).modified).toEqual(["data.bin"]);
      await writeFile(join(root, "data.bin"), original.subarray(0, original.length - 1));
      expect(classifyWorkingTree(root, ledger).modified).toEqual(["data.bin"]);
      await writeFile(join(root, "data.bin"), original);
      expect(classifyWorkingTree(root, ledger).clean).toEqual(["data.bin"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits one canonical offline JSON line from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-offline-"));
    try {
      const bytes = file("hello");
      await writeFile(join(root, "hello.txt"), "hello");
      workspace(root, "fs:project/repo:main:meta", "-1" as Offset, {
        "hello.txt": { ...bytes, base: "BASE_NONE" },
      });
      const result = await capture(["--json", "--offline"], {
        cwd: join(root, "nested", "deeper"),
        environment: { EF_HOME: join(root, "no-credentials") },
        fetcher: async () => {
          throw new Error("offline status attempted a network request");
        },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(result.stdout).toBe(`${canonicalJson(parsed)}\n`);
      expect(parsed).toMatchObject({
        v: 2,
        branch: "main",
        streamId: "fs:project/repo:main:meta",
        checkpointOffset: "-1",
        headOffset: null,
        behindBy: null,
        clean: true,
        paths: { added: [], deleted: [], modified: [], conflicted: [] },
      });
      expect(parsed.baseTreeDigest).toBe(worktreeDigest({ files: { "hello.txt": bytes } }));
      expect(parsed.workingTreeDigest).toBe(parsed.baseTreeDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("probes exact application events after the saved checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-online-"));
    const streamId = "fs:project/status-online:main:meta";
    try {
      const content = "hello";
      await writeFile(join(root, "hello.txt"), content);
      const metadata = file(content);
      const checkpoint = offsetForOrdinal(0);
      workspace(root, streamId, checkpoint, {
        "hello.txt": { ...metadata, base: checkpoint },
      });
      await createDurableJsonStream({
        url: `${serverUrl}/streams/${encodeURIComponent(streamId)}`,
      });
      for (const ordinal of [0, 1, 2]) {
        const offset = offsetForOrdinal(ordinal);
        await appendDurableJson(
          { url: `${serverUrl}/streams/${encodeURIComponent(streamId)}` },
          { offset, type: "fs.branch.genesis", payload: { v: 1, branch: "main" }, ts: ordinal },
          offset,
        );
      }
      const result = await capture(["--json"], {
        cwd: root,
        environment: { EF_STREAM_SERVER_URL: serverUrl, EF_HOME: join(root, "home") },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        checkpointOffset: checkpoint,
        headOffset: offsetForOrdinal(2),
        behindBy: 2,
        clean: true,
      });
      const workspaceBytes = await readFile(join(root, ".ef", "workspace.json"));
      const fileBytes = await readFile(join(root, "hello.txt"));
      const streamRecords = await readDurableJson({
        url: `${serverUrl}/streams/${encodeURIComponent(streamId)}`,
      });
      const after = await capture(["--json", "--offline"], { cwd: root });
      expect(await readFile(join(root, ".ef", "workspace.json"))).toEqual(workspaceBytes);
      expect(await readFile(join(root, "hello.txt"))).toEqual(fileBytes);
      expect(
        await readDurableJson({ url: `${serverUrl}/streams/${encodeURIComponent(streamId)}` }),
      ).toEqual(streamRecords);
      expect(JSON.parse(after.stdout)).toMatchObject({ headOffset: null, behindBy: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps local status identical offline and refuses a stopped online server", async () => {
    const localServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const localUrl = await localServer.start();
    let stopped = false;
    const root = await mkdtemp(join(tmpdir(), "eforest-status-offline-equivalence-"));
    const streamId = "fs:project/status-offline:main:meta";
    try {
      const checkpoint = offsetForOrdinal(0);
      const files = {
        "keep.txt": { ...file("keep"), base: checkpoint },
        "delete.txt": { ...file("delete"), base: checkpoint },
      };
      await writeFile(join(root, "keep.txt"), "keep");
      await writeFile(join(root, "delete.txt"), "delete");
      workspace(root, streamId, checkpoint, files);
      const url = `${localUrl}/streams/${encodeURIComponent(streamId)}`;
      await createDurableJsonStream({ url });
      await appendDurableJson(
        { url },
        { offset: checkpoint, type: "fs.branch.genesis", payload: { v: 1, branch: "main" }, ts: 0 },
        checkpoint,
      );
      const clean = await capture(["--json"], {
        cwd: root,
        environment: { EF_STREAM_SERVER_URL: localUrl, EF_HOME: join(root, "home") },
      });
      expect(clean.status).toBe(0);

      const modified = Buffer.from("keep");
      modified[0] = modified[0]! ^ 1;
      await writeFile(join(root, "keep.txt"), modified);
      await writeFile(join(root, "added.txt"), "");
      await rm(join(root, "delete.txt"));
      const online = await capture(["--json"], {
        cwd: root,
        environment: { EF_STREAM_SERVER_URL: localUrl, EF_HOME: join(root, "home") },
      });
      const offline = await capture(["--json", "--offline"], { cwd: root });
      expect(online.status).toBe(0);
      expect(offline.status).toBe(0);
      const onlineJson = JSON.parse(online.stdout) as Record<string, unknown>;
      const offlineJson = JSON.parse(offline.stdout) as Record<string, unknown>;
      expect(offlineJson).toEqual({ ...onlineJson, headOffset: null, behindBy: null });

      await localServer.stop();
      stopped = true;
      const refused = await capture(["--json"], {
        cwd: root,
        environment: { EF_STREAM_SERVER_URL: localUrl, EF_HOME: join(root, "home") },
        timeoutMs: 100,
      });
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toMatch(/^status\/head-probe-failed:/);
    } finally {
      if (!stopped) await localServer.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps stdout empty for malformed workspaces and bounds an unreachable head", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-errors-"));
    try {
      await mkdir(join(root, ".ef"));
      await writeFile(join(root, ".ef", "workspace.json"), "{\n", "utf8");
      const malformed = await capture(["--json", "--offline"], { cwd: root });
      expect(malformed.status).not.toBe(0);
      expect(malformed.stdout).toBe("");
      expect(malformed.stderr).toMatch(/^status\/workspace-invalid:/);

      await writeFile(join(root, ".ef", "workspace.json"), "not-used");
      const missing = await capture(["--json", "--offline"], { cwd: join(root, "missing") });
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toBe("");

      const onlineRoot = await mkdtemp(join(tmpdir(), "eforest-status-timeout-"));
      try {
        await writeFile(join(onlineRoot, "file.txt"), "x");
        workspace(onlineRoot, "fs:project/unreachable:main:meta", "-1" as Offset, {
          "file.txt": { ...file("x"), base: "BASE_NONE" },
        });
        const started = Date.now();
        const timeout = await capture(["--json"], {
          cwd: onlineRoot,
          environment: {
            EF_STREAM_SERVER_URL: "http://unreachable.invalid",
            EF_HOME: join(onlineRoot, "home"),
          },
          fetcher: () => new Promise<Response>(() => undefined),
          timeoutMs: 25,
        });
        expect(timeout.status).not.toBe(0);
        expect(timeout.stdout).toBe("");
        expect(timeout.stderr).toMatch(/^status\/head-probe-failed:/);
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        await rm(onlineRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses every committed E4-T01 ledger refusal fixture with empty stdout", async () => {
    const fixtureDirectory = fileURLToPath(
      new URL(
        "../../../.eforest/tasks/epic-4-the-roots/E4-T01-worktree-digest-and-ef-format/evidence/ef-fixtures/",
        import.meta.url,
      ),
    );
    for (const name of ["truncated", "extra-field", "v2", "wrong-type", "duplicate-ledger-key"]) {
      const root = await mkdtemp(join(tmpdir(), `eforest-status-refusal-${name}-`));
      try {
        await mkdir(join(root, ".ef"));
        await writeFile(
          join(root, ".ef", "workspace.json"),
          await readFile(join(fixtureDirectory, `${name}.json`)),
        );
        const result = await capture(["--json", "--offline"], { cwd: root });
        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toMatch(/^status\/workspace-invalid:/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses a missing workspace and unknown flags without stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-status-usage-"));
    try {
      const missing = await capture(["--json", "--offline"], { cwd: root });
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toMatch(/^status\/workspace-not-found:/);
      const unknown = await capture(["--bogus"], { cwd: root });
      expect(unknown.status).toBe(2);
      expect(unknown.stdout).toBe("");
      expect(unknown.stderr).toBe("status/usage: Usage: ef status [--json] [--offline]\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

beforeAll(async () => {
  serverUrl = await server.start();
});

afterAll(async () => {
  await server.stop();
});
