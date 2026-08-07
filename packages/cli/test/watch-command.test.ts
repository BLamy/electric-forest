import { save as saveWorkspace } from "@eforest/workspace";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { COMPLETE_MARKER } from "../src/clone-command.js";
import { runStatus } from "../src/status.js";
import { runWatchCommand } from "../src/sync/watch-command.js";

const roots: string[] = [];

function capture(): {
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
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    output: () => ({ stdout, stderr }),
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eforest-watch-command-"));
  roots.push(root);
  saveWorkspace(root, {
    v: 1,
    identity: {
      server: "http://127.0.0.1",
      project: "test",
      repo: "watch",
      branch: "main",
      metadataStreamId: "fs:test/watch:main:meta",
    },
    headOffset: "-1",
    files: {},
  });
  await writeFile(join(root, ".ef", "complete"), COMPLETE_MARKER);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ef watch lifecycle", () => {
  it("reports stopped/running state and refuses a live second start", async () => {
    const root = await workspace();
    const stopped = capture();
    await expect(runWatchCommand(["status"], stopped.io, { cwd: root })).resolves.toBe(0);
    expect(stopped.output()).toEqual({ stdout: "stopped\n", stderr: "" });

    const statusJson = capture();
    await expect(runStatus(["--json", "--offline"], statusJson.io, { cwd: root })).resolves.toBe(0);
    expect(JSON.parse(statusJson.output().stdout)).toMatchObject({
      watch: { running: false },
    });

    await writeFile(join(root, ".ef", "watch.pid"), `${process.pid}\n`);
    const running = capture();
    await expect(runWatchCommand(["status"], running.io, { cwd: root })).resolves.toBe(0);
    expect(running.output()).toEqual({ stdout: `running ${process.pid}\n`, stderr: "" });

    const refused = capture();
    await expect(runWatchCommand(["start"], refused.io, { cwd: root })).resolves.toBe(3);
    expect(refused.output()).toEqual({
      stdout: "",
      stderr: `error: cli/watch-already-running: watcher is already running with pid ${process.pid}\n`,
    });
  });

  it("reclaims a dead pidfile loudly and refuses a stopped watcher", async () => {
    const root = await workspace();
    await writeFile(join(root, ".ef", "watch.pid"), "999999\n");
    const stale = capture();
    await expect(
      runWatchCommand(["start"], stale.io, {
        cwd: root,
        environment: { EF_HOME: join(root, "no-credentials") },
      }),
    ).resolves.toBe(10);
    expect(stale.output()).toEqual({
      stdout: "",
      stderr: "warning: reclaimed stale watcher pidfile\nNo credentials. Run `ef login`.\n",
    });

    const stopped = capture();
    await expect(runWatchCommand(["stop"], stopped.io, { cwd: root })).resolves.toBe(3);
    expect(stopped.output()).toEqual({
      stdout: "",
      stderr: "error: cli/watch-not-running: no watcher is running\n",
    });
  });
});
