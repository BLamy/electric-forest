import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectBoth } from "./conformance.js";
import { firstDiffByte } from "./normalize.js";
import { repoRoot } from "./paths.js";

if (process.env.CONFORMANCE_REGEN !== "1") {
  console.error("refusing to regenerate conformance goldens: set CONFORMANCE_REGEN=1");
  process.exit(1);
}

const run = await collectBoth();
const [first, second] = run.variants;
if (first === undefined || second === undefined) throw new Error("both stores are required");
for (const name of Object.keys(first.transcripts).sort()) {
  const left = first.transcripts[name];
  const right = second.transcripts[name];
  if (left === undefined || right === undefined) throw new Error(`missing transcript ${name}`);
  const difference = firstDiffByte(left, right);
  if (difference >= 0) throw new Error(`${name} differs between stores at byte ${difference}`);
}

const directory = resolve(repoRoot, "packages/conformance/transcripts");
mkdirSync(directory, { recursive: true });
for (const [name, transcript] of Object.entries(first.transcripts).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  writeFileSync(join(directory, name), transcript);
  console.log(`rewrote ${join("packages/conformance/transcripts", name)}`);
}
