import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EF_WORKSPACE_VERSION,
  WorkspaceFormatError,
  load,
  save,
  workspaceFilePath,
  type WorkspaceState,
} from "./index.js";

function state(branch = "main"): WorkspaceState {
  return {
    v: EF_WORKSPACE_VERSION,
    identity: {
      server: "https://example.test",
      project: "project",
      repo: "repo",
      branch,
      metadataStreamId: `metadata-${branch}`,
    },
    headOffset: "0000000000000000_0000000000000004",
    files: {
      "src/index.ts": {
        base: "0000000000000000_0000000000000003",
        contentSha256: "0".repeat(64),
        size: 12,
      },
    },
  };
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "eforest-workspace-"));
}

const evidenceFixtures = fileURLToPath(
  new URL(
    "../../../.eforest/tasks/epic-4-the-roots/E4-T01-worktree-digest-and-ef-format/evidence/ef-fixtures/",
    import.meta.url,
  ),
);

function writeRaw(dir: string, source: string): void {
  const path = workspaceFilePath(dir);
  const parent = join(dir, ".ef");
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, source, "utf8");
}

describe(".ef workspace format", () => {
  it("round-trips canonical state bytes", () => {
    const dir = fixtureDir();
    save(dir, state());
    const bytes = readFileSync(workspaceFilePath(dir), "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes).not.toMatch(/[\r\t]/);
    expect(load(dir)).toEqual(state());
  });

  it.each([
    [
      "unknown-version",
      '{"files":{},"headOffset":"-1","identity":{"branch":"main","metadataStreamId":"m","project":"p","repo":"r","server":"s"},"v":2}\n',
      "unknown-version",
    ],
    ["malformed", '{"files":', "noncanonical"],
    [
      "truncated",
      '{"files":{},"headOffset":"-1","identity":{"branch":"main","metadataStreamId":"m","project":"p","repo":"r","server":"s"},"v":1',
      "noncanonical",
    ],
    [
      "extra-field",
      '{"extra":true,"files":{},"headOffset":"-1","identity":{"branch":"main","metadataStreamId":"m","project":"p","repo":"r","server":"s"},"v":1}\n',
      "invalid-schema",
    ],
    [
      "wrong-type",
      '{"files":[],"headOffset":"-1","identity":{"branch":"main","metadataStreamId":"m","project":"p","repo":"r","server":"s"},"v":1}\n',
      "invalid-schema",
    ],
    [
      "duplicate-ledger-key",
      '{"files":{"a":{"base":"BASE_NONE","contentSha256":"0000000000000000000000000000000000000000000000000000000000000000","size":0},"a":{"base":"BASE_NONE","contentSha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1}},"headOffset":"-1","identity":{"branch":"main","metadataStreamId":"m","project":"p","repo":"r","server":"s"},"v":1}\n',
      "duplicate-key",
    ],
  ])("refuses %s with a typed error", (_name, source, code) => {
    const dir = fixtureDir();
    writeRaw(dir, source);
    try {
      load(dir);
      throw new Error("load unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceFormatError);
      expect((error as WorkspaceFormatError).code).toBe(code);
    }
  });

  it("rejects a corrupt UTF-8 or BOM-prefixed file", () => {
    const dir = fixtureDir();
    const path = workspaceFilePath(dir);
    mkdirSync(join(dir, ".ef"), { recursive: true });
    writeFileSync(path, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]));
    expect(() => load(dir)).toThrowError(expect.objectContaining({ code: "noncanonical" }));
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x0a]));
    expect(() => load(dir)).toThrowError(expect.objectContaining({ code: "invalid-utf8" }));
  });

  it("leaves the old complete state when save fails after fsync", () => {
    const dir = fixtureDir();
    const oldState = state("main");
    const newState = state("feature");
    save(dir, oldState);
    process.env.EFOREST_WORKSPACE_FAILPOINT = "after-fsync";
    try {
      expect(() => save(dir, newState)).toThrowError(
        expect.objectContaining({ code: "atomicity" }),
      );
    } finally {
      delete process.env.EFOREST_WORKSPACE_FAILPOINT;
    }
    expect(load(dir)).toEqual(oldState);
  });

  it("leaves the old complete state when a child dies after fsync", () => {
    const dir = fixtureDir();
    const oldState = state("main");
    const newState = state("feature");
    save(dir, oldState);
    const modulePath = fileURLToPath(
      new URL("./index.js", import.meta.url).href.replace("/src/", "/dist/src/"),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { save } from ${JSON.stringify(pathToFileURL(modulePath).href)}; save(process.argv[1], JSON.parse(process.argv[2]));`,
        dir,
        JSON.stringify(newState),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, EFOREST_WORKSPACE_FAILPOINT: "after-fsync-kill" },
      },
    );
    expect(child.signal).toBe("SIGKILL");
    expect(load(dir)).toEqual(oldState);
  });

  it("rejects invalid ledger paths and bases", () => {
    const dir = fixtureDir();
    const invalid = state();
    const pathState = { ...invalid, files: { "../escape": invalid.files["src/index.ts"]! } };
    expect(() => save(dir, pathState)).toThrowError(
      expect.objectContaining({ code: "invalid-schema" }),
    );
    const baseState = {
      ...invalid,
      files: { "src/index.ts": { ...invalid.files["src/index.ts"]!, base: "" } },
    };
    expect(() => save(dir, baseState)).toThrowError(
      expect.objectContaining({ code: "invalid-schema" }),
    );

    const malformedBase = JSON.stringify({
      ...state(),
      files: {
        "src/index.ts": {
          ...state().files["src/index.ts"]!,
          base: "garbage-revision",
        },
      },
    });
    writeRaw(dir, `${malformedBase}\n`);
    expect(() => load(dir)).toThrowError(expect.objectContaining({ code: "invalid-schema" }));
  });

  it("exercises the committed refusal corpus", () => {
    const cases = [
      ["v2.json", "unknown-version"],
      ["truncated.json", "invalid-json"],
      ["extra-field.json", "invalid-schema"],
      ["wrong-type.json", "invalid-schema"],
      ["duplicate-ledger-key.json", "duplicate-key"],
    ] as const;
    for (const [name, code] of cases) {
      const dir = fixtureDir();
      writeRaw(dir, readFileSync(join(evidenceFixtures, name), "utf8"));
      expect(() => load(dir)).toThrowError(expect.objectContaining({ code }));
    }
    expect(readFileSync(join(evidenceFixtures, "valid.json"), "utf8")).toContain('"v":1');
  });
});
