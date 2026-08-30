import { canonicalJson, sha256Hex } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  TASK_FOLDER_REFUSAL_REASONS,
  TASK_FRONTMATTER_KEYS,
  TASK_SECTIONS,
  evidenceManifest,
  parseTaskFolder,
  parseTaskReadme,
  renderTaskFolder,
  renderTaskReadme,
  snapshotOfRendered,
  taskFolderDigest,
  taskFolderValue,
  type TaskFolderSnapshot,
  type TaskFolderV1,
} from "../src/index.js";
import {
  golden,
  goldenReadme,
  invalidDiskFixtures,
  invalidInlineFixtures,
  refusalTranscript,
  validFixture,
  validFixtureNames,
} from "./folder-fixture.js";

const encoder = new TextEncoder();

function parseOk(snapshot: TaskFolderSnapshot): TaskFolderV1 {
  const result = parseTaskFolder(snapshot);
  if (!result.ok) throw new Error(`${result.refusal.reason} ${JSON.stringify(result.refusal)}`);
  return result.folder;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

describe("E6-T02 frozen valid fixtures", () => {
  it("has the three frozen fixtures", () => {
    expect(validFixtureNames()).toEqual([
      "E9-T01-minimal",
      "E9-T02-complete",
      "E9-T03-noncanonical",
    ]);
  });

  for (const name of validFixtureNames()) {
    it(`${name}: parse -> render matches the committed golden byte-for-byte`, () => {
      const folder = parseOk(validFixture(name));
      const frozen = golden(folder.id);
      expect(canonicalJson(taskFolderValue(folder))).toBe(canonicalJson(frozen.value));
      expect(taskFolderDigest(folder)).toBe(frozen.digest);
      const rendered = renderTaskFolder(folder);
      expect(
        rendered.files.map((file) => ({
          path: file.path,
          size: file.bytes.byteLength,
          sha256: sha256Hex(file.bytes),
        })),
      ).toEqual(frozen.rendered);
      const readme = rendered.files.find((file) => file.path === "readme.md")!;
      expect(bytesEqual(readme.bytes, goldenReadme(folder.id))).toBe(true);
    });

    it(`${name}: parse -> render -> parse is a fixed point`, () => {
      const first = parseOk(validFixture(name));
      const once = renderTaskFolder(first);
      const second = parseOk(snapshotOfRendered(once));
      const twice = renderTaskFolder(second);
      expect(once.files.length).toBe(twice.files.length);
      for (const [index, file] of once.files.entries()) {
        expect(twice.files[index]!.path).toBe(file.path);
        expect(bytesEqual(twice.files[index]!.bytes, file.bytes), file.path).toBe(true);
      }
      expect(canonicalJson(taskFolderValue(parseOk(snapshotOfRendered(twice))))).toBe(
        canonicalJson(taskFolderValue(second)),
      );
      expect(taskFolderDigest(second)).toBe(taskFolderDigest(first));
    });
  }

  it("E9-T01 and E9-T02 are already canonical; E9-T03 is rewritten (comments, quotes, order)", () => {
    for (const [name, identical] of [
      ["E9-T01-minimal", true],
      ["E9-T02-complete", true],
      ["E9-T03-noncanonical", false],
    ] as const) {
      const snapshot = validFixture(name);
      const source = snapshot.entries.find((entry) => entry.path === "readme.md")!.bytes!;
      const rendered = encoder.encode(renderTaskReadme(parseOk(snapshot)));
      expect(bytesEqual(source, rendered), name).toBe(identical);
    }
    const folder = parseOk(validFixture("E9-T03-noncanonical"));
    expect(folder.frontmatter.title).toBe("Plain title that did not need quotes");
    expect(folder.frontmatter.priority).toBe("903.5");
    expect(folder.frontmatter.depends_on).toEqual(["E9-T01", "E9-T02", "E8"]);
    expect(
      renderTaskReadme(folder).startsWith(
        "---\nid: E9-T03\nepic: 9\ntitle: Plain title that did not need quotes\npriority: 903.5\n",
      ),
    ).toBe(true);
  });

  it("E9-T02: --- in the body, fenced headings, nested binary evidence with NUL bytes, spans", () => {
    const folder = parseOk(validFixture("E9-T02-complete"));
    expect(folder.readme.sections.map((section) => section.name)).toEqual([...TASK_SECTIONS]);
    const goal = folder.readme.sections[0]!;
    expect(goal.body).toContain("\n---\n");
    expect(goal.body).toContain("```md\n## Goal\n## Context\n---\n```\n");
    expect(folder.readme.sections[1]!.body).toContain("~~~\n## Deliverables\n~~~\n");
    expect(folder.frontmatter.title).toBe(
      "Complete task: binary evidence, nested paths, and a --- in the body",
    );
    const blob = folder.evidence.find((file) => file.path === "nested/deep/blob.bin")!;
    expect(blob.size).toBe(4096);
    expect(blob.bytes.includes(0)).toBe(true);
    expect(blob.bytes[4095]).toBe(0);
    expect(folder.evidence.find((file) => file.path === "empty.bin")!.sha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(evidenceManifest(folder).map((entry) => entry.path)).toEqual([
      ".ef/state.json",
      "ABC.txt",
      "abd.txt",
      "empty.bin",
      "nested/deep/blob.bin",
      "nested/zeros.bin",
      "notes.txt",
    ]);
    const readmeBytes = encoder.encode(renderTaskReadme(folder));
    for (const section of folder.readme.sections) {
      const heading = readmeBytes.slice(section.heading.startByte, section.heading.endByte);
      expect(new TextDecoder().decode(heading)).toBe(`## ${section.name}\n`);
      const body = readmeBytes.slice(section.heading.endByte, section.span.endByte);
      expect(new TextDecoder().decode(body)).toBe(section.body);
      expect(section.span.startByte).toBe(section.heading.startByte);
      expect(section.span.startLine).toBe(section.heading.startLine);
    }
    expect(folder.readme.sections.at(-1)!.span.endByte).toBe(readmeBytes.byteLength);
  });

  it("E9-T01: an empty Verification log survives and the frontmatter has exactly the eight keys", () => {
    const folder = parseOk(validFixture("E9-T01-minimal"));
    expect(folder.readme.sections.at(-1)!.body).toBe("");
    expect(Object.keys(folder.frontmatter)).toEqual([...TASK_FRONTMATTER_KEYS]);
    expect(folder.evidence).toEqual([]);
    expect(folder.work).toEqual([]);
  });
});

describe("E6-T02 work/ is a workshop inventory, never durable", () => {
  it("changing only work/ leaves digest and manifest byte-identical; changing evidence moves the digest", () => {
    const base = validFixture("E9-T02-complete");
    const before = parseOk(base);
    const withWork = parseOk({
      ...base,
      entries: [
        ...base.entries,
        { path: "work/probe.log", kind: "file", bytes: encoder.encode("scratch\n") },
        { path: "work/nested/x.bin", kind: "file", bytes: new Uint8Array([0, 1, 2]) },
      ],
    });
    expect(withWork.work.map((entry) => entry.path)).toEqual(["nested/x.bin", "probe.log"]);
    expect(taskFolderDigest(withWork)).toBe(taskFolderDigest(before));
    expect(canonicalJson(evidenceManifest(withWork))).toBe(canonicalJson(evidenceManifest(before)));
    expect(renderTaskFolder(withWork).files.some((file) => file.path.startsWith("work/"))).toBe(
      false,
    );
    const entries = base.entries.map((entry) => {
      if (entry.path !== "evidence/nested/deep/blob.bin") return entry;
      const bytes = new Uint8Array(entry.bytes!);
      bytes[0] = bytes[0]! ^ 0x01;
      return { ...entry, bytes };
    });
    const flipped = parseOk({ ...base, entries });
    expect(taskFolderDigest(flipped)).not.toBe(taskFolderDigest(before));
    expect(canonicalJson(evidenceManifest(flipped))).not.toBe(
      canonicalJson(evidenceManifest(before)),
    );
  });
});

describe("E6-T02 refusals", () => {
  const disk = invalidDiskFixtures();
  const inline = invalidInlineFixtures();
  const transcript = refusalTranscript();

  it("re-executes every frozen refusal to a byte-identical transcript line", () => {
    const live = [
      ...disk.map((scenario) => ({
        name: scenario.name,
        source: "disk" as const,
        snapshot: scenario.snapshot,
      })),
      ...inline.map((scenario) => ({
        name: scenario.name,
        source: "inline" as const,
        snapshot: scenario.snapshot,
      })),
    ].map((scenario) => {
      const result = parseTaskFolder(scenario.snapshot);
      return canonicalJson({
        name: scenario.name,
        source: scenario.source,
        folderName: scenario.snapshot.folderName,
        ok: result.ok,
        refusal: result.ok ? null : result.refusal,
      });
    });
    expect(live).toEqual(transcript.map((line) => canonicalJson(line)));
    expect(transcript.every((line) => line.ok === false)).toBe(true);
    expect(transcript.length).toBe(70);
  });

  it("pins the reason for the attack list explicitly", () => {
    const reason = (name: string): string => {
      const scenario = [...disk, ...inline].find((entry) => entry.name === name)!;
      const result = parseTaskFolder(scenario.snapshot);
      expect(result.ok, name).toBe(false);
      return result.ok
        ? ""
        : `${result.refusal.reason}@${result.refusal.path}:${result.refusal.line}:${result.refusal.column}`;
    };
    expect(reason("duplicate-key")).toBe("frontmatter/duplicate-key@readme.md:5:1");
    expect(reason("anchor")).toBe("frontmatter/anchor@readme.md:4:8");
    expect(reason("alias")).toBe("frontmatter/anchor@readme.md:4:8");
    expect(reason("merge-key")).toBe("frontmatter/anchor@readme.md:2:1");
    expect(reason("unknown-key")).toBe("frontmatter/unknown-key@readme.md:10:1");
    expect(reason("missing-key")).toBe("frontmatter/missing-key@readme.md:9:1");
    expect(reason("block-list")).toBe("frontmatter/non-flat@readme.md:8:1");
    expect(reason("block-scalar")).toBe("frontmatter/non-flat@readme.md:5:1");
    expect(reason("flow-map")).toBe("frontmatter/non-flat@readme.md:4:8");
    expect(reason("id-mismatch")).toBe("frontmatter/id-mismatch@readme.md:2:1");
    expect(reason("missing-section")).toBe("sections/missing@readme.md:15:1");
    expect(reason("out-of-order")).toBe("sections/out-of-order@readme.md:12:1");
    expect(reason("duplicate-section")).toBe("sections/duplicate@readme.md:29:1");
    expect(reason("unknown-section")).toBe("sections/unknown@readme.md:29:1");
    expect(reason("absolute-path")).toBe("paths/absolute@/etc/passwd:0:0");
    expect(reason("traversal-evidence")).toBe("paths/traversal@evidence/../../secret.txt:0:0");
    expect(reason("traversal-work")).toBe("paths/traversal@work/../readme.md:0:0");
    expect(reason("symlink-evidence")).toBe("paths/symlink@evidence/escape:0:0");
    expect(reason("symlink-work")).toBe("paths/symlink@work/link:0:0");
    expect(reason("case-collision-evidence")).toBe("paths/case-collision@evidence/log.txt:0:0");
    expect(reason("case-collision-work")).toBe("paths/case-collision@work/a:0:0");
    expect(reason("percent-escape")).toBe("paths/percent-escape@evidence/%2e%2e/escape.txt:0:0");
    expect(reason("percent-work")).toBe("paths/percent-escape@work/%2e%2e/x:0:0");
    expect(reason("unicode-slug")).toBe("folder/name-invalid@.:0:0");
    expect(reason("case-collision-evidence-dir")).toBe("paths/case-collision@evidence/a/y.txt:0:0");
    expect(reason("case-collision-evidence-file-dir")).toBe(
      "paths/case-collision@evidence/a/y.txt:0:0",
    );
    expect(reason("case-collision-work-dir")).toBe("paths/case-collision@work/a/y:0:0");
    expect(reason("case-collision-work-file-dir")).toBe("paths/case-collision@work/a/y:0:0");
    expect(reason("root-evidence-file")).toBe("folder/unexpected-entry@evidence:0:0");
    expect(reason("root-work-file")).toBe("folder/unexpected-entry@work:0:0");
  });

  it("covers every frozen refusal reason at least once", () => {
    const seen = new Set(transcript.map((line) => (line.refusal as { reason: string }).reason));
    for (const reason of TASK_FOLDER_REFUSAL_REASONS) expect(seen.has(reason), reason).toBe(true);
  });

  it("a refusal renders nothing: the parse result carries no folder and no rendered bytes", () => {
    for (const scenario of [...disk, ...inline]) {
      const result = parseTaskFolder(scenario.snapshot);
      expect(result.ok).toBe(false);
      expect("folder" in result).toBe(false);
    }
  });

  it("readme-level parse agrees with folder-level parse", () => {
    const duplicate = disk.find((scenario) => scenario.name === "duplicate-key")!;
    const bytes = duplicate.snapshot.entries.find((entry) => entry.path === "readme.md")!.bytes!;
    const result = parseTaskReadme(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("frontmatter/duplicate-key");
  });
});

describe("E6-T02 disk writer leaves no partial output", () => {
  it("stages in a sibling directory and moves atomically; a failing write leaves nothing", async () => {
    const { mkdtempSync, existsSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeRenderedTaskFolder, readTaskFolderSnapshot } = await import("../io/disk.js");
    const scratch = mkdtempSync(join(tmpdir(), "e6-t02-writer-"));
    try {
      const folder = parseOk(validFixture("E9-T02-complete"));
      const target = join(scratch, "E9-T02-complete");
      writeRenderedTaskFolder(target, renderTaskFolder(folder));
      expect(taskFolderDigest(parseOk(readTaskFolderSnapshot(target)))).toBe(
        taskFolderDigest(folder),
      );
      const clashing = {
        folderName: "E9-T02-clash",
        files: [
          { path: "evidence/x", bytes: encoder.encode("a") },
          { path: "evidence/x/y", bytes: encoder.encode("b") },
          { path: "readme.md", bytes: encoder.encode("---\n") },
        ],
      };
      expect(() => writeRenderedTaskFolder(join(scratch, "clash"), clashing)).toThrow();
      expect(existsSync(join(scratch, "clash"))).toBe(false);
      expect(readdirSync(scratch)).toEqual(["E9-T02-complete"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
