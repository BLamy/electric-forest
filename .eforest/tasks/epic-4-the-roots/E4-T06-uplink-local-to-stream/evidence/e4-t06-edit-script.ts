import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Phase-gated shape used by the recorded E4-T06 run. */
export function runE4T06EditScript(root: string): void {
  const docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  const triple = join(docs, "triple.txt");
  writeFileSync(triple, "one\n");
  writeFileSync(triple, "two\n");
  writeFileSync(triple, "final\n");
  writeFileSync(join(docs, "old.txt"), "old\n");
  renameSync(join(docs, "old.txt"), join(docs, "renamed.txt"));
  rmSync(join(docs, "flap.txt"), { force: true });
  writeFileSync(join(root, ".ef", "journal.jsonl"), "internal\n");
}
