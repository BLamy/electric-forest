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
import { load as loadWorkspace, save as saveWorkspace } from "@eforest/workspace";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceStateFromTree } from "../src/tree-materializer.js";
import { COMPLETE_MARKER } from "../src/clone-command.js";
import { DuplexWatchEngine } from "../src/sync/duplex.js";
import { readApplyJournal, verifyApplyJournal } from "../src/sync/apply-journal.js";
import { UplinkEngine } from "../src/sync/uplink.js";
import { readSyncJournal } from "../src/sync/sync-journal.js";

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

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
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

      const beforeIdentical = await repo.rawDump();
      writeFileSync(join(localRoot, "same-content.txt"), "remote\n");
      await waitFor(() => {
        const records = readSyncJournal(join(localRoot, ".ef", "sync-journal"));
        return records.some(
          (record) => record.disposition === "suppressed" && record.path === "same-content.txt",
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
      ).toHaveLength(2);

      const sync = readSyncJournal(join(localRoot, ".ef", "sync-journal"));
      const own = sync.filter((record) => record.writerId === "local-writer");
      expect(own).toHaveLength(6);
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
      await new Promise<void>((resolve) => setTimeout(resolve, 10_050));
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
            "schedule: remote remote.txt=remote\\n; local same-content.txt=remote\\n; local base.txt=base local\\n",
            `branch fs mutation count: ${fsMutations.length}`,
            "logical mutation count: 5",
            `local ef tree-digest: ${localDigest}`,
            `ef replay <branch-dump> --worktree-digest: ${replayDigest}`,
            `tree-byte-equal: ${localDigest === replayDigest}`,
            "remote path mutation count: 2",
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
});
