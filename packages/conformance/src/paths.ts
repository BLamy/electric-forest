import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let packageDirectory = dirname(fileURLToPath(import.meta.url));
while (!existsSync(resolve(packageDirectory, "package.json"))) {
  const parent = dirname(packageDirectory);
  if (parent === packageDirectory) throw new Error("could not locate conformance package root");
  packageDirectory = parent;
}

export const repoRoot = resolve(packageDirectory, "../..");
