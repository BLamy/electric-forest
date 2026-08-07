import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runBisect } from "./bisect-command.js";
import { materializeDump } from "./materialize-command.js";
import { snapshotOutput, snapshotStreamUrl } from "./snapshot-command.js";
import { runMergeCommand } from "./merge-command.js";
import { clearCredentials } from "./credentials.js";
import { runLogin } from "./commands/login.js";
import { runAuthenticatedDispatch } from "./dispatch-command.js";
import { runRegistryCommand } from "./registry-command.js";
import {
  bootstrapDigest,
  replayBranchDigest,
  replayDigest,
  ReplayCliError,
  type BranchReplayOptions,
} from "./replay-command.js";
import { runTreeDigest } from "./worktree-command.js";
import { runInit } from "./init-command.js";
import { runClone, runWorkspaceCheck } from "./clone-command.js";
import { runStatus } from "./status.js";
import { runBranch, runCheckout } from "./branch-checkout-command.js";
import { runWatch } from "./sync/uplink.js";
import { runDownlinkWatch, runJournalVerify } from "./sync/downlink.js";
import { runWatchCommand } from "./sync/watch-command.js";

const REPLAY_USAGE =
  "Usage: ef replay <dump.jsonl> (--digest|--worktree-digest) [--parent <dump.jsonl> --parent-stream-id <stream-id> ...] [--merge-source <dump.jsonl> ...] [--until <offset>] [--emit-log <path>] [--reducer <module>] | ef replay --bootstrap <artifact> --tail <dump.jsonl> (--digest|--worktree-digest) [--reducer <module>]";
const BISECT_USAGE = "Usage: ef bisect <log-a.jsonl> <log-b.jsonl> [--reducer <module>] [--stats]";
const MATERIALIZE_USAGE =
  "Usage: ef materialize <dump.jsonl> --out <dir> [--content <content.jsonl> ...] [--at <offset>] [--reducer <module>] [--tree-digest|--worktree-digest]";
const SNAPSHOT_USAGE = "Usage: ef snapshot <stream-url>";
const MERGE_USAGE =
  "Usage: ef merge <target-stream-url> <source-stream-url> (--ff-only | --three-way)";

function dumpHasMergeEvent(path: string | undefined): boolean {
  if (path === undefined || path.startsWith("--")) return false;
  try {
    return readFileSync(resolve(path), "utf8")
      .split("\n")
      .some((line) => {
        try {
          return (JSON.parse(line) as { readonly type?: unknown }).type === "fs.branch.merge";
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] === "clone") {
    return runClone(args.slice(1), io);
  }
  if (args[0] === "workspace") {
    return runWorkspaceCheck(args.slice(1), io);
  }
  if (args[0] === "init") {
    return runInit(args.slice(1), io);
  }
  if (args[0] === "login") {
    if (args.length > 2 || (args.length === 2 && args[1] !== "--no-browser")) {
      io.stderr("Usage: ef login [--no-browser]\n");
      return 2;
    }
    try {
      return await runLogin(args[1] === "--no-browser", io);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : "login failed"}\n`);
      return 1;
    }
  }
  if (args[0] === "logout") {
    if (args.length !== 1) {
      io.stderr("Usage: ef logout\n");
      return 2;
    }
    await clearCredentials();
    io.stdout("Logged out.\n");
    return 0;
  }
  if (args[0] === "dispatch") {
    if (args.length !== 3) {
      io.stderr("Usage: ef dispatch <stream-id> <event-json>\n");
      return 2;
    }
    try {
      return await runAuthenticatedDispatch(args[1]!, args[2]!, io);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : "dispatch failed"}\n`);
      return 1;
    }
  }
  if (args[0] === "registry") {
    return runRegistryCommand(args.slice(1), io);
  }
  if (args[0] === "tree-digest") {
    return runTreeDigest(args.slice(1), io);
  }
  if (args[0] === "status") {
    return runStatus(args.slice(1), io);
  }
  if (args[0] === "branch") {
    return runBranch(args.slice(1), io);
  }
  if (args[0] === "checkout") {
    return runCheckout(args.slice(1), io);
  }
  if (args[0] === "watch") {
    if (
      args[1] === "start" ||
      args[1] === "stop" ||
      args[1] === "status" ||
      args[1] === "--daemon"
    ) {
      return runWatchCommand(args.slice(1), io);
    }
    if (args[1] === "--down") return runDownlinkWatch(args.slice(1), io);
    return runWatch(args.slice(1), io);
  }
  if (args[0] === "journal") {
    return runJournalVerify(args.slice(1), io);
  }
  if (args[0] === "merge") {
    if (args.length !== 4 || (args[3] !== "--ff-only" && args[3] !== "--three-way")) {
      io.stderr(`${MERGE_USAGE}\n`);
      return 2;
    }
    return runMergeCommand(
      args[1]!,
      args[2]!,
      io,
      args[3] === "--ff-only" ? "ff-only" : "three-way",
    );
  }
  if (args[0] === "snapshot") {
    if (args.length !== 2) {
      io.stderr(`${SNAPSHOT_USAGE}\n`);
      return 2;
    }
    try {
      io.stdout(`${snapshotOutput(await snapshotStreamUrl(args[1]!))}\n`);
      return 0;
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : "unexpected snapshot failure"}\n`);
      return 1;
    }
  }
  if (args[0] === "materialize") {
    const path = args[1];
    let outPath: string | undefined;
    let at: string | undefined;
    let reducerPath: string | undefined;
    // Preserve E1's default tree digest; E4 callers opt into the content-only
    // projection explicitly with --worktree-digest.
    let digestKind: "tree" | "worktree" = "tree";
    let digestFlagSeen = false;
    const contentPaths: string[] = [];
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index]!;
      if (
        argument === "--out" &&
        outPath === undefined &&
        args[index + 1] &&
        !args[index + 1]!.startsWith("--")
      ) {
        outPath = resolve(args[++index]!);
      } else if (
        argument === "--at" &&
        at === undefined &&
        args[index + 1] &&
        !args[index + 1]!.startsWith("--")
      ) {
        at = args[++index]!;
      } else if (
        argument === "--reducer" &&
        reducerPath === undefined &&
        args[index + 1] &&
        !args[index + 1]!.startsWith("--")
      ) {
        reducerPath = resolve(args[++index]!);
      } else if (
        (argument === "--tree-digest" || argument === "--worktree-digest") &&
        !digestFlagSeen
      ) {
        digestFlagSeen = true;
        digestKind = argument === "--tree-digest" ? "tree" : "worktree";
      } else if (
        argument === "--content" &&
        args[index + 1] &&
        !args[index + 1]!.startsWith("--")
      ) {
        contentPaths.push(resolve(args[++index]!));
      } else {
        io.stderr(`${MATERIALIZE_USAGE}\n`);
        return 2;
      }
    }
    if (!path || !outPath) {
      io.stderr(`${MATERIALIZE_USAGE}\n`);
      return 2;
    }
    try {
      const options: {
        at?: string;
        contentPaths?: readonly string[];
        reducerPath?: string;
        digestKind?: "tree" | "worktree";
      } = { digestKind };
      if (at !== undefined) options.at = at;
      if (contentPaths.length > 0) options.contentPaths = contentPaths;
      if (reducerPath !== undefined) options.reducerPath = reducerPath;
      const digest = await materializeDump(resolve(path), outPath, options);
      io.stdout(`${digest}\n`);
      return 0;
    } catch (error) {
      io.stderr(
        `${error instanceof ReplayCliError ? error.message : "unexpected materialize failure"}\n`,
      );
      return 1;
    }
  }

  if (args[0] === "bisect") {
    const paths: string[] = [];
    let reducerPath: string | undefined;
    let stats = false;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--stats") {
        if (stats) {
          io.stderr(`${BISECT_USAGE}\n`);
          return 2;
        }
        stats = true;
      } else if (argument === "--reducer") {
        if (reducerPath !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--")) {
          io.stderr(`${BISECT_USAGE}\n`);
          return 2;
        }
        reducerPath = resolve(args[index + 1]!);
        index += 1;
      } else if (argument.startsWith("--")) {
        io.stderr(`${BISECT_USAGE}\n`);
        return 2;
      } else {
        paths.push(resolve(argument));
      }
    }
    if (paths.length !== 2) {
      io.stderr(`${BISECT_USAGE}\n`);
      return 2;
    }
    try {
      const options = { stats } as { reducerPath?: string; stats: boolean };
      if (reducerPath !== undefined) options.reducerPath = reducerPath;
      return await runBisect(paths[0]!, paths[1]!, io, options);
    } catch (error) {
      io.stderr(
        `${error instanceof ReplayCliError ? error.message : "unexpected bisect failure"}\n`,
      );
      return 2;
    }
  }

  if (args[0] !== "replay") {
    io.stderr(`${REPLAY_USAGE}\n`);
    return 2;
  }
  const digestFlag = args.includes("--digest");
  const worktreeDigestFlag = args.includes("--worktree-digest");
  if (digestFlag === worktreeDigestFlag) {
    io.stderr(`${REPLAY_USAGE}\n`);
    return 2;
  }
  const digestKind: "tree" | "worktree" = worktreeDigestFlag ? "worktree" : "tree";
  const bootstrapIndex = args.indexOf("--bootstrap");
  const tailIndex = args.indexOf("--tail");
  const reducerIndex = args.indexOf("--reducer");
  const reducerPath = reducerIndex >= 0 ? args[reducerIndex + 1] : undefined;
  if (reducerIndex >= 0 && (!reducerPath || reducerPath.startsWith("--"))) {
    io.stderr(`${REPLAY_USAGE}\n`);
    return 2;
  }
  if (
    args.includes("--parent") ||
    args.includes("--merge-source") ||
    args.includes("--until") ||
    args.includes("--emit-log") ||
    dumpHasMergeEvent(args[1])
  ) {
    const path = args[1];
    const parentPaths: string[] = [];
    const parentStreamIds: string[] = [];
    const mergeSourcePaths: string[] = [];
    let until: string | undefined;
    let emitLogPath: string | undefined;
    let branchReducerPath: string | undefined;
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index]!;
      const value = args[index + 1];
      if (argument === "--digest" || argument === "--worktree-digest") {
        continue;
      } else if (argument === "--parent" && value !== undefined && !value.startsWith("--")) {
        parentPaths.push(resolve(value));
        index += 1;
      } else if (
        argument === "--parent-stream-id" &&
        value !== undefined &&
        !value.startsWith("--")
      ) {
        parentStreamIds.push(value);
        index += 1;
      } else if (argument === "--merge-source" && value !== undefined && !value.startsWith("--")) {
        mergeSourcePaths.push(resolve(value));
        index += 1;
      } else if (
        argument === "--until" &&
        value !== undefined &&
        !value.startsWith("--") &&
        until === undefined
      ) {
        until = value;
        index += 1;
      } else if (
        argument === "--emit-log" &&
        value !== undefined &&
        !value.startsWith("--") &&
        emitLogPath === undefined
      ) {
        emitLogPath = resolve(value);
        index += 1;
      } else if (
        argument === "--reducer" &&
        value !== undefined &&
        !value.startsWith("--") &&
        branchReducerPath === undefined
      ) {
        branchReducerPath = resolve(value);
        index += 1;
      } else {
        io.stderr(`${REPLAY_USAGE}\n`);
        return 2;
      }
    }
    if (!path) {
      io.stderr(`${REPLAY_USAGE}\n`);
      return 2;
    }
    try {
      const options: BranchReplayOptions = {
        ...(parentPaths.length === 0 ? {} : { parentPaths }),
        ...(parentStreamIds.length === 0 ? {} : { parentStreamIds }),
        ...(mergeSourcePaths.length === 0 ? {} : { mergeSourcePaths }),
        ...(until === undefined ? {} : { until: until as import("@eforest/protocol").Offset }),
        ...(emitLogPath === undefined ? {} : { emitLogPath }),
      };
      io.stdout(
        `${await replayBranchDigest(resolve(path), options, branchReducerPath, digestKind)}\n`,
      );
      return 0;
    } catch (error) {
      if (error instanceof ReplayCliError && error.mergeRejection) {
        io.stderr(
          `${JSON.stringify({ error: { class: "validator-rejected", reason: error.message } })}\n`,
        );
      } else {
        io.stderr(
          `${error instanceof ReplayCliError ? error.message : error instanceof Error ? error.message : "unexpected replay failure"}\n`,
        );
      }
      return 1;
    }
  }
  try {
    if (bootstrapIndex >= 0 || tailIndex >= 0) {
      const artifact = args[bootstrapIndex + 1];
      const tail = args[tailIndex + 1];
      if (
        bootstrapIndex !== 1 ||
        tailIndex !== 3 ||
        !artifact ||
        !tail ||
        bootstrapIndex >= tailIndex ||
        (reducerIndex >= 0 && reducerIndex !== 6) ||
        args.length !== (reducerIndex >= 0 ? 8 : 6)
      ) {
        io.stderr(`${REPLAY_USAGE}\n`);
        return 2;
      }
      const digest = await bootstrapDigest(
        resolve(artifact),
        resolve(tail),
        reducerPath === undefined ? undefined : resolve(reducerPath),
        digestKind,
      );
      io.stdout(`${digest}\n`);
      return 0;
    }
    const path = args[1];
    const allowedLength = reducerIndex >= 0 ? 5 : 3;
    if (!path || args.length !== allowedLength || (reducerIndex >= 0 && reducerIndex !== 3)) {
      io.stderr(`${REPLAY_USAGE}\n`);
      return 2;
    }
    const reducer = reducerPath === undefined ? undefined : resolve(reducerPath);
    const digest = await replayDigest(resolve(path), reducer, digestKind);
    io.stdout(`${digest}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof ReplayCliError ? error.message : "unexpected replay failure"}\n`);
    return 1;
  }
}
