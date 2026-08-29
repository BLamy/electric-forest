import { resolve } from "node:path";
import { WorktreeDigestError } from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import type { CliIo } from "./cli.js";

export const TREE_DIGEST_USAGE = "Usage: ef tree-digest <dir>";

export function runTreeDigest(args: readonly string[], io: CliIo): number {
  if (args.length !== 1 || args[0]!.startsWith("--")) {
    io.stderr(`${TREE_DIGEST_USAGE}\n`);
    return 2;
  }
  try {
    io.stdout(`${worktreeDigestDirectory(resolve(args[0]!))}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `${error instanceof WorktreeDigestError ? error.message : error instanceof Error ? error.message : "tree-digest failed"}\n`,
    );
    return 1;
  }
}
