import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evidence = fileURLToPath(
  new URL(
    "../../../.eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests/evidence/",
    import.meta.url,
  ),
);

type Manifest = {
  readonly schema: string;
  readonly streams: Readonly<
    Record<
      string,
      {
        readonly stream: string;
        readonly dump: string;
        readonly dump_sha256: string;
        readonly head_offset: string;
        readonly state_digest: string;
      }
    >
  >;
  readonly anchors: {
    readonly patch_offsets: readonly string[];
    readonly fork_offset: string;
    readonly fork_parent_offset: string;
  };
};

function corpusFiles(directory: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result.push(path.relative(directory, absolute));
    }
  };
  visit(directory);
  return result.sort();
}

function corpusDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const relative of corpusFiles(directory)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(directory, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function records(manifest: Manifest, key: string): readonly Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(evidence, manifest.streams[key]!.dump), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the frozen E3 canopy corpus", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(evidence, "corpus-manifest.json"), "utf8"),
  ) as Manifest;

  it("pins the complete byte inventory", () => {
    expect(manifest.schema).toBe("eforest.canopy-corpus.v1");
    expect(Object.keys(manifest.streams)).toHaveLength(22);
    expect(corpusDigest(evidence)).toBe(
      "d7534746d264395ca8acfbf7e2101af1fe34a372f4da0742eea17227de283612",
    );
    expect(
      fs
        .readdirSync(path.join(evidence, "dumps"))
        .filter((file) => file.endsWith(".jsonl"))
        .sort(),
    ).toEqual(
      Object.keys(manifest.streams)
        .map((key) => `${key}.jsonl`)
        .sort(),
    );
  });

  it("pins the native fork and three real patch anchors", () => {
    const main = records(manifest, "fs_maple_reading-room_main_meta");
    const branch = records(manifest, "fs_maple_reading-room_feature-typography_meta");
    expect(manifest.anchors.patch_offsets).toHaveLength(3);
    for (const offset of manifest.anchors.patch_offsets) {
      expect(main.find((record) => record.offset === offset)).toMatchObject({
        type: "fs.file.patch",
        payload: { path: "docs/chapter-one.md" },
      });
    }
    expect(branch.find((record) => record.offset === manifest.anchors.fork_offset)).toMatchObject({
      type: "fs.branch.fork",
      payload: {
        parentStreamId: "fs:maple/reading-room:main:meta",
        forkOffset: manifest.anchors.fork_parent_offset,
      },
    });
  });

  it("pins the tenant-first privacy transcript without runtime secrets", () => {
    const transcript = fs.readFileSync(path.join(evidence, "e3-t01-privacy-probe.txt"), "utf8");
    expect(transcript).toMatch(/willow-member.*reading-room status=404/);
    expect(transcript).toMatch(/anonymous.*reading-room status=200/);
    expect(transcript).toMatch(/anonymous.*secret-garden status=404/);
    expect(transcript).toMatch(/maple-admin.*secret-garden status=200/);
    const bytes = corpusFiles(evidence)
      .map((relative) => fs.readFileSync(path.join(evidence, relative), "utf8"))
      .join("\n");
    expect(bytes).not.toMatch(/(?:127\.0\.0\.1|localhost):\d{2,5}/);
    expect(bytes).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(bytes).not.toContain("eforest-canopy-secret");
  });
});
