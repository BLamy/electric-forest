import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve("packages/streamfs/fixtures/patches");
const reducer = resolve("packages/streamfs/reducer.mjs");

function replay(path) {
  try {
    return {
      status: 0,
      digest: execFileSync(
        "pnpm",
        ["--silent", "ef", "replay", path, "--digest", "--reducer", reducer],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim(),
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      digest: "",
      stderr: error.stderr?.toString() ?? String(error),
    };
  }
}

async function records(path) {
  const source = await readFile(path, "utf8");
  return source
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function wireBytes(events) {
  return events.reduce((total, event) => {
    if (event.type === "fs.file.content") {
      return total + Buffer.from(event.payload.contentBase64, "base64").byteLength;
    }
    return total + Buffer.byteLength(canonicalJson(event.payload));
  }, 0);
}

function runTwice(path) {
  const first = replay(path);
  const second = replay(path);
  if (first.status !== 0 || second.status !== 0) {
    throw new Error(`replay failed for ${path}: ${first.stderr ?? second.stderr ?? "unknown error"}`);
  }
  if (first.digest !== second.digest) throw new Error(`nondeterministic replay for ${path}`);
  return first.digest;
}

async function sensitivity(fixture, path) {
  const events = await records(path);
  const lineIndex = events.findIndex(
    (event) =>
      event.type === "fs.file.patch" &&
      event.payload.ops.some((op) => op[0] === "+" && op[1].length > 0),
  );
  if (lineIndex < 0) throw new Error(`${fixture}: no patch insert available for sensitivity`);
  const event = events[lineIndex];
  const opIndex = event.payload.ops.findIndex((op) => op[0] === "+" && op[1].length > 0);
  const ops = event.payload.ops.map((op, index) =>
    index === opIndex ? ["+", `${op[1][0] === "x" ? "y" : "x"}${op[1].slice(1)}`] : op,
  );
  const mutated = { ...event, payload: { ...event.payload, ops } };
  const mutatedLines = events.map((candidate, index) =>
    canonicalJson(index === lineIndex ? mutated : candidate),
  );
  const temp = await mkdtemp(resolve(tmpdir(), "eforest-patch-sensitivity-"));
  const mutatedPath = resolve(temp, "mutated.jsonl");
  await writeFile(mutatedPath, `${mutatedLines.join("\n")}\n`);
  const originalLine = canonicalJson(event);
  const changedInsert = canonicalJson(mutated).indexOf(`"${ops[opIndex][1]}"`);
  const byteOffset = Buffer.byteLength(`${mutatedLines.slice(0, lineIndex).join("\n")}\n`) + changedInsert;
  const result = replay(mutatedPath);
  await rm(temp, { recursive: true, force: true });
  if (result.status === 0) {
    throw new Error(`${fixture}: grammar-preserving ops mutation unexpectedly replayed green`);
  }
  if (!originalLine.includes('"ops"')) throw new Error(`${fixture}: patch line lost ops field`);
  console.log(`MUTATION fixture=${fixture} field=ops byte=${byteOffset} EXPECTED-FAIL OK`);
}

const names = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (names.length < 3) throw new Error("patch fixture set is incomplete");

for (const name of names) {
  const fixture = resolve(root, name);
  const expected = JSON.parse(await readFile(resolve(fixture, "expected.json"), "utf8"));
  const patchedPath = resolve(fixture, "patched.events.jsonl");
  const fullwritePath = resolve(fixture, "fullwrite.events.jsonl");
  const patched = await records(patchedPath);
  const fullwrite = await records(fullwritePath);
  const patchDigest = runTwice(patchedPath);
  const fullDigest = runTwice(fullwritePath);
  const patchedBytes = wireBytes(patched);
  const fullwriteBytes = wireBytes(fullwrite);
  if (patchDigest !== fullDigest || patchDigest !== expected.treeDigest) {
    throw new Error(`${name}: digest parity mismatch`);
  }
  if (patchedBytes !== expected.patchedWireBytes || fullwriteBytes !== expected.fullwriteWireBytes) {
    console.error(`WIREBYTES-MISMATCH fixture=${name}`);
    throw new Error(`${name}: recomputed wire bytes disagree with expected.json`);
  }
  if (patchedBytes >= fullwriteBytes) throw new Error(`${name}: patch wire bytes did not win`);
  console.log(
    `fixture=${name} patchDigest=${patchDigest} fullDigest=${fullDigest} expected=${expected.treeDigest} patchBytes=${patchedBytes} fullBytes=${fullwriteBytes} OK`,
  );
  if (name === "mixed-fallback") {
    const types = patched.map((event) => event.type);
    if (!types.includes("fs.file.patch") || !types.includes("fs.file.write")) {
      throw new Error("mixed-fallback: patch-mode log does not contain both event kinds");
    }
  }
}

await sensitivity("small-edits", resolve(root, "small-edits/patched.events.jsonl"));
