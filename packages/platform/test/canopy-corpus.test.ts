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
      "6dee174f11337d7c33a715a674a2f45680b217e440089481e771232a08c52c23",
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
    expect(manifest.anchors.fork_offset > manifest.anchors.fork_parent_offset).toBe(true);
    const mainByOffset = new Map(main.map((record) => [String(record.offset), record]));
    const branchByOffset = new Map(branch.map((record) => [String(record.offset), record]));
    for (const [offset, record] of branchByOffset) {
      if (offset <= manifest.anchors.fork_parent_offset) {
        expect(record).toEqual(mainByOffset.get(offset));
      }
    }
    const firstDivergence = [...branchByOffset.keys()]
      .filter((offset) => mainByOffset.has(offset))
      .sort()
      .find(
        (offset) =>
          JSON.stringify(branchByOffset.get(offset)) !== JSON.stringify(mainByOffset.get(offset)),
      );
    expect(firstDivergence).toBe(manifest.anchors.fork_offset);
  });

  it("pins the tenant-first privacy transcript without runtime secrets", () => {
    const transcript = fs.readFileSync(path.join(evidence, "e3-t01-privacy-probe.txt"), "utf8");
    const rows = transcript
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map(
        (line) =>
          JSON.parse(line) as {
            stream: string;
            principal: string;
            status: number;
            neutral: boolean;
            beforeSha256: string;
            afterSha256: string;
            body: { ok?: boolean; streamId?: string; error?: { reason?: string } };
          },
      );
    const mapleStreams = Object.values(manifest.streams).filter((entry) =>
      entry.stream.startsWith("fs:maple/"),
    );
    expect(rows).toHaveLength(mapleStreams.length * 3);
    for (const entry of mapleStreams) {
      for (const principal of ["willow-member", "anonymous", "maple-admin"]) {
        const row = rows.find(
          (candidate) => candidate.stream === entry.stream && candidate.principal === principal,
        );
        expect(row).toBeDefined();
        const privateRepo = entry.stream.startsWith("fs:maple/secret-garden:");
        const expected =
          principal === "willow-member" || (principal === "anonymous" && privateRepo) ? 404 : 200;
        expect(row?.status).toBe(expected);
        expect(row?.neutral).toBe(true);
        expect(row?.beforeSha256).toBe(row?.afterSha256);
        if (expected === 200) {
          expect(row?.body).toMatchObject({ ok: true, streamId: entry.stream });
        } else {
          expect(row?.body.error?.reason).toBe("authz/not-found");
        }
      }
    }
    const bytes = corpusFiles(evidence)
      .map((relative) => fs.readFileSync(path.join(evidence, relative), "utf8"))
      .join("\n");
    expect(bytes).not.toMatch(/(?:127\.0\.0\.1|localhost):\d{2,5}/);
    expect(bytes).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(bytes).not.toContain("eforest-canopy-secret");
  });
});
