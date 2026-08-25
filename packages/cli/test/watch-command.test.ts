import { save as saveWorkspace } from "@eforest/workspace";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { COMPLETE_MARKER } from "../src/clone-command.js";
import { runStatus } from "../src/status.js";
import { journalLine } from "../src/sync/journal.js";
import { runWatchCommand } from "../src/sync/watch-command.js";
import { storeCredentials } from "../src/credentials.js";
import { watchPidPath, watchReadyPath } from "../src/sync/watch-state.js";

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

async function authenticatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const environment = { EF_HOME: join(root, "credentials") };
  await storeCredentials(
    {
      accessToken: "header.payload.signature",
      tokenType: "Bearer",
      issuer: "https://issuer.example.test",
      clientId: "e4-t08-test",
      scopes: ["write"],
    },
    environment,
  );
  return environment;
}

function readyChild(root: string): ChildProcess {
  writeFileSync(watchReadyPath(root), `${process.pid}\n`);
  return {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    unref: () => undefined,
    kill: () => true,
  } as unknown as ChildProcess;
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
    const environment = await authenticatedEnvironment(root);
    await writeFile(join(root, ".ef", "watch.pid"), "999999\n");
    const stale = capture();
    await expect(
      runWatchCommand(["start"], stale.io, {
        cwd: root,
        environment,
        spawnProcess: () => readyChild(root),
      }),
    ).resolves.toBe(0);
    expect(stale.output()).toEqual({
      stdout: "",
      stderr: "warning: reclaimed stale watcher pidfile\n",
    });
    await rm(watchPidPath(root), { force: true });
    await rm(watchReadyPath(root), { force: true });

    const stopped = capture();
    await expect(runWatchCommand(["stop"], stopped.io, { cwd: root })).resolves.toBe(3);
    expect(stopped.output()).toEqual({
      stdout: "",
      stderr: "error: cli/watch-not-running: no watcher is running\n",
    });
  });

  it("uses the pidfile reservation as an atomic concurrent-start fence", async () => {
    const root = await workspace();
    const environment = await authenticatedEnvironment(root);
    const first = capture();
    const second = capture();
    const [firstExit, secondExit] = await Promise.all([
      runWatchCommand(["start"], first.io, {
        cwd: root,
        environment,
        spawnProcess: () => readyChild(root),
      }),
      runWatchCommand(["start"], second.io, {
        cwd: root,
        environment,
        spawnProcess: () => readyChild(root),
      }),
    ]);
    expect([firstExit, secondExit].sort()).toEqual([0, 3]);
    const refusal = firstExit === 3 ? first.output() : second.output();
    expect(refusal.stdout).toBe("");
    expect(refusal.stderr).toBe(
      `error: cli/watch-already-running: watcher is already running with pid ${process.pid}\n`,
    );
    await rm(watchPidPath(root), { force: true });
    await rm(watchReadyPath(root), { force: true });
  });

  it("renews the graceful-stop deadline while durable journal progress continues", async () => {
    const root = await workspace();
    const journal = join(root, ".ef", "journal.jsonl");
    const first = journalLine({
      seq: 1,
      kind: "accepted",
      action: "fs.file.write",
      path: "first.txt",
      base: "base-0",
      offset: "0000000000000000_0000000000000000",
    });
    const second = journalLine({
      seq: 2,
      kind: "accepted",
      action: "fs.file.write",
      path: "second.txt",
      base: "base-1",
      offset: "0000000000000000_0000000000000001",
    });
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { appendFileSync } = require("node:fs");
const journal = process.argv[1];
const first = process.argv[2];
const second = process.argv[3];
process.once("SIGTERM", () => {
  setTimeout(() => appendFileSync(journal, first), 600);
  setTimeout(() => appendFileSync(journal, second.slice(0, Math.floor(second.length / 2))), 1_200);
  setTimeout(() => appendFileSync(journal, second.slice(Math.floor(second.length / 2))), 1_400);
  setTimeout(() => process.exit(0), 1_800);
});
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);`,
        journal,
        first,
        second,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout?.once("data", () => resolve());
      });
      await writeFile(watchPidPath(root), `${child.pid!}\n`);
      await writeFile(watchReadyPath(root), `${child.pid!}\n`);
      const started = Date.now();

      const result = await runWatchCommand(["stop"], capture().io, {
        cwd: root,
        timeoutMs: 1_000,
      });

      expect(result).toBe(0);
      expect(Date.now() - started).toBeGreaterThan(1_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    }
  });

  it("does not renew the graceful-stop deadline for metadata or byte-identical churn", async () => {
    for (const mode of ["metadata", "rewrite", "replace"] as const) {
      const root = await workspace();
      const journal = join(root, ".ef", "journal.jsonl");
      await writeFile(
        journal,
        journalLine({
          seq: 1,
          kind: "accepted",
          action: "fs.file.write",
          path: "steady.txt",
          base: "base-0",
          offset: "0000000000000000_0000000000000000",
        }),
      );
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const { readFileSync, renameSync, utimesSync, writeFileSync } = require("node:fs");
const journal = process.argv[1];
const mode = process.argv[2];
const bytes = readFileSync(journal);
process.once("SIGTERM", () => {
  const timer = setInterval(() => {
    if (mode === "metadata") {
      const now = new Date();
      utimesSync(journal, now, now);
    } else if (mode === "rewrite") {
      writeFileSync(journal, bytes);
    } else {
      const replacement = journal + ".replacement";
      writeFileSync(replacement, bytes);
      renameSync(replacement, journal);
    }
  }, 35);
  setTimeout(() => clearInterval(timer), 500);
});
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);`,
          journal,
          mode,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.stdout?.once("data", () => resolve());
        });
        await writeFile(watchPidPath(root), `${child.pid!}\n`);
        await writeFile(watchReadyPath(root), `${child.pid!}\n`);
        const io = capture();
        const started = Date.now();

        const result = await runWatchCommand(["stop"], io.io, { cwd: root, timeoutMs: 150 });

        expect(result, mode).toBe(3);
        expect(Date.now() - started, mode).toBeLessThan(400);
        expect(io.output().stderr, mode).toBe(
          "error: cli/watch-stop-timeout: watcher did not stop gracefully\n",
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        }
      }
    }
  });

  it("does not renew the graceful-stop deadline for incomplete journal records", async () => {
    const root = await workspace();
    const journal = join(root, ".ef", "journal.jsonl");
    await writeFile(
      journal,
      journalLine({
        seq: 1,
        kind: "accepted",
        action: "fs.file.write",
        path: "steady.txt",
        base: "base-0",
        offset: "0000000000000000_0000000000000000",
      }),
    );
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { appendFileSync } = require("node:fs");
const journal = process.argv[1];
process.once("SIGTERM", () => {
  const timer = setInterval(() => appendFileSync(journal, "{"), 35);
  setTimeout(() => clearInterval(timer), 500);
});
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);`,
        journal,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout?.once("data", () => resolve());
      });
      await writeFile(watchPidPath(root), `${child.pid!}\n`);
      await writeFile(watchReadyPath(root), `${child.pid!}\n`);
      const io = capture();
      const started = Date.now();

      const result = await runWatchCommand(["stop"], io.io, { cwd: root, timeoutMs: 150 });

      expect(result).toBe(3);
      expect(Date.now() - started).toBeLessThan(400);
      expect(io.output().stderr).toBe(
        "error: cli/watch-stop-timeout: watcher did not stop gracefully\n",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    }
  });
});
