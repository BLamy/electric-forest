import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const serverBin = join(repoRoot, "packages/server/dist/src/bin.js");
const efBin = join(repoRoot, "packages/cli/dist/src/bin.js");
const mergeUsage =
  "Usage: ef merge <target-stream-url> <source-stream-url> (--ff-only | --three-way)\n";

function processEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PORT;
  delete env.EF_STORE;
  delete env.EF_DATA_DIR;
  return env;
}

function buildProcessEntrypoint(packageName: string): void {
  const result = spawnSync("pnpm", ["--filter", packageName, "build"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: processEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${packageName} process build failed (${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
}

beforeAll(() => {
  if (process.env.EFOREST_TEST_PREBUILT === "1") {
    if (!existsSync(serverBin) || !existsSync(efBin)) {
      throw new Error(
        "EFOREST_TEST_PREBUILT=1 requires built @eforest/server and @eforest/cli process entrypoints",
      );
    }
    return;
  }
  buildProcessEntrypoint("@eforest/server");
  buildProcessEntrypoint("@eforest/cli");
}, 30_000);

async function startServerProcess(stateDir: string): Promise<{
  readonly child: ReturnType<typeof spawn>;
  readonly baseUrl: string;
  readonly stderr: () => string;
}> {
  const child = spawn(
    process.execPath,
    [serverBin, "--port=0", "--store", "file", "--data-dir", stateDir],
    {
      cwd: repoRoot,
      env: processEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`server did not report LISTENING; stderr=${stderr}`)));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const match = /(?:^|\n)LISTENING (http:\/\/127\.0\.0\.1:\d+)\r?(?:\n|$)/.exec(stdout);
      if (match !== null) finish(() => resolve(match[1]!));
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      finish(() =>
        reject(
          new Error(
            `server exited before LISTENING (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
          ),
        ),
      );
    });
  });
  return { child, baseUrl, stderr: () => stderr };
}

function runEf(args: readonly string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, [efBin, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: processEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null) {
    throw new Error(`ef terminated by ${String(result.signal)}: ${String(result.stderr)}`);
  }
  return result;
}

function metadataUrl(baseUrl: string, streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

async function stopServerProcess(
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  return exited;
}

describe("published Durable Streams process entrypoints", () => {
  it("runs the server binary and parses ef snapshot and merge end to end", async () => {
    const { StreamFs } = await import("@eforest/streamfs");
    const workDir = mkdtempSync(join(tmpdir(), "eforest-e1-t09-process-"));
    const stateDir = join(workDir, "state");
    const server = await startServerProcess(stateDir);
    try {
      const repo = await new StreamFs({ baseUrl: server.baseUrl }).createRepo("cli-process");
      await repo.createFile("readme.md", new TextEncoder().encode("main"));
      const targetUrl = metadataUrl(server.baseUrl, repo.metadataStreamId);
      const snapshotOffset = (await repo.rawDump()).at(-1)!.offset;
      const snapshotDigest = await repo.digest();

      const snapshot = runEf(["snapshot", targetUrl]);
      expect(snapshot.status).toBe(0);
      expect(snapshot.stderr).toBe("");
      const snapshotLines = String(snapshot.stdout).trim().split("\n");
      expect(snapshotLines).toHaveLength(1);
      expect(JSON.parse(snapshotLines[0]!)).toEqual({
        snapshotOffset,
        stateDigest: snapshotDigest,
      });

      await repo.createBranch("feature");
      const branch = await repo.openBranch("feature");
      await branch.writeFile("readme.md", new TextEncoder().encode("feature"));
      const sourceUrl = metadataUrl(server.baseUrl, branch.metadataStreamId);
      const targetDumpBeforeParsingRefusal = JSON.stringify(await repo.rawDump());
      const sourceDumpBeforeParsingRefusal = JSON.stringify(await branch.rawDump());

      const refused = runEf(["merge", targetUrl, sourceUrl]);
      expect(refused.status).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toBe(mergeUsage);
      expect(JSON.stringify(await repo.rawDump())).toBe(targetDumpBeforeParsingRefusal);
      expect(JSON.stringify(await branch.rawDump())).toBe(sourceDumpBeforeParsingRefusal);

      const sourceDumpBeforeMerge = JSON.stringify(await branch.rawDump());
      const merged = runEf(["merge", targetUrl, sourceUrl, "--ff-only"]);
      expect(merged.status).toBe(0);
      expect(merged.stderr).toBe("");
      expect(String(merged.stdout).trim().split("\n")).toEqual([
        (await repo.rawDump()).at(-1)!.offset,
        await repo.digest(),
      ]);
      expect(await repo.digest()).toBe(await branch.digest());
      expect(JSON.stringify(await branch.rawDump())).toBe(sourceDumpBeforeMerge);
      expect(new TextDecoder().decode(await repo.readFile("readme.md"))).toBe("feature");

      await branch.writeFile("readme.md", new TextEncoder().encode("after-merge"));
      expect(new TextDecoder().decode(await repo.readFile("readme.md"))).toBe("feature");

      const baseLines = Array.from(
        { length: 128 },
        (_, index) => `line-${String(index).padStart(3, "0")}`,
      );
      const encodeLines = (lines: readonly string[]): Uint8Array =>
        new TextEncoder().encode(`${lines.join("\n")}\n`);
      await repo.createFile("three-way.txt", encodeLines(baseLines));
      await repo.createBranch("three-way");
      const threeWayBranch = await repo.openBranch("three-way");
      const targetLines = [...baseLines];
      targetLines[8] = "target-line-008";
      const sourceLines = [...baseLines];
      sourceLines[104] = "source-line-104";
      const expectedLines = [...targetLines];
      expectedLines[104] = sourceLines[104]!;
      await repo.writeFile("three-way.txt", encodeLines(targetLines));
      await threeWayBranch.writeFile("three-way.txt", encodeLines(sourceLines));
      const threeWaySourceUrl = metadataUrl(server.baseUrl, threeWayBranch.metadataStreamId);

      const threeWay = runEf(["merge", targetUrl, threeWaySourceUrl, "--three-way"]);
      expect(threeWay.status).toBe(0);
      expect(threeWay.stderr).toBe("");
      const threeWayLines = String(threeWay.stdout).trim().split("\n");
      expect(threeWayLines).toHaveLength(1);
      expect(JSON.parse(threeWayLines[0]!)).toMatchObject({
        kind: "three-way",
        conflicts: [],
        resultTreeDigest: await repo.digest(),
      });
      expect(await repo.readFile("three-way.txt")).toEqual(encodeLines(expectedLines));

      const replayPath = join(workDir, "three-way.jsonl");
      writeFileSync(
        replayPath,
        `${(await repo.rawDump()).map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
      const fastForwardSourcePath = join(workDir, "fast-forward-source.jsonl");
      const fastForwardSource = await branch.rawDump();
      const fastForwardForkIndex = fastForwardSource.findIndex(
        (record) => record.type === "fs.branch.fork",
      );
      expect(fastForwardForkIndex).toBeGreaterThanOrEqual(0);
      writeFileSync(
        fastForwardSourcePath,
        `${fastForwardSource
          .slice(fastForwardForkIndex)
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
        "utf8",
      );
      const replay = runEf([
        "replay",
        replayPath,
        "--digest",
        "--merge-source",
        fastForwardSourcePath,
      ]);
      expect(replay.status, `${String(replay.stdout)}${String(replay.stderr)}`).toBe(0);
      expect(replay.stderr).toBe("");
      expect(String(replay.stdout).trim()).toBe(await repo.digest());
      expect(server.stderr()).toBe("");
    } finally {
      const exited = await stopServerProcess(server.child);
      expect(exited).toEqual({ code: 0, signal: null });
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 20_000);
});
