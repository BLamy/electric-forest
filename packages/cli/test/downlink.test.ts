import { type StreamRecord } from "@eforest/client";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { StreamFsRepo, digestBytes, mergePlanId, treeDigest, type FsTree } from "@eforest/streamfs";
import {
  BASE_NONE,
  load as loadWorkspace,
  save as saveWorkspace,
  type WorkspaceState,
} from "@eforest/workspace";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPLETE_MARKER } from "../src/clone-command.js";
import { DownlinkEngine, runJournalVerify } from "../src/sync/downlink.js";
import {
  ApplyJournalWriter,
  readApplyIntent,
  readApplyJournal,
  verifyApplyJournal,
  writeApplyBase,
} from "../src/sync/apply-journal.js";

const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly metadata: StreamRecord[];
  readonly content: StreamRecord[];
  readonly fetcher: typeof fetch;
  readonly fileStreamId: string;
}

function event(offset: number, type: string, payload: unknown): StreamRecord {
  return { offset: offsetForOrdinal(offset), type, payload, ts: offset + 1 };
}

function fileCreate(offset: number, path: string, contentStreamId: string): StreamRecord {
  return event(offset, "fs.file.create", { v: 2, path, contentStreamId });
}

function fileWrite(offset: number, path: string, base: string, bytes: Uint8Array): StreamRecord {
  return event(offset, "fs.file.write", {
    v: 2,
    path,
    base,
    contentSha256: digestBytes(bytes),
    size: bytes.byteLength,
  });
}

function filePatch(
  offset: number,
  path: string,
  base: string,
  baseBytes: Uint8Array,
  resultBytes: Uint8Array,
  addition: string,
): StreamRecord {
  return event(offset, "fs.file.patch", {
    v: 2,
    path,
    base,
    baseDigest: digestBytes(baseBytes),
    ops: [
      ["=", baseBytes.byteLength],
      ["+", addition],
    ],
    resultDigest: digestBytes(resultBytes),
  });
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "eforest-e4-t07-"));
  roots.push(root);
  await mkdir(join(root, ".ef"));
  await writeFile(join(root, ".ef", "complete"), COMPLETE_MARKER);
  const fileStreamId = "fs:acme/repo:main:file:doc";
  const one = new TextEncoder().encode("one");
  const metadata = [
    fileCreate(0, "doc.txt", fileStreamId),
    fileWrite(1, "doc.txt", BASE_NONE, one),
  ];
  const workspace: WorkspaceState = {
    v: 1,
    identity: {
      server: "http://127.0.0.1:9999",
      project: "repo",
      repo: "repo",
      branch: "main",
      metadataStreamId: "fs:acme/repo:main:meta",
    },
    headOffset: offsetForOrdinal(1),
    files: {
      "doc.txt": {
        base: offsetForOrdinal(1),
        contentSha256: digestBytes(one),
        size: one.byteLength,
      },
    },
  };
  await writeFile(join(root, "doc.txt"), one);
  saveWorkspace(root, workspace);
  const content = [
    event(0, "fs.file.content", {
      v: 2,
      contentStreamId: fileStreamId,
      contentBase64: Buffer.from(one).toString("base64"),
    }),
  ];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    const encodedMetadata = encodeURIComponent("fs:acme/repo:main:meta");
    const encodedContent = encodeURIComponent(fileStreamId);
    if (url.endsWith(`/streams/${encodedMetadata}/dump`)) {
      return new Response(JSON.stringify(metadata), { status: 200 });
    }
    if (url.endsWith(`/streams/${encodedContent}/dump`)) {
      return new Response(JSON.stringify(content), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  return { root, metadata, content, fetcher, fileStreamId };
}

function record(value: StreamRecord): StreamRecord {
  return value;
}

function overrideRepo(
  engine: DownlinkEngine,
  tree: FsTree,
  reads: Readonly<Record<string, Uint8Array>>,
): void {
  const repo = {
    treeAt: async (_until?: string) => tree,
    readFileAt: async (path: string, _until?: string) => {
      const bytes = reads[path];
      if (bytes === undefined) throw new Error(`missing test remote bytes for ${path}`);
      return new Uint8Array(bytes);
    },
  };
  (engine as unknown as { repo: typeof repo }).repo = repo;
}

function mergeRecord(offset: number, digest: string): StreamRecord {
  const targetStreamId = "fs:acme/repo:main:meta";
  const sourceStreamId = "fs:acme/repo:feature:meta";
  const revision = { streamId: targetStreamId, offset: offsetForOrdinal(1), treeDigest: digest };
  const mergeId = mergePlanId({
    base: revision,
    target: revision,
    source: { ...revision, streamId: sourceStreamId },
    changes: [],
    conflicts: [],
  });
  return record(
    event(offset, "fs.branch.merge", {
      v: 2,
      kind: "three-way",
      mergeId,
      targetStreamId,
      sourceStreamId,
      forkOffset: offsetForOrdinal(1),
      mergedThroughOffset: offsetForOrdinal(1),
      sourceHeadOffset: offsetForOrdinal(1),
      targetHeadOffset: offsetForOrdinal(1),
      baseTreeDigest: digest,
      targetTreeDigest: digest,
      sourceTreeDigest: digest,
      resultTreeDigest: digest,
      changes: [],
      conflicts: [],
    }),
  );
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("downlink apply engine", () => {
  it("applies writes, patches, directories, renames, deletes, and recreation exactly once", async () => {
    const current = await fixture();
    const engine = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
    });
    await engine.start();
    const two = new TextEncoder().encode("two");
    const twoBang = new TextEncoder().encode("two!");
    const records = [
      fileWrite(2, "doc.txt", offsetForOrdinal(1), two),
      filePatch(3, "doc.txt", offsetForOrdinal(2), two, twoBang, "!"),
      event(4, "fs.dir.create", { v: 2, path: "nested" }),
      event(5, "fs.rename", { v: 2, from: "doc.txt", to: "nested/doc.txt" }),
      filePatch(
        6,
        "nested/doc.txt",
        offsetForOrdinal(3),
        twoBang,
        new TextEncoder().encode("two!?"),
        "?",
      ),
      event(7, "fs.file.delete", { v: 2, path: "nested/doc.txt" }),
      fileCreate(8, "nested/doc.txt", current.fileStreamId),
      event(9, "fs.dir.create", { v: 2, path: "nested/deeper" }),
      fileCreate(10, "nested/deeper/empty.txt", "fs:acme/repo:main:file:empty"),
    ].map(record);
    current.metadata.push(records[0]!);
    current.content.push(
      event(1, "fs.file.content", {
        v: 2,
        contentStreamId: current.fileStreamId,
        contentBase64: Buffer.from(two).toString("base64"),
      }),
    );
    for (const item of records) expect(await engine.applyRecord(item)).toBe(true);
    expect(await engine.applyRecord(records.at(-1)!)).toBe(false);
    expect(loadWorkspace(current.root).headOffset).toBe(offsetForOrdinal(10));
    expect(new TextDecoder().decode(await readFile(join(current.root, "nested", "doc.txt")))).toBe(
      "",
    );
    await expect(readFile(join(current.root, "doc.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(readApplyJournal(join(current.root, ".ef", "apply-journal"))).toHaveLength(9);
    expect(verifyApplyJournal(join(current.root, ".ef", "apply-journal"))).toHaveLength(9);
    const io = { stdout: (text: string) => text, stderr: (text: string) => text };
    expect(runJournalVerify(["verify", current.root], io)).toBe(0);
  });

  it("recovers a committed journal entry whose checkpoint write was interrupted", async () => {
    const current = await fixture();
    const patched = new TextEncoder().encode("one!");
    const patch = record(
      filePatch(2, "doc.txt", offsetForOrdinal(1), new TextEncoder().encode("one"), patched, "!"),
    );
    const interrupted = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
      onPhase: (phase) => {
        if (phase === "after-journal-commit") throw new Error("simulated SIGKILL");
      },
    });
    await interrupted.start();
    await expect(interrupted.applyRecord(patch)).rejects.toThrow("simulated SIGKILL");
    expect(loadWorkspace(current.root).headOffset).toBe(offsetForOrdinal(1));
    expect(readApplyIntent(join(current.root, ".ef", "apply-intent"))).toBeDefined();
    const recovered = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
    });
    await recovered.start();
    expect(loadWorkspace(current.root).headOffset).toBe(offsetForOrdinal(2));
    expect(readApplyIntent(join(current.root, ".ef", "apply-intent"))).toBeUndefined();
    expect(new TextDecoder().decode(await readFile(join(current.root, "doc.txt")))).toBe("one!");
    expect(await recovered.applyRecord(patch)).toBe(false);
  });

  it("applies a three-way merge by replacing the tree from the remote branch", async () => {
    const current = await fixture();
    const repo = new StreamFsRepo("http://127.0.0.1:9999", current.fetcher, "acme/repo", "main");
    const currentTree = await repo.treeAt();
    const digest = treeDigest(currentTree);
    const targetStreamId = "fs:acme/repo:main:meta";
    const sourceStreamId = "fs:acme/repo:feature:meta";
    const revision = { streamId: targetStreamId, offset: offsetForOrdinal(1), treeDigest: digest };
    const mergeId = mergePlanId({
      base: revision,
      target: revision,
      source: { ...revision, streamId: sourceStreamId },
      changes: [],
      conflicts: [],
    });
    const merge = record(
      event(2, "fs.branch.merge", {
        v: 2,
        kind: "three-way",
        mergeId,
        targetStreamId,
        sourceStreamId,
        forkOffset: offsetForOrdinal(1),
        mergedThroughOffset: offsetForOrdinal(1),
        sourceHeadOffset: offsetForOrdinal(1),
        targetHeadOffset: offsetForOrdinal(1),
        baseTreeDigest: digest,
        targetTreeDigest: digest,
        sourceTreeDigest: digest,
        resultTreeDigest: digest,
        changes: [],
        conflicts: [],
      }),
    );
    current.metadata.push(merge);
    const engine = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
    });
    await engine.start();
    expect(await engine.applyRecord(merge)).toBe(true);
    expect(loadWorkspace(current.root).headOffset).toBe(offsetForOrdinal(2));
    expect(verifyApplyJournal(join(current.root, ".ef", "apply-journal"))).toHaveLength(1);
  });

  it("applies differing remote merge trees and rejects dirty or colliding paths", async () => {
    const remoteBytes = new TextEncoder().encode("remote\n");
    const remoteFile = {
      contentStreamId: "fs:acme/repo:main:file:remote",
      contentSha256: digestBytes(remoteBytes),
      size: remoteBytes.byteLength,
      lastContentOffset: offsetForOrdinal(2),
    };
    const remoteTree: FsTree = {
      files: { "remote.txt": remoteFile },
      dirs: { "new-dir": {} },
      tombstones: {},
    };
    const current = await fixture();
    const engine = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
    });
    await engine.start();
    overrideRepo(engine, remoteTree, { "remote.txt": remoteBytes });
    expect(await engine.applyRecord(mergeRecord(2, treeDigest(remoteTree)))).toBe(true);
    await expect(readFile(join(current.root, "doc.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(new Uint8Array(await readFile(join(current.root, "remote.txt")))).toEqual(remoteBytes);
    expect(loadWorkspace(current.root).files).toEqual({
      "remote.txt": {
        base: offsetForOrdinal(2),
        contentSha256: digestBytes(remoteBytes),
        size: remoteBytes.byteLength,
      },
    });

    const untracked = await fixture();
    await writeFile(join(untracked.root, "untracked.txt"), "local");
    const untrackedBytes = new TextEncoder().encode("remote-untracked\n");
    const untrackedTree: FsTree = {
      files: {
        "untracked.txt": {
          ...remoteFile,
          contentSha256: digestBytes(untrackedBytes),
          size: untrackedBytes.byteLength,
        },
      },
      dirs: {},
      tombstones: {},
    };
    const untrackedEngine = new DownlinkEngine({
      root: untracked.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: untracked.fetcher,
    });
    await untrackedEngine.start();
    overrideRepo(untrackedEngine, untrackedTree, { "untracked.txt": untrackedBytes });
    await expect(
      untrackedEngine.applyRecord(mergeRecord(2, treeDigest(untrackedTree))),
    ).rejects.toMatchObject({ code: "EDIRTY_BASE" });

    const directory = await fixture();
    await mkdir(join(directory.root, "remote-dir"));
    const directoryTree: FsTree = {
      files: { "remote-dir": remoteFile },
      dirs: {},
      tombstones: {},
    };
    const directoryEngine = new DownlinkEngine({
      root: directory.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: directory.fetcher,
    });
    await directoryEngine.start();
    overrideRepo(directoryEngine, directoryTree, { "remote-dir": remoteBytes });
    await expect(
      directoryEngine.applyRecord(mergeRecord(2, treeDigest(directoryTree))),
    ).rejects.toMatchObject({ code: "ECORRUPT_EVENT" });

    const fileAndDirectory = await fixture();
    const malformedTree: FsTree = {
      files: { "doc.txt": remoteFile },
      dirs: { "doc.txt": {} },
      tombstones: {},
    };
    const malformedEngine = new DownlinkEngine({
      root: fileAndDirectory.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: fileAndDirectory.fetcher,
    });
    await malformedEngine.start();
    overrideRepo(malformedEngine, malformedTree, { "doc.txt": remoteBytes });
    await expect(
      malformedEngine.applyRecord(mergeRecord(2, treeDigest(malformedTree))),
    ).rejects.toMatchObject({ code: "ECORRUPT_EVENT" });
  });

  it("covers duplicate creates for ordinary and branch content streams", async () => {
    const duplicate = await fixture();
    const duplicateEngine = new DownlinkEngine({
      root: duplicate.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: duplicate.fetcher,
    });
    await duplicateEngine.start();
    await expect(
      duplicateEngine.applyRecord(fileCreate(2, "doc.txt", "fs:acme/repo:main:file:duplicate")),
    ).rejects.toMatchObject({ code: "ECORRUPT_EVENT" });

    const branch = await fixture();
    const replacement = new TextEncoder().encode("branch replacement\n");
    const branchEngine = new DownlinkEngine({
      root: branch.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: branch.fetcher,
    });
    await branchEngine.start();
    overrideRepo(branchEngine, { files: {}, dirs: {}, tombstones: {} }, { "doc.txt": replacement });
    expect(
      await branchEngine.applyRecord(
        fileCreate(2, "doc.txt", "fs:acme/repo:feature:file:replacement"),
      ),
    ).toBe(true);
    expect(new Uint8Array(await readFile(join(branch.root, "doc.txt")))).toEqual(replacement);
  });

  it("journal verify rejects an offset gap even when the digest chain is intact", async () => {
    const current = await fixture();
    const journalPath = join(current.root, ".ef", "apply-journal");
    await writeApplyBase(join(current.root, ".ef", "apply-base"), offsetForOrdinal(1));
    const digest = digestBytes(new Uint8Array());
    const writer = new ApplyJournalWriter(journalPath);
    await writer.append({
      offset: offsetForOrdinal(2),
      kind: "test",
      paths: [],
      beforeDigest: digest,
      afterDigest: digest,
      pathDigests: [],
      provenance: { type: "test", ts: 1 },
    });
    await writer.append({
      offset: offsetForOrdinal(4),
      kind: "test",
      paths: [],
      beforeDigest: digest,
      afterDigest: digest,
      pathDigests: [],
      provenance: { type: "test", ts: 2 },
    });
    const output: string[] = [];
    expect(
      runJournalVerify(["verify", current.root], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
      }),
    ).toBe(1);
    expect(output.join("")).toContain("offset gap");
  });

  it("journal verify rejects a per-path digest chain break", async () => {
    const current = await fixture();
    const journalPath = join(current.root, ".ef", "apply-journal");
    await writeApplyBase(join(current.root, ".ef", "apply-base"), offsetForOrdinal(1));
    const empty = digestBytes(new Uint8Array());
    const one = digestBytes(new TextEncoder().encode("one"));
    const two = digestBytes(new TextEncoder().encode("two"));
    const writer = new ApplyJournalWriter(journalPath);
    await writer.append({
      offset: offsetForOrdinal(2),
      kind: "test",
      paths: ["doc.txt"],
      beforeDigest: empty,
      afterDigest: one,
      pathDigests: [{ path: "doc.txt", before: empty, after: one }],
      provenance: { type: "test", ts: 1 },
    });
    await writer.append({
      offset: offsetForOrdinal(3),
      kind: "test",
      paths: ["doc.txt"],
      beforeDigest: one,
      afterDigest: two,
      pathDigests: [{ path: "doc.txt", before: empty, after: two }],
      provenance: { type: "test", ts: 2 },
    });
    const output: string[] = [];
    expect(
      runJournalVerify(["verify", current.root], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
      }),
    ).toBe(1);
    expect(output.join("")).toContain("path digest chain breaks");
  });

  it("rolls back an intent before journal commit and refuses a dirty base", async () => {
    const current = await fixture();
    const patch = record(
      filePatch(
        2,
        "doc.txt",
        offsetForOrdinal(1),
        new TextEncoder().encode("one"),
        new TextEncoder().encode("one!"),
        "!",
      ),
    );
    const interrupted = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
      onPhase: (phase) => {
        if (phase === "after-intent") throw new Error("simulated SIGKILL");
      },
    });
    await interrupted.start();
    await expect(interrupted.applyRecord(patch)).rejects.toThrow("simulated SIGKILL");
    const recovered = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
    });
    await recovered.start();
    expect(await recovered.applyRecord(patch)).toBe(true);
    await writeFile(join(current.root, "doc.txt"), "local edit");
    const dirty = record(
      filePatch(
        3,
        "doc.txt",
        offsetForOrdinal(2),
        new TextEncoder().encode("one!"),
        new TextEncoder().encode("one!?"),
        "?",
      ),
    );
    await expect(recovered.applyRecord(dirty)).rejects.toMatchObject({
      code: "EDIRTY_BASE",
    });
    expect(new TextDecoder().decode(await readFile(join(current.root, "doc.txt")))).toBe(
      "local edit",
    );
    expect(loadWorkspace(current.root).headOffset).toBe(offsetForOrdinal(2));
  });

  it("detects journal byte flips, checkpoint-ahead state, and corrupt stream events", async () => {
    const current = await fixture();
    const patch = record(
      filePatch(
        2,
        "doc.txt",
        offsetForOrdinal(1),
        new TextEncoder().encode("one"),
        new TextEncoder().encode("one!"),
        "!",
      ),
    );
    const engine = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
    });
    await engine.start();
    await engine.applyRecord(patch);
    const journalPath = join(current.root, ".ef", "apply-journal");
    const journalBytes = await readFile(journalPath, "utf8");
    const flipped = journalBytes.replace(/("checksum":")[0-9a-f]/, "$10");
    expect(flipped).not.toBe(journalBytes);
    await writeFile(journalPath, flipped);
    const corrupt = new DownlinkEngine({
      root: current.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: current.fetcher,
    });
    await expect(corrupt.start()).rejects.toMatchObject({
      code: "EJOURNAL_CORRUPT",
    });

    const torn = await fixture();
    const tornEngine = new DownlinkEngine({
      root: torn.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: torn.fetcher,
    });
    await tornEngine.start();
    await tornEngine.applyRecord(patch);
    await tornEngine.close();
    const tornJournalPath = join(torn.root, ".ef", "apply-journal");
    const tornJournal = await readFile(tornJournalPath);
    await writeFile(tornJournalPath, tornJournal.subarray(0, tornJournal.length - 5));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recovery = new DownlinkEngine({
        root: torn.root,
        streamServerUrl: "http://127.0.0.1:9999",
        accessToken: "test-token",
        fetcher: torn.fetcher,
      });
      await expect(recovery.start()).rejects.toMatchObject({ code: "EJOURNAL_CORRUPT" });
      expect(loadWorkspace(torn.root).headOffset).toBe(offsetForOrdinal(2));
      expect(new TextDecoder().decode(await readFile(join(torn.root, "doc.txt")))).toBe("one!");
    }

    const ahead = await fixture();
    const baseline = new DownlinkEngine({
      root: ahead.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: ahead.fetcher,
    });
    await baseline.start();
    await baseline.applyRecord(patch);
    await baseline.close();
    saveWorkspace(ahead.root, {
      ...loadWorkspace(ahead.root),
      headOffset: offsetForOrdinal(3),
    });
    const mismatch = new DownlinkEngine({
      root: ahead.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: ahead.fetcher,
    });
    await expect(mismatch.start()).rejects.toMatchObject({
      code: "ECHECKPOINT_MISMATCH",
    });

    const corruptStream = await fixture();
    const invalidEngine = new DownlinkEngine({
      root: corruptStream.root,
      streamServerUrl: "http://127.0.0.1:9999",
      accessToken: "test-token",
      fetcher: corruptStream.fetcher,
    });
    await invalidEngine.start();
    const invalid = record(event(2, "fs.file.patch", { invalid: true }));
    await expect(invalidEngine.applyRecord(invalid)).rejects.toMatchObject({
      code: "ECORRUPT_EVENT",
    });
    expect(loadWorkspace(corruptStream.root).headOffset).toBe(offsetForOrdinal(1));
  });

  it("re-establishes the invariant after ten targeted crash phases", async () => {
    const phases = [
      "before-intent",
      "after-intent",
      "after-rename",
      "after-journal-commit",
      "before-checkpoint",
    ] as const;
    for (let index = 0; index < 10; index += 1) {
      const current = await fixture();
      const patch = record(
        filePatch(
          2,
          "doc.txt",
          offsetForOrdinal(1),
          new TextEncoder().encode("one"),
          new TextEncoder().encode("one!"),
          "!",
        ),
      );
      const phase = phases[index % phases.length]!;
      const interrupted = new DownlinkEngine({
        root: current.root,
        streamServerUrl: "http://127.0.0.1:9999",
        accessToken: "test-token",
        fetcher: current.fetcher,
        onPhase: (observed) => {
          if (observed === phase) throw new Error(`crash:${phase}`);
        },
      });
      await interrupted.start();
      await expect(interrupted.applyRecord(patch)).rejects.toThrow(`crash:${phase}`);
      const recovered = new DownlinkEngine({
        root: current.root,
        streamServerUrl: "http://127.0.0.1:9999",
        accessToken: "test-token",
        fetcher: current.fetcher,
      });
      await recovered.start();
      if (phase === "after-journal-commit" || phase === "before-checkpoint") {
        expect(loadWorkspace(current.root).headOffset).toBe(offsetForOrdinal(2));
      } else {
        expect(loadWorkspace(current.root).headOffset).toBe(offsetForOrdinal(1));
        await recovered.applyRecord(patch);
      }
      expect(verifyApplyJournal(join(current.root, ".ef", "apply-journal"))).toHaveLength(1);
      await interrupted.close();
      await recovered.close();
    }
  });
});
