import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { canonicalJson } from "@eforest/protocol";
import { expect } from "vitest";
import { readTaskFolderSnapshot } from "../io/disk.js";
import { type FolderEntry, type TaskFolderSnapshot } from "../src/index.js";

export const E6_T02_EVIDENCE = fileURLToPath(
  new URL(
    "../../../.eforest/tasks/epic-6-the-loop/E6-T02-task-folder-contract/evidence/",
    import.meta.url,
  ),
);
export const FIXTURES = join(E6_T02_EVIDENCE, "fixtures");

export function validFixtureNames(): readonly string[] {
  return readdirSync(join(FIXTURES, "valid")).sort();
}

export function validFixture(name: string): TaskFolderSnapshot {
  return readTaskFolderSnapshot(join(FIXTURES, "valid", name));
}

export function invalidDiskFixtures(): readonly { name: string; snapshot: TaskFolderSnapshot }[] {
  return readdirSync(join(FIXTURES, "invalid"))
    .sort()
    .map((name) => {
      const [folder] = readdirSync(join(FIXTURES, "invalid", name));
      return { name, snapshot: readTaskFolderSnapshot(join(FIXTURES, "invalid", name, folder!)) };
    });
}

interface InlineEntry {
  readonly path: string;
  readonly kind: FolderEntry["kind"];
  readonly text?: string;
  readonly base64?: string;
}

export function invalidInlineFixtures(): readonly { name: string; snapshot: TaskFolderSnapshot }[] {
  const cases = JSON.parse(
    readFileSync(join(FIXTURES, "invalid-snapshots.json"), "utf8"),
  ) as readonly {
    name: string;
    folderName: string;
    entries: readonly InlineEntry[];
  }[];
  return cases.map((scenario) => ({
    name: scenario.name,
    snapshot: {
      folderName: scenario.folderName,
      entries: scenario.entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        ...(entry.text !== undefined
          ? { bytes: new TextEncoder().encode(entry.text) }
          : entry.base64 !== undefined
            ? { bytes: new Uint8Array(Buffer.from(entry.base64, "base64")) }
            : {}),
      })),
    },
  }));
}

export interface Golden {
  readonly value: unknown;
  readonly digest: string;
  readonly rendered: readonly { path: string; size: number; sha256: string }[];
}

export function golden(id: string): Golden {
  const source = readFileSync(join(E6_T02_EVIDENCE, "goldens", `${id}.json`), "utf8");
  expect(source.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(source) as Golden;
  expect(canonicalJson(parsed), `${id}.json canonical`).toBe(source.slice(0, -1));
  return parsed;
}

export function goldenReadme(id: string): Uint8Array {
  return new Uint8Array(readFileSync(join(E6_T02_EVIDENCE, "goldens", `${id}.readme.md`)));
}

export interface RefusalTranscriptLine {
  readonly name: string;
  readonly source: "disk" | "inline";
  readonly folderName: string;
  readonly ok: boolean;
  readonly refusal: unknown;
}

export function refusalTranscript(): readonly RefusalTranscriptLine[] {
  const source = readFileSync(join(E6_T02_EVIDENCE, "e6-t02-refusals.txt"), "utf8");
  expect(source.endsWith("\n")).toBe(true);
  return source
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      expect(line.startsWith("E6_T02_REFUSAL ")).toBe(true);
      return JSON.parse(line.slice("E6_T02_REFUSAL ".length)) as RefusalTranscriptLine;
    });
}
