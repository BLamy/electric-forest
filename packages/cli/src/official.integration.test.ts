import { createDurableStreamTestServer } from "@eforest/server";
import { StreamFs } from "@eforest/streamfs";
import { afterEach, describe, expect, it } from "vitest";
import { runMergeCommand } from "./merge-command.js";
import { snapshotStreamUrl } from "./snapshot-command.js";

const servers: Array<ReturnType<typeof createDurableStreamTestServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startServer(): Promise<string> {
  const server = createDurableStreamTestServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  return server.start();
}

function metadataUrl(baseUrl: string, streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

describe("CLI commands on the published Durable Streams server", () => {
  it("snapshots and fast-forward merges through StreamFS APIs", async () => {
    const baseUrl = await startServer();
    const repo = await new StreamFs({ baseUrl }).createRepo("cli-official");
    await repo.createFile("readme.md", new TextEncoder().encode("main"));

    const snapshot = await snapshotStreamUrl(metadataUrl(baseUrl, repo.metadataStreamId));
    expect(snapshot.snapshotEventOffset).toBe((await repo.dump()).at(-1)?.offset);

    await repo.createBranch("feature");
    const branch = await repo.openBranch("feature");
    await branch.writeFile("readme.md", new TextEncoder().encode("feature"));

    let stdout = "";
    let stderr = "";
    const code = await runMergeCommand(
      metadataUrl(baseUrl, repo.metadataStreamId),
      metadataUrl(baseUrl, branch.metadataStreamId),
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toEqual([
      (await repo.dump()).at(-1)?.offset,
      await repo.digest(),
    ]);
    expect(new TextDecoder().decode(await repo.readFile("readme.md"))).toBe("feature");
  });
});
