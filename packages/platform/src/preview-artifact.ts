import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface PreviewArtifact {
  readonly digest: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
}

/** Digest the emitted runtime and web bytes, independently of build timestamps and paths. */
export async function previewArtifact(root: string, webRoot: string): Promise<PreviewArtifact> {
  const paths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:js|mjs|html|css|svg|wasm|json)$/.test(entry.name)) paths.push(path);
    }
  };
  await walk(webRoot);
  for (const entry of await readdir(resolve(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await walk(resolve(root, "packages", entry.name, "dist"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const files = await Promise.all(
    paths.sort().map(async (path) => {
      const bytes = await readFile(path);
      return {
        path: relative(root, path).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      };
    }),
  );
  return { digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
