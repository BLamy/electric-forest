import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyView } from "@eforest/identity";
import { createDurableJsonStream } from "@eforest/client";
import { canonicalJson } from "@eforest/protocol";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  createPlatformServer,
  listenPlatformServer,
  OfficialStreamAdapter,
  PlatformGateway,
  UnauthorizedError,
  type AuthorizationVerifier,
} from "@eforest/platform";
import { StreamFsRepo, worktreeDigest } from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import { BASE_NONE, load as loadWorkspace, save as saveWorkspace } from "@eforest/workspace";
import { workspaceStateFromTree } from "../src/tree-materializer.js";
import { UplinkEngine } from "../src/sync/uplink.js";
import { journalLine, readJournal, type JournalRecord } from "../src/sync/journal.js";
import { runE4T06EditScript } from "../../../.eforest/tasks/epic-4-the-roots/E4-T06-uplink-local-to-stream/evidence/e4-t06-edit-script.js";

const streamServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
let streamBaseUrl: string;
let platformServer: Server;
let platformBaseUrl: string;

const token = "e4-t06-test-token";
const verifier: AuthorizationVerifier = {
  verifyAuthorization: async (header) => {
    if (header !== `Bearer ${token}`) throw new UnauthorizedError("invalid_signature");
    return { sub: "e4-t06-builder" };
  },
  authorizationContext: async (header) => {
    if (header !== `Bearer ${token}`) throw new UnauthorizedError("invalid_signature");
    return {
      principal: { kind: "identified", sub: "e4-t06-builder" },
      identity: emptyView(),
      identityOffset: "-1",
    };
  },
};

async function streamRepo(name: string): Promise<StreamFsRepo> {
  await createDurableJsonStream({
    url: `${streamBaseUrl}/streams/${encodeURIComponent(`fs:acme/${name}:main:meta`)}`,
  });
  return new StreamFsRepo(streamBaseUrl, fetch, `acme/${name}`);
}

async function waitFor(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function makeWorkspace(repo: StreamFsRepo, root: string, name: string): Promise<void> {
  const tree = await repo.tree();
  const records = await repo.rawDump();
  for (const path of Object.keys(tree.dirs)) {
    mkdirSync(join(root, ...path.split("/")), { recursive: true });
  }
  for (const path of Object.keys(tree.files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(target, await repo.readFile(path));
  }
  saveWorkspace(
    root,
    workspaceStateFromTree(
      {
        server: platformBaseUrl,
        project: "uplink",
        repo: name,
        branch: repo.branchName,
        metadataStreamId: repo.metadataStreamId,
      },
      records.at(-1)?.offset ?? "-1",
      tree,
    ),
  );
}

function journalBytes(root: string): string {
  return readFileSync(join(root, ".ef", "journal.jsonl"), "utf8");
}

function canonicalLines(values: readonly unknown[]): string {
  return values.map((value) => `${canonicalJson(value)}\n`).join("");
}

async function runBurst(name: string, debounceMs: number, gapMs: number): Promise<number> {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", `eforest-e4-t06-${name}-`));
  const root = join(scratch, "workspace");
  mkdirSync(root, { recursive: true });
  const repo = await streamRepo(name);
  let uplink: UplinkEngine | undefined;
  try {
    await repo.createFile("burst.txt", new TextEncoder().encode("base\n"));
    await makeWorkspace(repo, root, name);
    const before = (await repo.rawDump()).length;
    uplink = new UplinkEngine({
      root,
      serverUrl: platformBaseUrl,
      streamServerUrl: streamBaseUrl,
      accessToken: token,
      debounceMs,
    });
    await uplink.start();
    await waitFor(50);
    for (const value of ["one\n", "two\n", "final\n"]) {
      writeFileSync(join(root, "burst.txt"), value);
      await waitFor(gapMs);
    }
    await uplink.quiesce();
    const after = await repo.rawDump();
    return after
      .slice(before)
      .filter((record) => record.type === "fs.file.write" || record.type === "fs.file.patch")
      .length;
  } finally {
    await uplink?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("E4-T06 uplink on the published Durable Streams server", () => {
  beforeAll(async () => {
    streamBaseUrl = await streamServer.start();
    const gateway = new PlatformGateway({
      verifier,
      streams: new OfficialStreamAdapter({ baseUrl: streamBaseUrl }),
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
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      platformServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await streamServer.stop();
  });

  it("converges, journals append-only offsets, and mirrors every record", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-uplink-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("uplink");
    try {
      await repo.mkdir("docs");
      await repo.createFile("docs/base.txt", new TextEncoder().encode("base\n"));
      await repo.createFile("delete-me.txt", new TextEncoder().encode("delete\n"));
      await makeWorkspace(repo, root, "uplink");

      const emitted: string[] = [];
      const engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 35,
        onRecord: (record) => emitted.push(journalLine(record)),
      });
      await engine.start();

      const basePath = join(root, "docs/base.txt");
      writeFileSync(basePath, "base one\n");
      writeFileSync(basePath, "base two\n");
      writeFileSync(basePath, "base final\n");
      mkdirSync(join(root, "docs", "nested"));
      writeFileSync(join(root, "docs", "nested", "unicode-文件.txt"), "hello\n");
      await waitFor(80);
      const first = await engine.quiesce();
      expect(first.clean).toBe(true);

      const prefix = journalBytes(root);
      renameSync(basePath, join(root, "docs/renamed.txt"));
      rmSync(join(root, "delete-me.txt"));
      await waitFor(80);
      const second = await engine.quiesce();
      expect(second.clean).toBe(true);
      expect(journalBytes(root).startsWith(prefix)).toBe(true);

      const journal = readJournal(join(root, ".ef", "journal.jsonl"));
      const dump = await repo.rawDump();
      const accepted = journal.filter((record) => record.kind === "accepted");
      expect(accepted.length).toBeGreaterThan(0);
      expect(new Set(accepted.map((record) => record.offset)).size).toBe(accepted.length);
      for (const record of accepted) {
        const found = dump.find((candidate) => candidate.offset === record.offset);
        expect(found?.type).toBe(record.action);
        expect((found?.payload as { readonly path?: string } | undefined)?.path).toBe(record.path);
      }
      expect(emitted.join("")).toBe(journalBytes(root));
      expect(worktreeDigestDirectory(root)).toBe(worktreeDigest(await repo.tree()));
      expect(loadWorkspace(root).headOffset).toBe(dump.at(-1)?.offset);
      expect(readFileSync(join(root, "docs/renamed.txt"), "utf8")).toBe("base final\n");
      expect(readFileSync(join(root, "docs/nested/unicode-文件.txt"), "utf8")).toBe("hello\n");
      await engine.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps accepted empty-directory create and remove clean", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-empty-dir-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("empty-dir");
    let engine: UplinkEngine | undefined;
    try {
      await makeWorkspace(repo, root, "empty-dir");
      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 25,
      });
      await engine.start();

      mkdirSync(join(root, "empty"));
      await waitFor(80);
      const created = await engine.quiesce();
      expect(created.clean).toBe(true);
      expect(created.refusals).toBe(0);
      expect((await repo.rawDump()).at(-1)?.type).toBe("fs.dir.create");

      await engine.close();
      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 25,
      });
      await engine.start();
      const restarted = await engine.quiesce();
      expect(restarted.clean).toBe(true);
      expect(restarted.refusals).toBe(0);
      expect((await repo.rawDump()).at(-1)?.type).toBe("fs.dir.create");

      rmSync(join(root, "empty"), { recursive: true, force: true });
      await waitFor(80);
      const removed = await engine.quiesce();
      expect(removed.clean).toBe(true);
      expect(removed.refusals).toBe(0);
      expect((await repo.rawDump()).at(-1)?.type).toBe("fs.dir.remove");

      await engine.close();
      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 25,
      });
      await engine.start();
      const removedAfterRestart = await engine.quiesce();
      expect(removedAfterRestart.clean).toBe(true);
      expect(removedAfterRestart.refusals).toBe(0);
      expect((await repo.rawDump()).at(-1)?.type).toBe("fs.dir.remove");
    } finally {
      await engine?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reconstructs renamed empty-directory history on restart", async () => {
    const scratch = mkdtempSync(
      join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-empty-dir-rename-"),
    );
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("empty-dir-rename");
    let engine: UplinkEngine | undefined;
    try {
      await repo.mkdir("old");
      await repo.rename("old", "new");
      await makeWorkspace(repo, root, "empty-dir-rename");
      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 25,
      });
      await engine.start();

      const status = await engine.quiesce();
      expect(status.clean).toBe(true);
      expect(status.refusals).toBe(0);
      expect((await repo.rawDump()).at(-1)?.type).toBe("fs.rename");
    } finally {
      await engine?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reconstructs nested directory rename history on restart", async () => {
    const scratch = mkdtempSync(
      join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-nested-dir-rename-"),
    );
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("nested-dir-rename");
    let engine: UplinkEngine | undefined;
    try {
      await repo.mkdir("old");
      await repo.mkdir("old/nested");
      await repo.createFile("old/nested/payload.txt", new TextEncoder().encode("payload\n"));
      await repo.rename("old", "new");
      await makeWorkspace(repo, root, "nested-dir-rename");
      const before = (await repo.rawDump()).length;
      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 25,
      });
      await engine.start();

      const status = await engine.quiesce();
      expect(status.clean).toBe(true);
      expect(status.refusals).toBe(0);
      expect((await repo.rawDump()).slice(before)).toEqual([]);
      expect((await repo.tree()).files["new/nested/payload.txt"]?.size).toBe(8);
    } finally {
      await engine?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("removes nested directories deepest-first on the official server", async () => {
    const scratch = mkdtempSync(
      join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-nested-dir-remove-"),
    );
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("nested-dir-remove");
    let engine: UplinkEngine | undefined;
    try {
      await repo.mkdir("a");
      await repo.mkdir("a/b");
      await repo.createFile("a/b/payload.txt", new TextEncoder().encode("payload\n"));
      await makeWorkspace(repo, root, "nested-dir-remove");
      const before = (await repo.rawDump()).length;
      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 25,
      });
      await engine.start();

      rmSync(join(root, "a/b/payload.txt"));
      rmSync(join(root, "a/b"), { recursive: true, force: true });
      rmSync(join(root, "a"), { recursive: true, force: true });
      await waitFor(80);
      const status = await engine.quiesce();
      expect(status.clean).toBe(true);
      expect(status.refusals).toBe(0);
      expect(
        (await repo.rawDump()).slice(before).map((record) => ({
          type: record.type,
          path: (record.payload as { readonly path?: string }).path,
        })),
      ).toEqual([
        { type: "fs.file.delete", path: "a/b/payload.txt" },
        { type: "fs.dir.remove", path: "a/b" },
        { type: "fs.dir.remove", path: "a" },
      ]);
      expect((await repo.tree()).files).toEqual({});
      expect((await repo.tree()).dirs).toEqual({});
    } finally {
      await engine?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("re-derives the committed golden shape from the phase-gated edit script", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-golden-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("golden-provenance");
    let engine: UplinkEngine | undefined;
    try {
      await makeWorkspace(repo, root, "golden-provenance");
      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 20,
        now: () => 0,
      });
      await engine.start();
      await runE4T06EditScript(root, () => engine!.quiesce());

      const dump = await repo.rawDump();
      const shape = dump.map((record) => ({
        type: record.type,
        path: (record.payload as { readonly path: string }).path,
      }));
      const goldenPath = join(
        process.cwd(),
        ".eforest/tasks/epic-4-the-roots/E4-T06-uplink-local-to-stream/evidence/e4-t06-golden-shape.jsonl",
      );
      const golden = readFileSync(goldenPath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly type: string; readonly path: string });
      expect(shape).toEqual(golden);
      const journal = readJournal(join(root, ".ef", "journal.jsonl"));
      expect(journal).toHaveLength(golden.length);
      if (process.env.E4_T06_CAPTURE_EVIDENCE === "1") {
        const evidence = join(
          process.cwd(),
          ".eforest/tasks/epic-4-the-roots/E4-T06-uplink-local-to-stream/evidence",
        );
        const branchBytes = canonicalLines(dump);
        const branchPath = join(evidence, "e4-t06-branch-log.jsonl");
        mkdirSync(evidence, { recursive: true });
        writeFileSync(branchPath, branchBytes);
        writeFileSync(join(evidence, "e4-t06-journal.jsonl"), canonicalLines(journal));
        const local = spawnSync(
          process.execPath,
          [resolve(process.cwd(), "packages/cli/dist/src/bin.js"), "tree-digest", root],
          { cwd: process.cwd(), encoding: "utf8" },
        );
        expect(local.status, local.stderr).toBe(0);
        const localDigest = local.stdout.trim();
        expect(localDigest).toBe(worktreeDigestDirectory(root));
        const replayWorktree = spawnSync(
          process.execPath,
          [
            resolve(process.cwd(), "packages/cli/dist/src/bin.js"),
            "replay",
            branchPath,
            "--worktree-digest",
          ],
          { cwd: process.cwd(), encoding: "utf8" },
        );
        expect(replayWorktree.status, replayWorktree.stderr).toBe(0);
        const replayWorktreeDigest = replayWorktree.stdout.trim();
        const replayTree = spawnSync(
          process.execPath,
          [
            resolve(process.cwd(), "packages/cli/dist/src/bin.js"),
            "replay",
            branchPath,
            "--digest",
            "--reducer",
            resolve(process.cwd(), "packages/streamfs/reducer.mjs"),
          ],
          { cwd: process.cwd(), encoding: "utf8" },
        );
        expect(replayTree.status, replayTree.stderr).toBe(0);
        const replayTreeDigest = replayTree.stdout.trim();
        writeFileSync(
          join(evidence, "e4-t06-digests.txt"),
          [
            `local ef tree-digest: ${localDigest}`,
            `server ef replay --worktree-digest: ${replayWorktreeDigest}`,
            `server ef replay --digest --reducer: ${replayTreeDigest}`,
            `dump sha256: ${createHash("sha256").update(branchBytes).digest("hex")}`,
            `worktree-byte-equal: ${localDigest === replayWorktreeDigest}`,
          ].join("\n") + "\n",
        );
      }
    } finally {
      await engine?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("treats debounce width as load-bearing for the same edit burst", async () => {
    const smallWindow = await runBurst("debounce-small", 5, 70);
    const largeWindow = await runBurst("debounce-large", 120, 70);
    expect(smallWindow).toBe(3);
    expect(largeWindow).toBe(1);
  });

  it("hands inherited branch content off to a branch-owned stream", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-branch-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const main = await streamRepo("branch-uplink");
    let engine: UplinkEngine | undefined;
    try {
      const inheritedBase = "patch-seed\n".repeat(80);
      const inheritedEdit = `${"patch-seed\n".repeat(79)}patch-final\n`;
      await main.createFile("inherited.txt", new TextEncoder().encode(inheritedBase));
      await main.createBranch("feature");
      const feature = await main.openBranch("feature");
      await makeWorkspace(feature, root, "branch-uplink");
      const inherited = (await feature.tree()).files["inherited.txt"]!.contentStreamId;
      expect(inherited).toContain(":main:file:");

      engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 20,
      });
      await engine.start();
      writeFileSync(join(root, "inherited.txt"), inheritedEdit);
      const result = await engine.quiesce();
      expect(result.clean).toBe(true);

      const finalTree = await feature.tree();
      const owned = finalTree.files["inherited.txt"]!.contentStreamId;
      expect(owned).toContain(":feature:file:");
      expect(owned).not.toBe(inherited);
      expect(new TextDecoder().decode(await feature.readFile("inherited.txt"))).toBe(inheritedEdit);
      expect((await feature.rawDump()).slice(-2).map((record) => record.type)).toEqual([
        "fs.file.patch",
        "fs.file.create",
      ]);
      expect(readJournal(join(root, ".ef", "journal.jsonl"))).toHaveLength(2);
    } finally {
      await engine?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("journals a stale-base refusal, leaves the stream neutral, and keeps running", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-fence-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("fence");
    try {
      await repo.createFile("contested.txt", new TextEncoder().encode("base\n"));
      await makeWorkspace(repo, root, "fence");
      const engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 25,
      });
      await engine.start();
      const beforeForeign = await repo.rawDump();
      await repo.writeFile("contested.txt", new TextEncoder().encode("foreign\n"));
      writeFileSync(join(root, "contested.txt"), "local stale\n");
      writeFileSync(join(root, "unrelated.txt"), "accepted\n");
      await waitFor(70);
      const result = await engine.quiesce();
      expect(result.refusals).toBe(1);
      expect(result.clean).toBe(false);
      const after = await repo.rawDump();
      expect(after.length).toBe(beforeForeign.length + 3);
      const journal = readJournal(join(root, ".ef", "journal.jsonl"));
      const refused = journal.find((record) => record.kind === "refused");
      expect(refused).toMatchObject({
        kind: "refused",
        action: "fs.file.write",
        path: "contested.txt",
        conflict: { path: "contested.txt" },
      });
      expect((refused as Extract<JournalRecord, { kind: "refused" }>).conflict.actualBase).not.toBe(
        BASE_NONE,
      );
      expect(after.at(-1)?.payload).toMatchObject({ path: "unrelated.txt" });
      await engine.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("checks journal-before-ledger at the production advance hook", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-order-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await streamRepo("order");
    try {
      await repo.createFile("ordered.txt", new TextEncoder().encode("before\n"));
      await makeWorkspace(repo, root, "order");
      const old = loadWorkspace(root);
      const engine = new UplinkEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: token,
        debounceMs: 20,
        beforeLedgerAdvance: (record) => {
          const records = readJournal(join(root, ".ef", "journal.jsonl"));
          expect(records.at(-1)).toEqual(record);
          expect(loadWorkspace(root).headOffset).toBe(old.headOffset);
          throw new Error("fault-injection-before-ledger");
        },
      });
      await engine.start();
      writeFileSync(join(root, "ordered.txt"), "after\n");
      await waitFor(60);
      await expect(engine.quiesce()).rejects.toThrow("fault-injection-before-ledger");
      expect(readJournal(join(root, ".ef", "journal.jsonl")).at(-1)?.kind).toBe("accepted");
      expect(loadWorkspace(root).headOffset).toBe(old.headOffset);
      await engine.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
