import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  evidenceManifest,
  generateTaskFolder,
  parseTaskFolder,
  renderTaskFolder,
  seededRandom,
  snapshotOfRendered,
  taskFolderDigest,
  taskFolderValue,
  type TaskFolderSnapshot,
  type TaskFolderV1,
} from "../src/index.js";
import { E6_T02_EVIDENCE, validFixture } from "./folder-fixture.js";

function corpus(): { seedStart: number; cases: number; corpusDigest: string } {
  const lines = readFileSync(join(E6_T02_EVIDENCE, "e6-t02-property.txt"), "utf8")
    .trim()
    .split("\n");
  const value = (key: string): string => {
    const line = lines.find((entry) => entry.startsWith(`${key}=`));
    expect(line, key).toBeDefined();
    return line!.slice(key.length + 1);
  };
  return {
    seedStart: Number.parseInt(value("seed-start"), 16),
    cases: Number(value("cases")),
    corpusDigest: value("corpus-sha256"),
  };
}

function parseOk(snapshot: TaskFolderSnapshot): TaskFolderV1 {
  const result = parseTaskFolder(snapshot);
  if (!result.ok) throw new Error(`${snapshot.folderName}: ${JSON.stringify(result.refusal)}`);
  return result.folder;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/** The exact line `tools/verify/e6_t02_property.mjs` prints per seed. */
export function propertyLine(seed: number): string {
  const first = parseOk(generateTaskFolder(seed));
  const once = renderTaskFolder(first);
  const second = parseOk(snapshotOfRendered(once));
  const twice = renderTaskFolder(second);
  if (once.files.length !== twice.files.length) throw new Error(`${seed}: render drift`);
  for (const [index, file] of once.files.entries()) {
    if (
      twice.files[index]!.path !== file.path ||
      !bytesEqual(twice.files[index]!.bytes, file.bytes)
    ) {
      throw new Error(`${seed}: render drift at ${file.path}`);
    }
  }
  const third = parseOk(snapshotOfRendered(twice));
  if (canonicalJson(taskFolderValue(third)) !== canonicalJson(taskFolderValue(second))) {
    throw new Error(`${seed}: canonical value drift`);
  }
  if (taskFolderDigest(second) !== taskFolderDigest(first))
    throw new Error(`${seed}: digest drift`);
  const readme = once.files.find((file) => file.path === "readme.md")!;
  return `${seed.toString(16)} ${taskFolderDigest(first)} ${sha256Hex(new TextEncoder().encode(canonicalJson(evidenceManifest(first))))} ${sha256Hex(readme.bytes)}`;
}

describe("E6-T02 canonical round trips over generated folders", () => {
  const { seedStart, cases, corpusDigest } = corpus();

  it("parses, renders, and reparses 1,000 generated folders canonically, matching the frozen corpus digest", () => {
    expect(cases).toBe(1000);
    const lines: string[] = [];
    let withWork = 0;
    let withEvidence = 0;
    let emptyLogs = 0;
    for (let index = 0; index < cases; index += 1) {
      const seed = seedStart + index;
      const snapshot = generateTaskFolder(seed);
      const folder = parseOk(snapshot);
      if (folder.work.length > 0) withWork += 1;
      if (folder.evidence.length > 0) withEvidence += 1;
      if (folder.readme.sections.at(-1)!.body === "") emptyLogs += 1;
      // The workshop inventory sees work/ but the durable digest never does.
      const scrubbed = parseOk({
        ...snapshot,
        entries: snapshot.entries.filter((entry) => !entry.path.startsWith("work/")),
      });
      expect(taskFolderDigest(scrubbed)).toBe(taskFolderDigest(folder));
      expect(scrubbed.work).toEqual([]);
      lines.push(propertyLine(seed));
    }
    expect(withWork).toBeGreaterThan(300);
    expect(withEvidence).toBeGreaterThan(500);
    expect(emptyLogs).toBeGreaterThan(100);
    expect(sha256Hex(new TextEncoder().encode(`${lines.join("\n")}\n`))).toBe(corpusDigest);
  });

  it("arbitrary binary evidence (NUL bytes, 0xff runs, empty files) survives byte-for-byte at nested paths", () => {
    const random = seededRandom(0xe602beef);
    const base = validFixture("E9-T01-minimal");
    for (let round = 0; round < 200; round += 1) {
      const length = Math.floor(random() * 2048);
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        const roll = random();
        bytes[index] =
          roll < 0.2 ? 0 : roll < 0.25 ? 0xff : roll < 0.3 ? 0x0a : Math.floor(random() * 256);
      }
      const depth = 1 + Math.floor(random() * 4);
      const path = `evidence/${Array.from({ length: depth }, (_, level) => `d${level}-${round}`).join("/")}.bin`;
      const folder = parseOk({
        ...base,
        entries: [...base.entries, { path, kind: "file", bytes }],
      });
      const rendered = renderTaskFolder(folder);
      const file = rendered.files.find((entry) => entry.path === path)!;
      expect(bytesEqual(file.bytes, bytes)).toBe(true);
      const again = parseOk(snapshotOfRendered(rendered));
      expect(again.evidence[0]!.sha256).toBe(sha256Hex(bytes));
      expect(again.evidence[0]!.size).toBe(length);
      expect(canonicalJson(evidenceManifest(again))).toBe(canonicalJson(evidenceManifest(folder)));
    }
  });
});
