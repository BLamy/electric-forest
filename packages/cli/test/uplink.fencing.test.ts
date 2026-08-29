import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDurableJsonStream, type StreamRecord } from "@eforest/client";
import { emptyView } from "@eforest/identity";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  createPlatformServer,
  OfficialStreamAdapter,
  PlatformGateway,
  UnauthorizedError,
  type AuthorizationVerifier,
} from "@eforest/platform";
import { StreamFsRepo, worktreeDigest } from "@eforest/streamfs";
import { load as loadWorkspace, save as saveWorkspace } from "@eforest/workspace";
import { runWatch } from "../src/sync/uplink.js";
import { journalLine, readJournal, type JournalRecord } from "../src/sync/journal.js";
import { workspaceStateFromTree } from "../src/tree-materializer.js";

const streamServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
let streamBaseUrl: string;
let platformServer: Server;
let platformBaseUrl: string;

const token = "e4-t06-fencing-token";
const verifier: AuthorizationVerifier = {
  verifyAuthorization: async (header) => {
    if (header !== `Bearer ${token}`) throw new UnauthorizedError("invalid_signature");
    return { sub: "e4-t06-fencing" };
  },
  authorizationContext: async (header) => {
    if (header !== `Bearer ${token}`) throw new UnauthorizedError("invalid_signature");
    return {
      principal: { kind: "identified", sub: "e4-t06-fencing" },
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
        branch: "main",
        metadataStreamId: `fs:acme/${name}:main:meta`,
      },
      records.at(-1)?.offset ?? "-1",
      tree,
    ),
  );
}

interface Snapshot {
  readonly dump: readonly StreamRecord[];
  readonly digest: string;
  readonly replayDigest: string;
  readonly head: string;
}

function replayDigest(root: string, dump: readonly StreamRecord[]): string {
  const dumpPath = join(root, "metadata-dump.jsonl");
  writeFileSync(dumpPath, `${dump.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const result = spawnSync(
    process.execPath,
    [
      resolve(process.cwd(), "packages/cli/dist/src/bin.js"),
      "replay",
      dumpPath,
      "--digest",
      "--reducer",
      resolve(process.cwd(), "packages/streamfs/reducer.mjs"),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || "ef replay failed");
  return result.stdout.trim();
}

describe("E4-T06 authenticated stale-base fencing", () => {
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
    platformBaseUrl = await new Promise<string>((resolve, reject) => {
      platformServer.listen(0, "127.0.0.1", () => {
        const address = platformServer.address();
        if (address === null || typeof address === "string") {
          reject(new Error("platform server did not expose an address"));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
      platformServer.once("error", reject);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      platformServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await streamServer.stop();
  });

  it("keeps the refusal log-neutral, remains live, and returns quiesce 3", async () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-fence-cli-"));
    const root = join(scratch, "workspace");
    const credentialsHome = join(scratch, "credentials");
    mkdirSync(root, { recursive: true });
    mkdirSync(credentialsHome, { recursive: true });
    const repo = await streamRepo("fence-cli");
    let refusalBefore: Snapshot | undefined;
    let refusalAfter: Snapshot | undefined;
    let responseConflict: unknown;
    const fetcher: typeof fetch = async (input, init) => {
      const requestUrl = String(input);
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const isContestedDispatch =
        requestUrl.endsWith("/api/dispatch") &&
        requestBody?.event?.payload?.path === "contested.txt" &&
        (requestBody.event.type === "fs.file.write" || requestBody.event.type === "fs.file.patch");
      if (!isContestedDispatch) return fetch(input, init);
      const before = await repo.rawDump();
      refusalBefore = {
        dump: before,
        digest: worktreeDigest(await repo.tree()),
        replayDigest: replayDigest(scratch, before),
        head: before.at(-1)?.offset ?? "-1",
      };
      const response = await fetch(input, init);
      responseConflict = (
        (await response.clone().json()) as { readonly error?: { readonly conflict?: unknown } }
      ).error?.conflict;
      const after = await repo.rawDump();
      refusalAfter = {
        dump: after,
        digest: worktreeDigest(await repo.tree()),
        replayDigest: replayDigest(scratch, after),
        head: after.at(-1)?.offset ?? "-1",
      };
      expect(response.status).toBe(409);
      return response;
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const emitted: JournalRecord[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };
    try {
      await repo.createFile("contested.txt", new TextEncoder().encode("base\n"));
      await makeWorkspace(repo, root, "fence-cli");
      await repo.writeFile("contested.txt", new TextEncoder().encode("foreign\n"));
      writeFileSync(join(root, "contested.txt"), "local stale\n");
      writeFileSync(join(root, "unrelated.txt"), "accepted\n");
      writeFileSync(
        join(credentialsHome, "credentials.json"),
        `${JSON.stringify({
          accessToken: token,
          tokenType: "Bearer",
          issuer: "test",
          clientId: "test",
          scopes: ["repo:write"],
        })}\n`,
      );

      const exitCode = await runWatch(["--up", "--quiesce", "--debounce", "20"], io, {
        cwd: root,
        environment: {
          EF_HOME: credentialsHome,
          EF_SERVER_URL: platformBaseUrl,
          EF_STREAM_SERVER_URL: streamBaseUrl,
        },
        fetcher,
        onRecord: (record) => emitted.push(record),
      });
      expect(exitCode).toBe(3);
      expect(refusalBefore).toBeDefined();
      expect(refusalAfter).toBeDefined();
      expect(refusalAfter?.dump).toEqual(refusalBefore?.dump);
      expect(refusalAfter?.head).toBe(refusalBefore?.head);
      expect(refusalAfter?.digest).toBe(refusalBefore?.digest);
      expect(refusalAfter?.replayDigest).toBe(refusalBefore?.replayDigest);
      console.log(
        `E4_T06_FENCING before=${refusalBefore!.replayDigest} after=${refusalAfter!.replayDigest}`,
      );

      const journal = readJournal(join(root, ".ef", "journal.jsonl"));
      const refused = journal.filter(
        (record): record is Extract<JournalRecord, { kind: "refused" }> =>
          record.kind === "refused",
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]!.conflict).toEqual(responseConflict);
      expect(emitted).toEqual(journal);
      expect(stdout.join("")).toBe(journal.map(journalLine).join(""));
      expect(stderr.join("")).toBe(
        journal
          .filter((record) => record.kind === "refused")
          .map(journalLine)
          .join(""),
      );
      const finalDump = await repo.rawDump();
      expect(finalDump.length).toBe(refusalAfter!.dump.length + 1);
      expect(finalDump.at(-1)?.payload).toMatchObject({ path: "unrelated.txt" });
      expect(loadWorkspace(root).headOffset).toBe(finalDump.at(-1)?.offset);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
