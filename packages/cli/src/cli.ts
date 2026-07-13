import { resolve } from "node:path";
import { runBisect } from "./bisect-command.js";
import { materializeDump } from "./materialize-command.js";
import { replayDigest, ReplayCliError } from "./replay-command.js";

const REPLAY_USAGE = "Usage: ef replay <dump.jsonl> --digest [--reducer <module>]";
const BISECT_USAGE = "Usage: ef bisect <log-a.jsonl> <log-b.jsonl> [--reducer <module>] [--stats]";
const MATERIALIZE_USAGE =
  "Usage: ef materialize <dump.jsonl> --out <dir> [--at <offset>] [--reducer <module>]";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] === "materialize") {
    const path = args[1];
    let outPath: string | undefined;
    let at: string | undefined;
    let reducerPath: string | undefined;
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
      const options: { at?: string; reducerPath?: string } = {};
      if (at !== undefined) options.at = at;
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
  const path = args[1];
  if (!path || !args.includes("--digest")) {
    io.stderr(`${REPLAY_USAGE}\n`);
    return 2;
  }
  const reducerIndex = args.indexOf("--reducer");
  const allowedLength = reducerIndex >= 0 ? 5 : 3;
  if (args.length !== allowedLength || (reducerIndex >= 0 && !args[reducerIndex + 1])) {
    io.stderr(`${REPLAY_USAGE}\n`);
    return 2;
  }
  try {
    const reducer = reducerIndex >= 0 ? resolve(args[reducerIndex + 1]!) : undefined;
    const digest = await replayDigest(resolve(path), reducer);
    io.stdout(`${digest}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof ReplayCliError ? error.message : "unexpected replay failure"}\n`);
    return 1;
  }
}
