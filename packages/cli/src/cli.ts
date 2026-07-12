import { resolve } from "node:path";
import { replayDigest, ReplayCliError } from "./replay-command.js";

const USAGE = "Usage: ef replay <dump.jsonl> --digest [--reducer <module>]";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] !== "replay") {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const path = args[1];
  if (!path || !args.includes("--digest")) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const reducerIndex = args.indexOf("--reducer");
  const allowedLength = reducerIndex >= 0 ? 5 : 3;
  if (args.length !== allowedLength || (reducerIndex >= 0 && !args[reducerIndex + 1])) {
    io.stderr(`${USAGE}\n`);
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
