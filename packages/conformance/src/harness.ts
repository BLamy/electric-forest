import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./paths.js";

export type StoreVariant = "memory" | "file";

export interface RunningServer {
  readonly variant: StoreVariant;
  readonly baseUrl: string;
  readonly dataDir: string;
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

let built = false;

function ensureBuilt(): void {
  if (built) return;
  execFileSync("pnpm", ["build"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  built = true;
}

function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("conformance server did not start")), 5_000);
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("LISTENING ")) {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          resolveUrl(line.slice("LISTENING ".length));
          return;
        }
        newline = buffer.indexOf("\n");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== null)
        reject(
          new Error(
            `server exited before listen: ${code}/${signal}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
          ),
        );
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

export async function startServer(variant: StoreVariant): Promise<RunningServer> {
  ensureBuilt();
  const repo = repoRoot;
  const dataDir = mkdtempSync(join(tmpdir(), `eforest-conformance-${variant}-`));
  const childPath = join(repo, "packages/conformance/dist/src/server-child.js");
  const args = [childPath, "--store", variant, "--data-dir", dataDir];
  const child = spawn(process.execPath, args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", () => undefined);
  const baseUrl = await waitForListening(child);
  return {
    variant,
    baseUrl,
    dataDir,
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child);
      if (variant === "file") {
        const names = readdirSync(dataDir);
        const streamDir = join(dataDir, "streams");
        const streamNames = readdirSync(streamDir);
        if (
          names.length !== 1 ||
          names[0] !== "streams" ||
          streamNames.some((name) => !name.startsWith("stream-") || !name.endsWith(".log"))
        ) {
          throw new Error(
            `file store data directory contains unexpected state: ${[...names, ...streamNames].join(",")}`,
          );
        }
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
