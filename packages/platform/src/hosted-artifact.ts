import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { previewArtifact, type PreviewArtifact } from "./preview-artifact.js";

export interface HostedArtifact extends PreviewArtifact {
  readonly revision: string;
}

export async function hostedArtifact(
  root: string,
  webRoot: string,
  revision: string,
): Promise<HostedArtifact> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("full source revision required");
  return { revision, ...(await previewArtifact(root, webRoot)) };
}

export async function verifyHostedArtifact(
  root: string,
  webRoot: string,
  revision: string,
  manifestPath: string,
): Promise<HostedArtifact> {
  const html = await readFile(resolve(webRoot, "index.html"), "utf8");
  const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1]!);
  if (!paths.some((path) => path.endsWith(".js")))
    throw new Error("hosted runtime requires built web assets");
  for (const path of paths) await readFile(resolve(webRoot, `.${path}`));
  const baked: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const actual = await hostedArtifact(root, webRoot, revision);
  if (JSON.stringify(baked) !== JSON.stringify(actual))
    throw new Error("hosted source/assets do not match the built manifest");
  return actual;
}
