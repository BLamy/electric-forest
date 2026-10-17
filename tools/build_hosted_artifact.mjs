#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hostedArtifact } from "../packages/platform/dist/src/hosted-artifact.js";
const root = resolve(import.meta.dirname, "..");
const revision = process.argv[2];
const destination = process.argv[3] ?? resolve(root, "production-artifact.json");
const artifact = await hostedArtifact(root, resolve(root, "apps/web/dist"), revision);
await writeFile(destination, JSON.stringify(artifact));
process.stdout.write(
  `hosted artifact revision=${artifact.revision} digest=${artifact.digest} files=${String(artifact.files.length)}\n`,
);
