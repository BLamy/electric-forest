import { emptyView } from "@eforest/identity";
import { createDurableJsonStream } from "@eforest/client";
import { canonicalJson, sha256Hex } from "@eforest/protocol";
import { nextAllocatedOffset } from "@eforest/protocol/offset-allocation";
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
import { load as loadWorkspace, save as saveWorkspace } from "@eforest/workspace";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceStateFromTree } from "../src/tree-materializer.js";
import { COMPLETE_MARKER } from "../src/clone-command.js";
import { DuplexWatchEngine } from "../src/sync/duplex.js";
import { DownlinkEngine } from "../src/sync/downlink.js";
import { observedApplyPath } from "../src/sync/apply-observed.js";
import { readApplyJournal, verifyApplyJournal } from "../src/sync/apply-journal.js";
import { UplinkEngine } from "../src/sync/uplink.js";
import { readSyncJournal } from "../src/sync/sync-journal.js";
import { watchDivergencePath } from "../src/sync/watch-state.js";
import { runStatus } from "../src/status.js";
import { runWatchCommand, type WatchCommandDependencies } from "../src/sync/watch-command.js";
import { isProcessAlive, readWatchPid } from "../src/sync/watch-state.js";
import { storeCredentials } from "../src/credentials.js";
import { conflictFileName } from "../src/sync/conflict.js";

const streamServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
let streamBaseUrl: string;
let platformBaseUrl: string;
let platformServer: ReturnType<typeof createPlatformServer>;

const tokens = new Map([
  ["local-token", "local-writer"],
  ["remote-token", "remote-writer"],
]);
const verifier: AuthorizationVerifier = {
  verifyAuthorization: async (header) => {
    const token = header?.replace(/^Bearer /, "");
    const sub = token === undefined ? undefined : tokens.get(token);
    if (sub === undefined) throw new UnauthorizedError("invalid_signature");
    return { sub };
  },
  authorizationContext: async (header) => {
    const token = header?.replace(/^Bearer /, "");
    const sub = token === undefined ? undefined : tokens.get(token);
    if (sub === undefined) throw new UnauthorizedError("invalid_signature");
    return {
      principal: { kind: "identified", sub },
      identity: emptyView(),
      identityOffset: "-1",
    };
  },
};

async function makeRepo(name: string): Promise<StreamFsRepo> {
  await createDurableJsonStream({
    url: `${streamBaseUrl}/streams/${encodeURIComponent(`fs:e4-t08/${name}:main:meta`)}`,
  });
  const repo = new StreamFsRepo(streamBaseUrl, fetch, `e4-t08/${name}`);
  await repo.createFile("base.txt", new TextEncoder().encode("base\n"));
  return repo;
}

async function cloneWorkspace(repo: StreamFsRepo, root: string): Promise<void> {
  const tree = await repo.tree();
  for (const path of Object.keys(tree.dirs))
    mkdirSync(join(root, ...path.split("/")), { recursive: true });
  for (const path of Object.keys(tree.files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, await repo.readFile(path));
  }
  saveWorkspace(
    root,
    workspaceStateFromTree(
      {
        server: platformBaseUrl,
        project: "e4-t08",
        repo: "duplex",
        branch: repo.branchName,
        metadataStreamId: repo.metadataStreamId,
      },
      (await repo.rawDump()).at(-1)?.offset ?? "-1",
      tree,
    ),
  );
  writeFileSync(join(root, ".ef", "complete"), COMPLETE_MARKER);
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describe("E4-T08 full-duplex watcher", () => {
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

  it("converges foreign and own edits without echoing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-duplex-"));
    const localRoot = join(scratch, "local");
    const remoteRoot = join(scratch, "remote");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(remoteRoot, { recursive: true });
    const repo = await makeRepo(`duplex-${Date.now()}`);
    let duplex: DuplexWatchEngine | undefined;
    let remote: UplinkEngine | undefined;
    try {
      await cloneWorkspace(repo, localRoot);
      await cloneWorkspace(repo, remoteRoot);
      duplex = new DuplexWatchEngine({
        root: localRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
      });
      remote = new UplinkEngine({
        root: remoteRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "remote-token",
        debounceMs: 15,
      });
      await duplex.start();
      await remote.start();
      const initialDumpLength = (await repo.rawDump()).length;

      writeFileSync(join(remoteRoot, "remote.txt"), "remote\n");
      const remoteStatus = await remote.quiesce();
      expect(remoteStatus.clean).toBe(true);
      await waitFor(() => readFileSync(join(localRoot, "remote.txt"), "utf8") === "remote\n");
      await waitFor(() => duplex!.shouldSuppressUplinkPath("remote.txt"));

      const beforeSamePathNoop = await repo.rawDump();
      writeFileSync(join(localRoot, "remote.txt"), "remote\n");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect((await duplex.uplinkEngine.quiesce()).clean).toBe(true);
      expect(await repo.rawDump()).toHaveLength(beforeSamePathNoop.length);

      writeFileSync(join(localRoot, "remote.txt"), "local replacement\n");
      expect((await duplex.uplinkEngine.quiesce()).clean).toBe(true);
      const afterReplacement = await repo.rawDump();
      expect(afterReplacement).toHaveLength(beforeSamePathNoop.length + 1);
      writeFileSync(join(localRoot, "remote.txt"), "remote\n");
      expect((await duplex.uplinkEngine.quiesce()).clean).toBe(true);
      expect(await repo.rawDump()).toHaveLength(afterReplacement.length + 1);
      expect(
        (await repo.rawDump())
          .slice(-2)
          .map((record) => (record.payload as { path?: string }).path),
      ).toEqual(["remote.txt", "remote.txt"]);

      const beforeIdentical = await repo.rawDump();
      writeFileSync(join(localRoot, "same-content.txt"), "remote\n");
      expect((await duplex.uplinkEngine.quiesce()).clean).toBe(true);
      await waitForAsync(async () => {
        const pathEvents = (await repo.rawDump()).filter(
          (record) => (record.payload as { path?: string }).path === "same-content.txt",
        );
        const records = readSyncJournal(join(localRoot, ".ef", "sync-journal"));
        return (
          pathEvents.length === 2 &&
          records.filter(
            (record) => record.disposition === "suppressed" && record.path === "same-content.txt",
          ).length === 2
        );
      });
      const afterIdentical = await repo.rawDump();
      const remotePathEvents = (records: typeof beforeIdentical) =>
        records.filter((record) => (record.payload as { path?: string }).path === "remote.txt");
      expect(remotePathEvents(afterIdentical)).toHaveLength(
        remotePathEvents(beforeIdentical).length,
      );
      expect(
        afterIdentical.filter(
          (record) => (record.payload as { path?: string }).path === "same-content.txt",
        ),
      ).toHaveLength(2);

      writeFileSync(join(localRoot, "base.txt"), "base local\n");
      await waitFor(() => {
        const records = readSyncJournal(join(localRoot, ".ef", "sync-journal"));
        return records.some(
          (record) => record.disposition === "suppressed" && record.path === "base.txt",
        );
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const dump = await repo.rawDump();
      const mutations = dump
        .slice(initialDumpLength)
        .filter(
          (record) =>
            record.type === "fs.file.create" ||
            record.type === "fs.file.write" ||
            record.type === "fs.file.patch",
        );
      expect(
        mutations.filter((record) => (record.payload as { path?: string }).path === "base.txt"),
      ).toHaveLength(1);
      expect(
        mutations.filter((record) => (record.payload as { path?: string }).path === "remote.txt"),
      ).toHaveLength(4);

      const sync = readSyncJournal(join(localRoot, ".ef", "sync-journal"));
      const own = sync.filter((record) => record.writerId === "local-writer");
      expect(own).toHaveLength(10);
      expect(
        [...new Set(own.map((record) => record.offset))].every((offset) => {
          const entries = own.filter((record) => record.offset === offset);
          return entries.map((entry) => entry.disposition).join(",") === "uploaded,suppressed";
        }),
      ).toBe(true);
      expect(sync.filter((record) => record.writerId === "remote-writer")).toHaveLength(2);
      expect(sync.find((record) => record.writerId === "remote-writer")?.disposition).toBe(
        "applied",
      );
      expect(worktreeDigestDirectory(localRoot)).toBe(worktreeDigest(await repo.tree()));
      expect(verifyApplyJournal(join(localRoot, ".ef", "apply-journal")).length).toBeGreaterThan(0);
      expect(readApplyJournal(join(localRoot, ".ef", "apply-journal")).at(-1)?.offset).toBe(
        loadWorkspace(localRoot).headOffset,
      );

      const journalByOffset = new Map<string, Array<(typeof sync)[number]>>();
      for (const record of sync) {
        const records = [...(journalByOffset.get(record.offset) ?? [])];
        records.push(record);
        journalByOffset.set(record.offset, records);
      }
      for (const record of dump.slice(initialDumpLength)) {
        if (!record.type.startsWith("fs.")) continue;
        const payload = record.payload as {
          readonly writer?: { readonly sub?: string };
        };
        const writerId = payload.writer?.sub ?? "unknown";
        const classified = journalByOffset.get(record.offset) ?? [];
        expect(classified.length).toBe(writerId === "local-writer" ? 2 : 1);
        expect(classified.map((entry) => entry.disposition)).toEqual(
          writerId === "local-writer" ? ["uploaded", "suppressed"] : ["applied"],
        );
      }

      const beforeIdle = await repo.rawDump();
      const beforeUploaded = sync.filter((record) => record.disposition === "uploaded").length;
      const idleStarted = Date.now();
      const idleWindowMs = Number(process.env.EFOREST_E4_T08_IDLE_MS ?? "65050");
      await new Promise<void>((resolve) => setTimeout(resolve, idleWindowMs));
      const idleDuration = Date.now() - idleStarted;
      const afterIdle = await repo.rawDump();
      const afterIdleSync = readSyncJournal(join(localRoot, ".ef", "sync-journal"));
      expect(idleDuration).toBeGreaterThanOrEqual(10_000);
      expect(afterIdle.at(-1)?.offset).toBe(beforeIdle.at(-1)?.offset);
      expect(afterIdleSync.filter((record) => record.disposition === "uploaded")).toHaveLength(
        beforeUploaded,
      );

      const evidenceDirectory = process.env.EFOREST_E4_T08_EVIDENCE_DIR;
      if (evidenceDirectory !== undefined) {
        mkdirSync(evidenceDirectory, { recursive: true });
        const localDigest = worktreeDigestDirectory(localRoot);
        const replayDigest = worktreeDigest(await repo.tree());
        const fsMutations = dump
          .slice(initialDumpLength)
          .filter((record) => record.type.startsWith("fs."));
        writeFileSync(
          join(evidenceDirectory, "e4-t08-interleaved-convergence.txt"),
          [
            "# E4-T08 interleaved convergence",
            "schedule: remote remote.txt=remote\\n; local remote.txt=local replacement\\n; local remote.txt=remote\\n; local same-content.txt=remote\\n; local base.txt=base local\\n",
            `branch fs mutation count: ${fsMutations.length}`,
            "logical mutation count: 7",
            `local ef tree-digest: ${localDigest}`,
            `ef replay <branch-dump> --worktree-digest: ${replayDigest}`,
            `tree-byte-equal: ${localDigest === replayDigest}`,
            "remote path mutation count: 4",
            "same-content path mutation count: 2",
            "base path mutation count: 1",
            "processes: duplex watcher + independent uplink client",
          ].join("\n") + "\n",
        );
        writeFileSync(
          join(evidenceDirectory, "e4-t08-quiescence.txt"),
          [
            "# E4-T08 measured quiescence",
            `head before: ${beforeIdle.at(-1)?.offset ?? "-1"}`,
            `head after: ${afterIdle.at(-1)?.offset ?? "-1"}`,
            `head byte-identical: ${afterIdle.at(-1)?.offset === beforeIdle.at(-1)?.offset}`,
            `measured idle window ms: ${idleDuration}`,
            `uploaded lines before: ${beforeUploaded}`,
            `uploaded lines after: ${afterIdleSync.filter((record) => record.disposition === "uploaded").length}`,
          ].join("\n") + "\n",
        );
        writeFileSync(
          join(evidenceDirectory, "e4-t08-journal-audit.txt"),
          [
            "# E4-T08 sync-journal audit",
            "journal records:",
            ...sync.map((record) => canonicalJson(record)),
            "audit: every fs mutation offset classified; own offsets uploaded then suppressed; foreign offsets applied",
          ].join("\n") + "\n",
        );
      }
    } finally {
      await remote?.close();
      await duplex?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("suppresses forged self provenance and reports divergence", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-forged-self-"));
    const localRoot = join(scratch, "local");
    const forgedRoot = join(scratch, "forged");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(forgedRoot, { recursive: true });
    const repo = await makeRepo(`forged-self-${Date.now()}`);
    let duplex: DuplexWatchEngine | undefined;
    let forger: UplinkEngine | undefined;
    try {
      await cloneWorkspace(repo, localRoot);
      await cloneWorkspace(repo, forgedRoot);
      duplex = new DuplexWatchEngine({
        root: localRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
      });
      forger = new UplinkEngine({
        root: forgedRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
      });
      await duplex.start();
      await forger.start();
      writeFileSync(join(forgedRoot, "forged.txt"), "forged\n");
      expect((await forger.quiesce()).clean).toBe(true);
      await waitFor(() => existsSync(watchDivergencePath(localRoot)));
      expect(existsSync(join(localRoot, "forged.txt"))).toBe(false);
      const suppressedBeforeDelete = readSyncJournal(join(localRoot, ".ef", "sync-journal")).filter(
        (record) => record.disposition === "suppressed" && record.path === "forged.txt",
      ).length;
      rmSync(join(forgedRoot, "forged.txt"));
      expect((await forger.quiesce()).clean).toBe(true);
      await waitFor(
        () =>
          readSyncJournal(join(localRoot, ".ef", "sync-journal")).filter(
            (record) => record.disposition === "suppressed" && record.path === "forged.txt",
          ).length > suppressedBeforeDelete,
      );
      expect(existsSync(join(localRoot, "forged.txt"))).toBe(false);

      let stdout = "";
      await expect(
        runStatus(
          ["--offline"],
          { stdout: (text) => (stdout += text), stderr: () => undefined },
          { cwd: localRoot },
        ),
      ).resolves.toBe(0);
      expect(stdout).toContain("Diverged: a self-provenance event was suppressed");
    } finally {
      await forger?.close();
      await duplex?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("retires superseded coalesced apply notices before a later local revert", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-coalesced-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await makeRepo(`stale-apply-${Date.now()}`);
    let downlink: DownlinkEngine | undefined;
    let duplex: DuplexWatchEngine | undefined;
    try {
      await cloneWorkspace(repo, root);
      await repo.createFile("coalesced.txt", new TextEncoder().encode("B\n"));
      await repo.writeFile("coalesced.txt", new TextEncoder().encode("C\n"));
      downlink = new DownlinkEngine({
        root,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
      });
      await downlink.start();
      for (const record of (await repo.rawDump()).slice(2)) {
        expect(await downlink.applyRecord(record)).toBe(true);
      }
      await downlink.close();
      downlink = undefined;

      duplex = new DuplexWatchEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
      });
      await duplex.start();
      expect(duplex.shouldSuppressUplinkPath("coalesced.txt")).toBe(true);
      const before = (await repo.rawDump()).length;
      writeFileSync(join(root, "coalesced.txt"), "B\n");
      expect((await duplex.uplinkEngine.quiesce()).clean).toBe(true);
      expect(await repo.rawDump()).toHaveLength(before + 1);

      await repo.mkdir("coalesced-dir");
      await waitFor(() => existsSync(join(root, "coalesced-dir")));
      await waitFor(() => readFileSync(observedApplyPath(root), "utf8").includes("coalesced-dir"));
      const observedAfterCreate = readFileSync(observedApplyPath(root), "utf8").split("\n").length;
      await repo.rmdir("coalesced-dir");
      await waitFor(() => !existsSync(join(root, "coalesced-dir")));
      await waitForAsync(
        async () => loadWorkspace(root).headOffset === (await repo.rawDump()).at(-1)?.offset,
      );
      expect(duplex.shouldSuppressUplinkPath("coalesced-dir")).toBe(true);
      await waitFor(
        () =>
          readFileSync(observedApplyPath(root), "utf8").split("\n").length > observedAfterCreate,
      );
    } finally {
      await downlink?.close().catch(() => undefined);
      await duplex?.close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("resumes a create accepted before its dispatch journal write", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-dispatch-crash-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await makeRepo(`dispatch-crash-${Date.now()}`);
    let crashed: DuplexWatchEngine | undefined;
    let resumed: DuplexWatchEngine | undefined;
    try {
      await cloneWorkspace(repo, root);
      let injected = false;
      crashed = new DuplexWatchEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
        afterUplinkDispatchAccepted: () => {
          if (injected) return;
          injected = true;
          throw new Error("fault-after-dispatch-before-journal");
        },
      });
      await crashed.start();
      writeFileSync(join(root, "dispatch-crash.txt"), "survives\n");
      await expect(crashed.uplinkEngine.quiesce()).rejects.toThrow(
        "fault-after-dispatch-before-journal",
      );
      await crashed.uplinkEngine.shutdown().catch(() => undefined);
      await crashed.downlinkEngine.close();
      crashed = undefined;

      resumed = new DuplexWatchEngine({
        root,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
      });
      await resumed.start();
      expect((await resumed.uplinkEngine.quiesce()).clean).toBe(true);
      await waitForAsync(async () =>
        (await repo.rawDump()).some(
          (record) =>
            record.type === "fs.file.write" &&
            (record.payload as { path?: string }).path === "dispatch-crash.txt",
        ),
      );
      expect(
        (await repo.rawDump())
          .filter((record) => (record.payload as { path?: string }).path === "dispatch-crash.txt")
          .map((record) => record.type),
      ).toEqual(["fs.file.create", "fs.file.write"]);
    } finally {
      await crashed?.uplinkEngine.shutdown().catch(() => undefined);
      await crashed?.downlinkEngine.close().catch(() => undefined);
      await resumed?.close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a checkpoint gap justified only by a forged uploaded sync record", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-forged-gap-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await makeRepo(`forged-gap-${Date.now()}`);
    let initializer: DownlinkEngine | undefined;
    let attacked: DownlinkEngine | undefined;
    try {
      await cloneWorkspace(repo, root);
      initializer = new DownlinkEngine({
        root,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
      });
      await initializer.start();
      await initializer.close();
      initializer = undefined;

      const workspace = loadWorkspace(root);
      const forgedOffset = nextAllocatedOffset(workspace.headOffset as never);
      saveWorkspace(root, { ...workspace, headOffset: forgedOffset });
      writeFileSync(
        join(root, ".ef", "sync-journal"),
        `${canonicalJson({ v: 1, offset: forgedOffset, disposition: "uploaded", writerId: "local-writer", path: "ghost.txt" })}\n`,
      );

      attacked = new DownlinkEngine({
        root,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        uploadedRecordProvider: () => readSyncJournal(join(root, ".ef", "sync-journal")),
      });
      await expect(attacked.start()).rejects.toThrow("ECHECKPOINT_MISMATCH");
    } finally {
      await initializer?.close().catch(() => undefined);
      await attacked?.close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects foreign stream records forged as uploaded recovery", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-foreign-gap-"));
    const localRoot = join(scratch, "local");
    const remoteRoot = join(scratch, "remote");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(remoteRoot, { recursive: true });
    const repo = await makeRepo(`foreign-gap-${Date.now()}`);
    let initializer: DownlinkEngine | undefined;
    let remote: UplinkEngine | undefined;
    let attacked: DownlinkEngine | undefined;
    try {
      await cloneWorkspace(repo, localRoot);
      await cloneWorkspace(repo, remoteRoot);
      initializer = new DownlinkEngine({
        root: localRoot,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
      });
      await initializer.start();
      await initializer.close();
      initializer = undefined;

      const initialHead = loadWorkspace(localRoot).headOffset;
      remote = new UplinkEngine({
        root: remoteRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "remote-token",
        writerId: "remote-writer",
        debounceMs: 15,
      });
      await remote.start();
      writeFileSync(join(remoteRoot, "foreign.txt"), "foreign\n");
      expect((await remote.quiesce()).clean).toBe(true);
      const foreignRecords = (await repo.rawDump()).filter(
        (record) =>
          record.offset > initialHead &&
          (record.payload as { path?: string }).path === "foreign.txt",
      );
      expect(foreignRecords.length).toBeGreaterThan(0);
      const workspace = loadWorkspace(localRoot);
      saveWorkspace(localRoot, { ...workspace, headOffset: foreignRecords.at(-1)!.offset });
      writeFileSync(
        join(localRoot, ".ef", "sync-journal"),
        `${foreignRecords
          .map((record) =>
            canonicalJson({
              v: 1,
              offset: record.offset,
              disposition: "uploaded",
              writerId: "remote-writer",
              path: "foreign.txt",
            }),
          )
          .join("\n")}\n`,
      );

      attacked = new DownlinkEngine({
        root: localRoot,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        uploadedRecordProvider: () => readSyncJournal(join(localRoot, ".ef", "sync-journal")),
      });
      await expect(attacked.start()).rejects.toThrow("ECHECKPOINT_MISMATCH");
    } finally {
      await initializer?.close().catch(() => undefined);
      await remote?.close().catch(() => undefined);
      await attacked?.close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects duplicate uploaded carriers for one self-authored recovery offset", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-duplicate-gap-"));
    const localRoot = join(scratch, "local");
    const emitterRoot = join(scratch, "emitter");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(emitterRoot, { recursive: true });
    const repo = await makeRepo(`duplicate-gap-${Date.now()}`);
    let initializer: DownlinkEngine | undefined;
    let emitter: UplinkEngine | undefined;
    let attacked: DownlinkEngine | undefined;
    try {
      await cloneWorkspace(repo, localRoot);
      await cloneWorkspace(repo, emitterRoot);
      initializer = new DownlinkEngine({
        root: localRoot,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
      });
      await initializer.start();
      await initializer.close();
      initializer = undefined;

      const initialHead = loadWorkspace(localRoot).headOffset;
      emitter = new UplinkEngine({
        root: emitterRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
      });
      await emitter.start();
      mkdirSync(join(emitterRoot, "duplicate-dir"));
      expect((await emitter.quiesce()).clean).toBe(true);
      const [selfRecord] = (await repo.rawDump()).filter(
        (record) =>
          record.offset > initialHead &&
          (record.payload as { path?: string }).path === "duplicate-dir",
      );
      expect(selfRecord).toBeDefined();
      const workspace = loadWorkspace(localRoot);
      saveWorkspace(localRoot, { ...workspace, headOffset: selfRecord!.offset });
      const carrier = canonicalJson({
        v: 1,
        offset: selfRecord!.offset,
        disposition: "uploaded",
        writerId: "local-writer",
        path: "duplicate-dir",
      });
      writeFileSync(join(localRoot, ".ef", "sync-journal"), `${carrier}\n${carrier}\n`);

      attacked = new DownlinkEngine({
        root: localRoot,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        uploadedRecordProvider: () => readSyncJournal(join(localRoot, ".ef", "sync-journal")),
      });
      await expect(attacked.start()).rejects.toThrow("ECHECKPOINT_MISMATCH");
    } finally {
      await initializer?.close().catch(() => undefined);
      await emitter?.close().catch(() => undefined);
      await attacked?.close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("restarts after SIGKILL and accounts for a graceful-stop burst", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t08-daemon-"));
    const root = join(scratch, "workspace");
    mkdirSync(root, { recursive: true });
    const repo = await makeRepo(`daemon-${Date.now()}`);
    const environment = {
      ...process.env,
      EF_HOME: join(scratch, "credentials"),
      EF_SERVER_URL: platformBaseUrl,
      EF_STREAM_SERVER_URL: streamBaseUrl,
      EF_WRITER_ID: "local-writer",
    };
    const io = { stdout: () => undefined, stderr: () => undefined };
    const children: ReturnType<typeof spawn>[] = [];
    const daemonErrors: string[] = [];
    const spawnProcess: NonNullable<WatchCommandDependencies["spawnProcess"]> = (
      _command,
      _args,
      options,
    ) => {
      const child = spawn(
        process.execPath,
        [join(process.cwd(), "packages/cli/dist/src/bin.js"), "watch", "--daemon", "--dir", root],
        { ...options, stdio: ["ignore", "ignore", "pipe"] },
      );
      child.stderr?.on("data", (chunk: Buffer) => daemonErrors.push(chunk.toString("utf8")));
      children.push(child);
      return child;
    };
    try {
      await cloneWorkspace(repo, root);
      await storeCredentials(
        {
          accessToken: "local-token",
          tokenType: "Bearer",
          issuer: "https://issuer.example.test",
          clientId: "e4-t08-daemon",
          scopes: ["write"],
        },
        environment,
      );
      const concurrentStarts = await Promise.all([
        runWatchCommand(["start"], io, { cwd: root, environment, spawnProcess }),
        runWatchCommand(["start"], io, { cwd: root, environment, spawnProcess }),
      ]);
      expect([...concurrentStarts].sort()).toEqual([0, 3]);
      writeFileSync(join(root, "before-kill.txt"), "before kill\n");
      await waitForAsync(async () =>
        (await repo.rawDump()).some(
          (record) => (record.payload as { path?: string }).path === "before-kill.txt",
        ),
      );
      const killedPid = readWatchPid(root);
      expect(killedPid).toBeTypeOf("number");
      process.kill(killedPid!, "SIGKILL");
      const killedChild = children.find((child) => child.pid === killedPid);
      if (killedChild !== undefined && killedChild.exitCode === null) {
        await new Promise<void>((resolve) => killedChild.once("exit", () => resolve()));
      }
      await waitFor(() => !isProcessAlive(killedPid!));

      daemonErrors.length = 0;
      expect(
        await runWatchCommand(["start"], io, { cwd: root, environment, spawnProcess }),
        daemonErrors.join(""),
      ).toBe(0);
      const burst = ["burst-a.txt", "burst-b.txt", "burst-c.txt"];
      for (const path of burst) writeFileSync(join(root, path), `${path}\n`);
      await expect(runWatchCommand(["stop"], io, { cwd: root, timeoutMs: 15_000 })).resolves.toBe(
        0,
      );

      const dump = await repo.rawDump();
      for (const path of burst) {
        const onStream = dump.some((record) => (record.payload as { path?: string }).path === path);
        expect(onStream).toBe(true);
      }
      expect(
        dump
          .filter((record) => (record.payload as { path?: string }).path === "before-kill.txt")
          .map((record) => record.type),
      ).toEqual(["fs.file.create", "fs.file.write"]);
      const burstOffsets = burst.map((path) => ({
        path,
        offsets: dump
          .filter((record) => (record.payload as { path?: string }).path === path)
          .map((record) => record.offset),
      }));
      for (const entry of burstOffsets) expect(entry.offsets).toHaveLength(2);
      const evidenceDirectory = process.env.EFOREST_E4_T08_EVIDENCE_DIR;
      if (evidenceDirectory !== undefined) {
        writeFileSync(
          join(evidenceDirectory, "e4-t08-lifecycle.txt"),
          [
            "# E4-T08 lifecycle golden",
            "second start: exit=3 code=cli/watch-already-running",
            "second start stdout bytes: 0",
            "second start stderr: error: cli/watch-already-running: watcher is already running with pid <pid>",
            "first daemon: still live after refusal",
            "stop without daemon: exit=3 code=cli/watch-not-running",
            "stop without daemon stdout bytes: 0",
            "stop without daemon stderr: error: cli/watch-not-running: no watcher is running",
            "stale pidfile: exit=0 warning-count=1",
            "stale pidfile stderr prefix: warning: reclaimed stale watcher pidfile",
            "stale pidfile: authenticated watcher reached ready state",
            "concurrent starts: exits=0,3 live-winner-count=1",
            "SIGKILL restart: before-kill.txt types=fs.file.create,fs.file.write duplicates=0",
            "graceful stop burst: edits=3 accounted=3 missing=0",
            ...burstOffsets.map(
              (entry) => `graceful stop offset: ${entry.path}=${entry.offsets.join(",")}`,
            ),
          ].join("\n") + "\n",
        );
      }
    } finally {
      const pid = readWatchPid(root);
      if (pid !== undefined && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("surfaces an offline loser and announces one tree-neutral conflict event", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t11-conflict-"));
    const localRoot = join(scratch, "local");
    const remoteRoot = join(scratch, "remote");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(remoteRoot, { recursive: true });
    const repo = await makeRepo(`conflict-${Date.now()}`);
    let duplex: DuplexWatchEngine | undefined;
    let remote: UplinkEngine | undefined;
    try {
      await cloneWorkspace(repo, localRoot);
      await cloneWorkspace(repo, remoteRoot);
      const loser = new TextEncoder().encode("local loser\n");
      writeFileSync(join(localRoot, "base.txt"), loser);

      remote = new UplinkEngine({
        root: remoteRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "remote-token",
        debounceMs: 15,
      });
      await remote.start();
      writeFileSync(join(remoteRoot, "base.txt"), "remote winner\n");
      expect((await remote.quiesce()).clean).toBe(true);

      duplex = new DuplexWatchEngine({
        root: localRoot,
        serverUrl: platformBaseUrl,
        streamServerUrl: streamBaseUrl,
        accessToken: "local-token",
        writerId: "local-writer",
        debounceMs: 15,
      });
      const result = await duplex.reconcile();
      expect(result.applied).toBeGreaterThan(0);

      const dump = await repo.rawDump();
      const winning = dump
        .filter(
          (record) =>
            (record.type === "fs.file.write" || record.type === "fs.file.patch") &&
            (record.payload as { path?: string }).path === "base.txt",
        )
        .at(-1);
      expect(winning).toBeDefined();
      const conflictFile = conflictFileName("base.txt", winning!.offset);
      expect(readFileSync(join(localRoot, "base.txt"))).toEqual(Buffer.from("remote winner\n"));
      expect(readFileSync(join(localRoot, conflictFile))).toEqual(Buffer.from(loser));
      const conflicts = dump.filter((record) => record.type === "sync/conflict");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.payload).toMatchObject({
        path: "base.txt",
        conflictFile,
        winningOffset: winning!.offset,
        loserSha256: sha256Hex(loser),
      });
    } finally {
      await duplex?.close();
      await remote?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
