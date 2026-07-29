#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CORPUS = path.join(
  ROOT,
  ".eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests/evidence",
);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return path.resolve(value);
}

function reducerFor(stream) {
  if (stream === "__identity__") return "packages/identity/reducer.mjs";
  if (stream === "__registry__") return "packages/platform/registry-reducer.mjs";
  if (stream.startsWith("ns:")) return "packages/platform/ns-reducer.mjs";
  if (/^fs:.*:file:/.test(stream)) return "tools/verify/canopy-content-reducer.mjs";
  if (/^fs:.*:meta$/.test(stream)) return "packages/streamfs/reducer.mjs";
  throw new Error(`unknown reducer class for ${stream}`);
}

function manifestKey(stream) {
  return stream.replaceAll(":", "_").replaceAll("/", "_").replaceAll("@", "_");
}

function compare() {
  const corpus = argument("--root", DEFAULT_CORPUS);
  const manifestPath = argument("--manifest", path.join(corpus, "corpus-manifest.json"));
  const failures = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    process.stderr.write(
      `CANOPY_MISMATCH key=manifest stream=manifest reason=${JSON.stringify(
        error instanceof Error ? error.message : String(error),
      )}\n`,
    );
    return 1;
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema !== "eforest.canopy-corpus.v1" ||
    manifest.streams === null ||
    typeof manifest.streams !== "object" ||
    Array.isArray(manifest.streams)
  ) {
    process.stderr.write(
      "CANOPY_MISMATCH key=manifest stream=manifest reason=invalid-manifest-schema\n",
    );
    return 1;
  }
  const entries = Object.entries(manifest.streams).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedFiles = new Set(entries.map(([key]) => `${key}.jsonl`));
  let actualFiles;
  try {
    actualFiles = fs
      .readdirSync(path.join(corpus, "dumps"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    process.stderr.write(
      `CANOPY_MISMATCH key=dumps stream=dumps reason=${JSON.stringify(
        error instanceof Error ? error.message : String(error),
      )}\n`,
    );
    return 1;
  }
  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) failures.push(["inventory", "inventory", `extra-dump:${file}`]);
  }
  for (const file of expectedFiles) {
    if (!actualFiles.includes(file))
      failures.push(["inventory", "inventory", `missing-dump:${file}`]);
  }
  const seenStreams = new Set();
  for (const [key, rawEntry] of entries) {
    const entry = rawEntry;
    const stream = entry?.stream;
    try {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof stream !== "string" ||
        typeof entry.dump !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.dump_sha256) ||
        typeof entry.head_offset !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.state_digest)
      ) {
        throw new Error("invalid-entry-schema");
      }
      if (seenStreams.has(stream)) throw new Error("duplicate-stream");
      seenStreams.add(stream);
      if (manifestKey(stream) !== key) throw new Error("manifest-key-mismatch");
      if (entry.dump !== `dumps/${key}.jsonl`) throw new Error("dump-path-mismatch");
      const dump = path.resolve(corpus, entry.dump);
      if (!dump.startsWith(`${path.resolve(corpus)}${path.sep}`))
        throw new Error("dump-path-escape");
      const bytes = fs.readFileSync(dump, "utf8");
      const dumpSha256 = createHash("sha256").update(bytes).digest("hex");
      if (dumpSha256 !== entry.dump_sha256) {
        throw new Error(`dump-sha256:${dumpSha256}!=${entry.dump_sha256}`);
      }
      const lines = bytes.trimEnd().split("\n");
      if (bytes.length === 0 || !bytes.endsWith("\n")) throw new Error("noncanonical-jsonl");
      const last = JSON.parse(lines.at(-1));
      if (last.offset !== entry.head_offset) {
        throw new Error(`head-offset:${String(last.offset)}!=${entry.head_offset}`);
      }
      const digest = execFileSync(
        process.execPath,
        [
          path.join(ROOT, "packages/cli/dist/src/bin.js"),
          "replay",
          dump,
          "--digest",
          "--reducer",
          path.join(ROOT, reducerFor(stream)),
        ],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (digest !== entry.state_digest) {
        throw new Error(`state-digest:${digest}!=${entry.state_digest}`);
      }
    } catch (error) {
      failures.push([
        key,
        typeof stream === "string" ? stream : "<invalid>",
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
  for (const [key, stream, reason] of failures) {
    process.stderr.write(
      `CANOPY_MISMATCH key=${key} stream=${stream} reason=${JSON.stringify(reason)}\n`,
    );
  }
  if (failures.length > 0) return 1;
  process.stdout.write(`CANOPY_COMPARE_OK streams=${entries.length}\n`);
  return 0;
}

process.exitCode = compare();
