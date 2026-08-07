import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Phase-gated shape used by the recorded E4-T06 run. */
export async function runE4T06EditScript(
  root: string,
  flush: () => Promise<unknown>,
): Promise<void> {
  const docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "old.txt"), "old\n");
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  await flush();

  const triple = join(docs, "triple.txt");
  writeFileSync(triple, "one\n");
  writeFileSync(triple, "two\n");
  writeFileSync(triple, "final\n");
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  await flush();

  renameSync(join(docs, "old.txt"), join(docs, "renamed.txt"));
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  await flush();
  rmSync(join(docs, "flap.txt"), { force: true });
  writeFileSync(join(root, ".ef", "ignored.tmp"), "internal\n");
}
