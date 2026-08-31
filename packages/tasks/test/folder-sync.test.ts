import { canonicalJson, sha256Hex, type Event, type Offset } from "@eforest/protocol";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  attachmentInitialStateForStream,
  attachmentReducer,
  contentBytes,
  contentInitialStateForStream,
  contentReducer,
  isEvidenceContentStreamId,
  isEvidenceStreamId,
  reduceContentEvents,
  validateEvidenceAction,
} from "@eforest/evidence";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  E6_T05_ORIGIN_FILTER_GUARD,
  TASK_SYNC_ROOT,
  TaskFolderProjectionError,
  TaskFolderSyncEngine,
  TaskSyncJournal,
  TaskSyncJournalError,
  auditTaskSyncJournal,
  evidenceKindForPath,
  parseTaskSyncJournal,
  parseVerificationLogEntries,
  planProjectionWrites,
  planTaskFolderIngest,
  projectTaskFolder,
  replayTaskLog,
  serializeTaskSyncJournal,
  taskInitialStateForStream,
  taskReducer,
  validateTaskEvent,
  type BranchChangeRecord,
  type BranchWriteOp,
  type BranchWriteReceipt,
  type TaskFolderIngestContext,
  type TaskSyncBranchPort,
  type TaskSyncStreamsPort,
} from "../src/index.js";

const ORG = "maple";
const REPO = "loom";
const TASK = "E9-T01";
const FOLDER = "epic-9/E9-T01-sync-probe";
const STREAM = `issue:${ORG}/${REPO}/${TASK}`;
const EVIDENCE_STREAM = `evidence:${ORG}/${REPO}/issue/${TASK}`;
const ORIGIN = { stream: `fs:${ORG}/${REPO}:client-a:meta`, head: offsetForOrdinal(7) };

const README = (status: string, context = "Created by client A.", log = ""): string =>
  [
    "---",
    `id: ${TASK}`,
    "epic: 9",
    "title: Sync probe task",
    "priority: 901",
    `status: ${status}`,
    "depends_on: []",
    "estimate: S",
    "capstone: false",
    "---",
    "",
    "## Goal",
    "Probe the sync engine.",
    "",
    "## Context",
    context,
    "",
    "## Deliverables",
    "- One folder.",
    "",
    "## Acceptance criteria",
    "- [ ] Sync works.",
    "",
    "## Adversarial verification",
    "1. Attack it.",
    "",
    "## Verification log",
    log,
  ].join("\n");

const CANONICAL = README("pending") + "\n";

function snapshotOf(readme: string, evidence: Record<string, Uint8Array> = {}) {
  return {
    folderName: FOLDER.split("/")[1]!,
    entries: [
      { path: "readme.md", kind: "file" as const, bytes: new TextEncoder().encode(readme) },
      ...Object.entries(evidence).map(([path, bytes]) => ({
        path: `evidence/${path}`,
        kind: "file" as const,
        bytes,
      })),
    ],
  };
}

function baseContext(overrides: Partial<TaskFolderIngestContext> = {}): TaskFolderIngestContext {
  return {
    org: ORG,
    repo: REPO,
    taskId: TASK,
    folderPath: FOLDER,
    snapshot: snapshotOf(CANONICAL),
    liveEvidence: [],
    usedAttachmentIds: [],
    actor: "agent-ash",
    ts: 1000,
    base: OFFSET_BEFORE_FIRST,
    origin: ORIGIN,
    changedPath: "readme.md",
    ...overrides,
  };
}

describe("verification-log entry parser", () => {
  it("extracts role, kind, and structured fields", () => {
    const entries = parseVerificationLogEntries(
      [
        "",
        "### 2026-08-30 — builder — started",
        "- Run: agent-run:maple/run-1",
        "",
        "### 2026-08-30 — critic — VERDICT: refuted",
        "- Run: agent-run:maple/run-2",
        "- Finding: broken-digest | evidence.jsonl | the digest moved",
        "free prose",
      ].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: "builder", kind: "started" });
    expect(entries[0]!.fields.get("Run")).toEqual(["agent-run:maple/run-1"]);
    expect(entries[1]).toMatchObject({ role: "critic", kind: "refuted" });
    expect(entries[1]!.fields.get("Finding")).toHaveLength(1);
  });

  it("treats fenced ### lines as documentation, never as entries (E6-T02 fence contract)", () => {
    const fenced = (open: string, close = open) =>
      parseVerificationLogEntries(
        [
          "",
          "The entry format, quoted from the docs:",
          "",
          open,
          "### 2026-08-31 — builder — started",
          "- Run: agent-run:maple/run-doc",
          close,
          "",
          "Nothing above is a real claim.",
        ].join("\n"),
      );
    for (const [open, close] of [
      ["```", "```"],
      ["~~~", "~~~"],
      ["````", "````"],
      ["```markdown", "```"],
      ["   ```", "   ```"],
      ["`````", "```````"],
    ] as const) {
      expect(fenced(open, close), `${open} … ${close}`).toEqual([]);
    }
  });

  it("an unterminated fence fails closed: nothing after it is an entry", () => {
    expect(
      parseVerificationLogEntries(
        ["", "```", "### 2026-08-31 — critic — VERDICT: verified", "- Run: agent-run:maple/r"].join(
          "\n",
        ),
      ),
    ).toEqual([]);
  });

  it("a fenced example inside a real entry cannot supply that entry's fields", () => {
    const entries = parseVerificationLogEntries(
      [
        "### 2026-08-31 — critic — in-progress notes",
        "Still reviewing. A finished verdict looks like this:",
        "```",
        "- Run: agent-run:maple/spoofed",
        "- Branch: fs:maple/loom:client-a:meta@0000000000000000_0000000000000004",
        "- Evidence: run.bin",
        "- Summary: EXAMPLE ONLY.",
        "```",
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fields.size).toBe(0);
  });

  it("keeps prose entries text-only", () => {
    const entries = parseVerificationLogEntries("### just some notes\nnothing structured\n");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.role).toBeUndefined();
    expect(entries[0]!.kind).toBeUndefined();
  });
});

describe("this repository's own doctrine files (regression fixture)", () => {
  const repoRoot = new URL("../../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, repoRoot), "utf8");

  // AGENTS.md and .eforest/tasks/README.md ship fenced example log entries. If the log
  // parser ever loses fence awareness again, these files become lifecycle claims.
  it("finds no lifecycle entry in the fenced examples of AGENTS.md and the tasks README", () => {
    for (const path of ["AGENTS.md", ".eforest/tasks/README.md"]) {
      const text = read(path);
      const entries = parseVerificationLogEntries(text);
      const lifecycle = entries.filter(
        (entry) => entry.role !== undefined && entry.kind !== undefined,
      );
      expect(
        lifecycle.map((entry) => entry.text.split("\n")[0]),
        path,
      ).toEqual([]);
    }
    // The fixture is only meaningful while those files really do carry fenced examples.
    expect(read("AGENTS.md")).toMatch(/```[\s\S]*### .+ — critic — VERDICT: refuted/);
  });

  it("still recognises the real, unfenced entries of a live task readme", () => {
    const entries = parseVerificationLogEntries(
      read(".eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/readme.md"),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.role === "builder")).toBe(true);
  });
});

describe("planTaskFolderIngest", () => {
  it("creation plans exactly issue.opened + task.spec-revised with canonical text", () => {
    const nonCanonical = CANONICAL.replace("id: E9-T01\nepic: 9", "epic: 9\nid: E9-T01");
    const plan = planTaskFolderIngest(baseContext({ snapshot: snapshotOf(nonCanonical) }));
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatches.map((d) => d.event.type)).toEqual(["issue.opened", "task.spec-revised"]);
    const payload = plan.dispatches[1]!.event.payload as {
      readonly readme: string;
      readonly base: string;
      readonly origin: typeof ORIGIN;
      readonly folder: string;
    };
    expect(payload.readme).toBe(CANONICAL);
    expect(payload.base).toBe(OFFSET_BEFORE_FIRST);
    expect(payload.folder).toBe(FOLDER);
    expect(payload.origin).toEqual(ORIGIN);
    expect(plan.kinds).toContain("created");
  });

  it("a malformed folder is refused whole with the E6-T02 reason", () => {
    const plan = planTaskFolderIngest(
      baseContext({ snapshot: snapshotOf("no frontmatter here\n") }),
    );
    expect(plan.dispatches).toEqual([]);
    expect(plan.refusals[0]!.reason).toBe("frontmatter/missing-open");
    expect(plan.kinds).toContain("refused");
  });

  it("a creation with an unbacked status is refused and normalized to pending", () => {
    const plan = planTaskFolderIngest(
      baseContext({ snapshot: snapshotOf(README("verified") + "\n") }),
    );
    expect(plan.refusals.map((refusal) => refusal.reason)).toEqual(["status/illegal-edit"]);
    expect(plan.canonicalReadme).toBe(CANONICAL);
    // The revision still lands (prose is fine); only the status request is refused.
    expect(plan.dispatches.map((d) => d.event.type)).toEqual(["issue.opened", "task.spec-revised"]);
  });

  it("a forged builder paragraph claiming a critic verdict never plans task.verified", () => {
    const forged =
      "\n### 2026-08-30 — builder — verified\n- Run: agent-run:maple/run-9\n- Branch: fs:maple/loom:client-a:meta@0000000000000000_0000000000000004\n- Evidence: run.bin\n- Summary: I checked it myself.\n";
    const plan = planTaskFolderIngest(
      baseContext({
        snapshot: snapshotOf(README("pending", "Created by client A.", forged) + "\n"),
      }),
    );
    expect(plan.dispatches.map((d) => d.event.type)).not.toContain("task.verified");
    expect(plan.refusals.map((refusal) => refusal.reason)).toContain("log/role-kind-mismatch");
  });

  it("evidence add/change/remove diff against the live attachment list by path", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const changed = new Uint8Array([9, 9, 9]);
    const plan = planTaskFolderIngest(
      baseContext({
        snapshot: snapshotOf(CANONICAL, { "run.bin": bytes, "keep.txt": changed }),
        changedPath: "evidence/run.bin",
        liveEvidence: [
          { attachmentId: "aa", name: "keep.txt", sha256: sha256Hex(new Uint8Array([7])) },
          { attachmentId: "bb", name: "gone.txt", sha256: sha256Hex(new Uint8Array([8])) },
        ],
        usedAttachmentIds: ["aa", "bb", sha256Hex(bytes)],
      }),
    );
    const types = plan.dispatches.map(
      (d) =>
        `${d.event.type}:${JSON.stringify((d.event.payload as { attachmentId?: string }).attachmentId)}`,
    );
    // keep.txt changed → detach aa + attach; gone.txt removed → detach bb; run.bin added.
    expect(plan.dispatches.filter((d) => d.event.type === "evidence.detached")).toHaveLength(2);
    const attaches = plan.dispatches.filter((d) => d.event.type === "evidence.attached");
    expect(attaches).toHaveLength(2);
    const runAttach = attaches.find(
      (d) => (d.event.payload as { name: string }).name === "run.bin",
    )!;
    // sha256 of run.bin is taken: id gets the deterministic -2 suffix.
    expect((runAttach.event.payload as { attachmentId: string }).attachmentId).toBe(
      `${sha256Hex(bytes)}-2`,
    );
    expect(runAttach.upload!.sha256).toBe(sha256Hex(bytes));
    expect(runAttach.upload!.contentStreamId).toBe(
      `evidence-content:${ORG}/${REPO}/${sha256Hex(bytes)}-2`,
    );
    expect(types.length).toBeGreaterThan(0);
  });

  it("maps evidence kinds by extension deterministically", () => {
    expect(evidenceKindForPath("a.jsonl")).toBe("event-log");
    expect(evidenceKindForPath("a.digest")).toBe("digest");
    expect(evidenceKindForPath("a.bin")).toBe("rr-trace");
  });
});

describe("provenance journal", () => {
  it("round-trips canonically and refuses duplicates and tampering", () => {
    const journal = new TaskSyncJournal();
    journal.append({
      stream: STREAM,
      offset: offsetForOrdinal(0),
      disposition: "applied",
      subject: "issue.opened",
      kinds: [],
      effects: [],
      reason: "",
    });
    expect(() =>
      journal.append({
        stream: STREAM,
        offset: offsetForOrdinal(0),
        disposition: "applied",
        subject: "issue.opened",
        kinds: [],
        effects: [],
        reason: "",
      }),
    ).toThrow(TaskSyncJournalError);
    const text = serializeTaskSyncJournal(journal.state);
    expect(parseTaskSyncJournal(text)).toEqual(journal.state);
    const tampered = text.replace("issue.opened", "issue.reopened");
    expect(() => parseTaskSyncJournal(tampered)).toThrow(/checksum/);
  });

  it("audit enforces the frozen multiplicity per offset", () => {
    const journal = new TaskSyncJournal();
    const branch = ORIGIN.stream;
    const o = offsetForOrdinal;
    journal.append({
      stream: branch,
      offset: o(1),
      disposition: "ingested",
      subject: "x",
      kinds: ["revised"],
      effects: [],
      reason: "",
    });
    journal.append({
      stream: branch,
      offset: o(2),
      disposition: "projected",
      subject: "y",
      kinds: [],
      effects: [],
      reason: "",
    });
    journal.append({
      stream: branch,
      offset: o(2),
      disposition: "suppressed",
      subject: "y",
      kinds: [],
      effects: [],
      reason: "",
    });
    journal.append({
      stream: branch,
      offset: o(3),
      disposition: "projected",
      subject: "z",
      kinds: [],
      effects: [],
      reason: "",
    });
    const good = auditTaskSyncJournal(journal.state, {
      branch: { stream: branch, offsets: [o(1), o(2)] },
      streams: [],
    });
    expect(good.ok).toBe(false); // o(3) journaled but absent from the stream list
    expect(good.violations.some((violation) => violation.includes(o(3)))).toBe(true);
    const bad = auditTaskSyncJournal(journal.state, {
      branch: { stream: branch, offsets: [o(1), o(2), o(3), o(4)] },
      streams: [],
    });
    expect(bad.ok).toBe(false);
    expect(bad.violations).toContainEqual(expect.stringContaining(`${o(3)}: projected`));
    expect(bad.violations).toContainEqual(expect.stringContaining(`${o(4)}: unjournaled`));
  });
});

describe("projection", () => {
  const specState = () => {
    let state = taskInitialStateForStream(STREAM);
    state = taskReducer(state, {
      type: "issue.opened",
      payload: { v: 1, title: "Sync probe task", body: CANONICAL },
      ts: 1,
      offset: offsetForOrdinal(0),
    } as Event);
    state = taskReducer(state, {
      type: "task.spec-revised",
      payload: {
        v: 1,
        base: OFFSET_BEFORE_FIRST,
        folder: FOLDER,
        origin: ORIGIN,
        readme: CANONICAL,
        sha256: sha256Hex(new TextEncoder().encode(CANONICAL)),
      },
      ts: 2,
      offset: offsetForOrdinal(1),
    } as Event);
    return state;
  };

  it("renders the readme with the replayed status as authority", () => {
    const projection = projectTaskFolder({ state: specState(), evidence: [] });
    expect(projection.folderPath).toBe(FOLDER);
    expect(new TextDecoder().decode(projection.files[0]!.bytes)).toBe(CANONICAL);
  });

  it("refuses evidence whose bytes do not hash to the attachment digest", () => {
    expect(() =>
      projectTaskFolder({
        state: specState(),
        evidence: [
          {
            attachmentId: "aa",
            name: "run.bin",
            sha256: sha256Hex(new Uint8Array([1])),
            bytes: new Uint8Array([2]),
          },
        ],
      }),
    ).toThrow(TaskFolderProjectionError);
  });

  it("re-gates rendered paths (a hostile attachment name cannot escape)", () => {
    const bytes = new Uint8Array([1]);
    expect(() =>
      projectTaskFolder({
        state: specState(),
        evidence: [{ attachmentId: "aa", name: "../../evil.txt", sha256: sha256Hex(bytes), bytes }],
      }),
    ).toThrow(/projected path refused/);
  });

  it("plans only the differing writes and deletes only managed paths", () => {
    const projection = projectTaskFolder({ state: specState(), evidence: [] });
    const readmeSha = sha256Hex(projection.files[0]!.bytes);
    const plan = planProjectionWrites(
      projection,
      new Map([
        ["readme.md", readmeSha],
        ["evidence/stale.bin", "00".repeat(32)],
        ["work/scratch.txt", "11".repeat(32)],
      ]),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.deletes).toEqual(["evidence/stale.bin"]);
  });
});

/** In-memory door + branch implementing the engine ports with real validation. */
class MemoryWorld {
  readonly records = new Map<string, (Event & { offset: Offset })[]>();
  readonly branches = new Map<
    string,
    { log: { offset: Offset; op: BranchWriteOp | { kind: "dir"; path: string } }[]; next: number }
  >();

  branchOf(stream: string) {
    const existing = this.branches.get(stream);
    if (existing !== undefined) return existing;
    const created = { log: [], next: 0 };
    this.branches.set(stream, created);
    return created;
  }

  read(streamId: string): readonly (Event & { offset: Offset })[] {
    return [...(this.records.get(streamId) ?? [])];
  }

  async dispatch(
    streamId: string,
    action: Event,
  ): Promise<{ ok: true; offset: Offset } | { ok: false; reason: string }> {
    const records = this.records.get(streamId) ?? [];
    const nextOffset = offsetForOrdinal(records.length);
    try {
      if (isEvidenceStreamId(streamId) || isEvidenceContentStreamId(streamId)) {
        await validateEvidenceAction(action, {
          streamId,
          state: isEvidenceStreamId(streamId)
            ? records.reduce(attachmentReducer, attachmentInitialStateForStream(streamId))
            : records.reduce(contentReducer, contentInitialStateForStream(streamId)),
          headOffset: records.at(-1)?.offset ?? (OFFSET_BEFORE_FIRST as Offset),
          nextOffset,
          records,
          resolveStream: async (target) => {
            const targetRecords = this.records.get(target);
            return targetRecords === undefined ? undefined : { records: targetRecords };
          },
        });
      } else {
        const state = records.reduce(taskReducer, taskInitialStateForStream(streamId));
        await validateTaskEvent(action, {
          streamId,
          state,
          headOffset: records.at(-1)?.offset ?? (OFFSET_BEFORE_FIRST as Offset),
          nextOffset,
          records,
          resolveStream: async (target) => {
            const targetRecords = this.records.get(target);
            return targetRecords === undefined ? undefined : { records: targetRecords };
          },
        });
      }
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    records.push({ ...action, offset: nextOffset });
    this.records.set(streamId, records);
    // Mirror the gateway: an accepted issue.opened registers the stream in the catalog.
    if (action.type === "issue.opened" && streamId.startsWith("issue:")) {
      const catalogId = `repo-issues:${ORG}/${REPO}`;
      const catalog = this.records.get(catalogId) ?? [];
      catalog.push({
        type: "repo.issue-observed",
        payload: { v: 1, issueStreamId: streamId, sourceOffset: nextOffset },
        ts: action.ts,
        offset: offsetForOrdinal(catalog.length),
      });
      this.records.set(catalogId, catalog);
    }
    return { ok: true, offset: nextOffset };
  }

  filesAtBranch(stream: string, offset?: Offset): Map<string, Uint8Array> {
    const branch = this.branchOf(stream);
    const files = new Map<string, Uint8Array>();
    for (const entry of branch.log) {
      if (offset !== undefined && entry.offset > offset) break;
      if (entry.op.kind === "write") files.set(entry.op.path, entry.op.bytes);
      else if (entry.op.kind === "delete") files.delete(entry.op.path);
    }
    return files;
  }

  /** Apply ops as a writer would; returns the change records a watcher tail emits. */
  writeBranch(stream: string, ops: readonly BranchWriteOp[]): BranchWriteReceipt[] {
    const branch = this.branchOf(stream);
    const receipts: BranchWriteReceipt[] = [];
    const dirs = new Set<string>();
    for (const entry of branch.log) if (entry.op.kind === "dir") dirs.add(entry.op.path);
    for (const op of ops) {
      if (op.kind === "write") {
        const segments = op.path.split("/");
        for (let depth = 1; depth < segments.length; depth += 1) {
          const dir = segments.slice(0, depth).join("/");
          if (dirs.has(dir)) continue;
          dirs.add(dir);
          const offset = offsetForOrdinal(branch.next++);
          branch.log.push({ offset, op: { kind: "dir", path: dir } });
          receipts.push({ offset, path: dir, type: "fs.dir.create" });
        }
      }
      const offset = offsetForOrdinal(branch.next++);
      branch.log.push({ offset, op });
      receipts.push({
        offset,
        path: op.path,
        type: op.kind === "write" ? "fs.file.write" : "fs.file.delete",
      });
    }
    return receipts;
  }

  changeRecords(receipts: readonly BranchWriteReceipt[]): BranchChangeRecord[] {
    return receipts.map((receipt) => ({
      event:
        receipt.type === "fs.dir.create"
          ? ("addDir" as const)
          : receipt.type === "fs.file.delete"
            ? ("unlink" as const)
            : ("change" as const),
      path: receipt.path,
      offset: receipt.offset,
    }));
  }
}

function makeEngine(
  world: MemoryWorld,
  branchStream: string,
  actor: string,
  originFilter?: boolean,
) {
  const journal = new TaskSyncJournal();
  const pendingTail: BranchChangeRecord[] = [];
  const branchPort: TaskSyncBranchPort = {
    stream: branchStream,
    filesAt: async (offset?: Offset) => {
      const files = new Map<string, string>();
      for (const [path, bytes] of world.filesAtBranch(branchStream, offset)) {
        files.set(path, sha256Hex(bytes));
      }
      return files;
    },
    readFileAt: async (path: string, offset?: Offset) => {
      const bytes = world.filesAtBranch(branchStream, offset).get(path);
      if (bytes === undefined) throw new Error(`no file ${path}`);
      return bytes;
    },
    write: async (ops) => {
      const receipts = world.writeBranch(branchStream, ops);
      pendingTail.push(...world.changeRecords(receipts));
      return receipts;
    },
  };
  const streamsPort: TaskSyncStreamsPort = {
    read: async (streamId) => world.read(streamId),
    dispatch: (streamId, event) => world.dispatch(streamId, event),
    ensureContent: async (contentStreamId, bytes, sha256) => {
      const existing = world.read(contentStreamId);
      if (existing.length > 0) {
        const state = reduceContentEvents(existing);
        if (!state.sealed || state.sha256 !== sha256) throw new Error("content mismatch");
        return;
      }
      const chunk = await world.dispatch(contentStreamId, {
        type: "content.chunk",
        payload: { v: 1, seq: 0, bytes: Buffer.from(bytes).toString("base64") },
        ts: 1,
      });
      if (!chunk.ok) throw new Error(chunk.reason);
      const sealed = await world.dispatch(contentStreamId, {
        type: "content.sealed",
        payload: { v: 1, sha256, size: bytes.byteLength, chunks: 1 },
        ts: 1,
      });
      if (!sealed.ok) throw new Error(sealed.reason);
    },
    readContent: async (contentStreamId) =>
      contentBytes(reduceContentEvents(world.read(contentStreamId))),
  };
  const engine = new TaskFolderSyncEngine({
    org: ORG,
    repo: REPO,
    actor,
    branch: branchPort,
    streams: streamsPort,
    journal,
    now: () => 1000,
    ...(originFilter === undefined ? {} : { originFilter }),
  });
  /** Deliver everything on the simulated tail (user writes and own writes alike). */
  const drainTail = async (): Promise<void> => {
    while (pendingTail.length > 0) {
      const batch = pendingTail.splice(0, pendingTail.length);
      await engine.handleBranchBatch(batch);
    }
  };
  const userWrite = async (path: string, bytes: Uint8Array | string): Promise<void> => {
    const receipts = world.writeBranch(branchStream, [
      {
        kind: "write",
        path,
        bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      },
    ]);
    pendingTail.push(...world.changeRecords(receipts));
    await drainTail();
    await engine.refreshAll();
    await drainTail();
  };
  return { engine, journal, drainTail, userWrite, pendingTail };
}

describe("TaskFolderSyncEngine (in-memory, deterministic)", () => {
  const README_PATH = `${TASK_SYNC_ROOT}/${FOLDER}/readme.md`;

  it("creation + revision + log entry + evidence produce exact event counts, no echo", async () => {
    const world = new MemoryWorld();
    const a = makeEngine(world, ORIGIN.stream, "agent-ash");
    await a.userWrite(README_PATH, CANONICAL.replace("id: E9-T01\nepic: 9", "epic: 9\nid: E9-T01"));
    expect(world.read(STREAM).map((record) => record.type)).toEqual([
      "issue.opened",
      "task.spec-revised",
    ]);
    // Projection wrote the canonical bytes back; echo suppressed, not re-dispatched.
    expect(new TextDecoder().decode(world.filesAtBranch(ORIGIN.stream).get(README_PATH))).toBe(
      CANONICAL,
    );

    await a.userWrite(README_PATH, CANONICAL.replace("Created by client A.", "Revised."));
    expect(world.read(STREAM).map((record) => record.type)).toEqual([
      "issue.opened",
      "task.spec-revised",
      "task.spec-revised",
    ]);

    const started = "\n### 2026-08-30 — builder — started\n- Run: agent-run:maple/run-1\n";
    await a.userWrite(README_PATH, README("pending", "Revised.", started) + "\n");
    expect(world.read(STREAM).map((record) => record.type)).toEqual([
      "issue.opened",
      "task.spec-revised",
      "task.spec-revised",
      "task.spec-revised",
      "task.started",
    ]);
    const state = replayTaskLog(STREAM, world.read(STREAM));
    expect(state.status).toBe("in-progress");
    // Projection restored the authoritative status into the branch bytes.
    const readme = new TextDecoder().decode(world.filesAtBranch(ORIGIN.stream).get(README_PATH));
    expect(readme).toContain("status: in-progress");

    const bin = new Uint8Array([5, 6, 7]);
    await a.userWrite(`${TASK_SYNC_ROOT}/${FOLDER}/evidence/run.bin`, bin);
    const attachments = world
      .read(EVIDENCE_STREAM)
      .filter((record) => record.type === "evidence.attached");
    expect(attachments).toHaveLength(1);
    expect((attachments[0]!.payload as { sha256: string }).sha256).toBe(sha256Hex(bin));
    // Content stream addressed by the bytes' SHA-256, sealed with matching digest.
    const content = reduceContentEvents(
      world.read(`evidence-content:${ORG}/${REPO}/${sha256Hex(bin)}`),
    );
    expect(content.sealed).toBe(true);
    expect(content.sha256).toBe(sha256Hex(bin));

    // Quiescence: nothing pending, replaying refreshAll appends nothing anywhere.
    const before = canonicalJson({
      task: world.read(STREAM).length,
      branch: world.branchOf(ORIGIN.stream).log.length,
    });
    await a.engine.refreshAll();
    await a.drainTail();
    expect(
      canonicalJson({
        task: world.read(STREAM).length,
        branch: world.branchOf(ORIGIN.stream).log.length,
      }),
    ).toBe(before);

    // Journal audit: every branch offset and stream offset in its frozen multiplicity.
    const audit = auditTaskSyncJournal(a.journal.state, {
      branch: {
        stream: ORIGIN.stream,
        offsets: world.branchOf(ORIGIN.stream).log.map((entry) => entry.offset),
      },
      streams: [
        { stream: STREAM, offsets: world.read(STREAM).map((record) => record.offset) },
        {
          stream: EVIDENCE_STREAM,
          offsets: world.read(EVIDENCE_STREAM).map((record) => record.offset),
        },
      ],
    });
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it("removing an evidence reference detaches it but never deletes shared content", async () => {
    const world = new MemoryWorld();
    const a = makeEngine(world, ORIGIN.stream, "agent-ash");
    await a.userWrite(README_PATH, CANONICAL);
    const bin = new Uint8Array([1, 2, 3]);
    await a.userWrite(`${TASK_SYNC_ROOT}/${FOLDER}/evidence/run.bin`, bin);
    const contentStream = `evidence-content:${ORG}/${REPO}/${sha256Hex(bin)}`;
    const contentLenBefore = world.read(contentStream).length;
    // Remove the file: the engine detaches the reference and deletes the branch copy.
    const receipts = world.writeBranch(ORIGIN.stream, [
      { kind: "delete", path: `${TASK_SYNC_ROOT}/${FOLDER}/evidence/run.bin` },
    ]);
    a.pendingTail.push(...world.changeRecords(receipts));
    await a.drainTail();
    const types = world.read(EVIDENCE_STREAM).map((record) => record.type);
    expect(types).toEqual(["evidence.attached", "evidence.detached"]);
    expect(world.read(contentStream).length).toBe(contentLenBefore);
    // Replay still reconstructs the bytes from the content stream.
    expect(contentBytes(reduceContentEvents(world.read(contentStream)))).toEqual(bin);
  });

  it("an illegal status edit is refused, restored, and appends zero task events", async () => {
    const world = new MemoryWorld();
    const a = makeEngine(world, ORIGIN.stream, "agent-ash");
    await a.userWrite(README_PATH, CANONICAL);
    const eventsBefore = world.read(STREAM).length;
    await a.userWrite(README_PATH, README("verified") + "\n");
    expect(world.read(STREAM).length).toBe(eventsBefore);
    const files = world.filesAtBranch(ORIGIN.stream);
    expect(new TextDecoder().decode(files.get(README_PATH))).toBe(CANONICAL);
    const artifacts = [...files.keys()].filter((path) => path.includes("work/.sync/refused/"));
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    const artifactJson = artifacts.find((path) => path.endsWith(".json"))!;
    expect(new TextDecoder().decode(files.get(artifactJson))).toContain("status/illegal-edit");
  });

  it("changes under work/ cause zero events and zero projection writes", async () => {
    const world = new MemoryWorld();
    const a = makeEngine(world, ORIGIN.stream, "agent-ash");
    await a.userWrite(README_PATH, CANONICAL);
    const taskLen = world.read(STREAM).length;
    const branchLen = world.branchOf(ORIGIN.stream).log.length;
    await a.userWrite(`${TASK_SYNC_ROOT}/${FOLDER}/work/notes.txt`, "scratch\n");
    expect(world.read(STREAM).length).toBe(taskLen);
    // Only the workshop write itself (and its parent dir) landed; no projection followed.
    const newEntries = world.branchOf(ORIGIN.stream).log.slice(branchLen);
    expect(newEntries.every((entry) => entry.op.path.includes("/work"))).toBe(true);
    const workshop = a.journal.state.filter((record) => record.kinds.includes("workshop"));
    expect(workshop).toHaveLength(1);
  });

  it("two clients revising from one base: one fenced append wins, the loser gets a conflict artifact and both converge", async () => {
    const world = new MemoryWorld();
    const branchB = `fs:${ORG}/${REPO}:client-b:meta`;
    const a = makeEngine(world, ORIGIN.stream, "agent-ash");
    const b = makeEngine(world, branchB, "agent-fern");
    await a.userWrite(README_PATH, CANONICAL);
    await b.engine.refreshAll();
    await b.drainTail();
    // Both branches now hold the same accepted revision.
    const editA = CANONICAL.replace("Probe the sync engine.", "Goal per client A.");
    const editB = CANONICAL.replace("Probe the sync engine.", "Goal per client B.");
    // Stage both edits before either engine sees the other's outcome.
    const receiptsA = world.writeBranch(ORIGIN.stream, [
      { kind: "write", path: README_PATH, bytes: new TextEncoder().encode(editA) },
    ]);
    const receiptsB = world.writeBranch(branchB, [
      { kind: "write", path: README_PATH, bytes: new TextEncoder().encode(editB) },
    ]);
    a.pendingTail.push(...world.changeRecords(receiptsA));
    b.pendingTail.push(...world.changeRecords(receiptsB));
    await a.drainTail(); // A wins the fence.
    await b.drainTail(); // B loses: stale base → conflict artifact + restore.
    await b.engine.refreshAll();
    await b.drainTail();
    await a.engine.refreshAll();
    await a.drainTail();
    const revisions = world.read(STREAM).filter((record) => record.type === "task.spec-revised");
    expect(revisions).toHaveLength(2); // creation + A's edit; B's edit was refused.
    const filesA = world.filesAtBranch(ORIGIN.stream);
    const filesB = world.filesAtBranch(branchB);
    expect(new TextDecoder().decode(filesB.get(README_PATH))).toBe(
      new TextDecoder().decode(filesA.get(README_PATH)),
    );
    expect(new TextDecoder().decode(filesA.get(README_PATH))).toContain("Goal per client A.");
    const conflicts = [...filesB.keys()].filter((path) => path.includes("work/.sync/conflicts/"));
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    const retained = conflicts.find((path) => path.endsWith(".retained"))!;
    expect(new TextDecoder().decode(filesB.get(retained))).toContain("Goal per client B.");
  });

  it("CRITIC-A: a fenced quotation of the documented entry format dispatches zero events", async () => {
    const world = new MemoryWorld();
    const a = makeEngine(world, ORIGIN.stream, "agent-ash");
    await a.userWrite(README_PATH, CANONICAL);
    expect(world.read(STREAM).map((record) => record.type)).toEqual([
      "issue.opened",
      "task.spec-revised",
    ]);
    const before = world.read(STREAM).length;

    // Prose quoting the entry format documented in .eforest/tasks/README.md. Nothing
    // outside the fence claims anything.
    const quoted = [
      "",
      "",
      "This task has not started. The entry format, quoted from the docs:",
      "",
      "```",
      "### 2026-08-31 — builder — started",
      "- Run: agent-run:maple/run-doc",
      "```",
      "",
      "Nothing above is a real claim.",
      "",
    ].join("\n");
    await a.userWrite(README_PATH, README("pending", "Created by client A.", quoted) + "\n");
    const types = world.read(STREAM).map((record) => record.type);
    expect(types).not.toContain("task.started");
    // The prose IS a legitimate text revision: exactly one spec revision, no lifecycle.
    expect(world.read(STREAM).length).toBe(before + 1);
    expect(types.at(-1)).toBe("task.spec-revised");
    expect(replayTaskLog(STREAM, world.read(STREAM)).status).toBe("pending");
    // Completely inert: quoted documentation is not even a refused claim, so no
    // conflict/refusal artifact is produced. (Without fence-aware heading detection the
    // fenced block becomes an entry whose fields are missing, and this goes red.)
    const artifacts = [...world.filesAtBranch(ORIGIN.stream).keys()].filter((path) =>
      path.includes("work/.sync/"),
    );
    expect(artifacts).toEqual([]);
  });

  it("CRITIC-D: an in-progress critic note quoting a complete verdict inside a fence never reaches verified", async () => {
    const world = new MemoryWorld();
    const branchB = `fs:${ORG}/${REPO}:client-b:meta`;
    const a = makeEngine(world, ORIGIN.stream, "agent-ash");
    const b = makeEngine(world, branchB, "agent-fern");
    await a.userWrite(README_PATH, CANONICAL);
    const bin = new Uint8Array([1, 2, 3]);
    await a.userWrite(`${TASK_SYNC_ROOT}/${FOLDER}/evidence/run.bin`, bin);
    const claimLog = [
      "",
      "",
      "### 2026-08-30 — builder — started",
      "- Run: agent-run:maple/run-a",
      "",
      "### 2026-08-30 — builder — claimed",
      "- Run: agent-run:maple/run-a",
      `- Branch: ${ORIGIN.stream}@${offsetForOrdinal(3)}`,
      "- Evidence: run.bin",
      "- Summary: did the work.",
      "",
    ].join("\n");
    await a.userWrite(README_PATH, README("pending", "Created by client A.", claimLog) + "\n");
    expect(replayTaskLog(STREAM, world.read(STREAM)).status).toBe("implemented");
    await b.engine.refreshAll();
    await b.drainTail();
    const eventsBefore = world.read(STREAM).map((record) => record.type);

    // The critic writes an honest in-progress note that QUOTES a finished verdict.
    const quotedVerdict = [
      claimLog.replace(/\n$/, ""),
      "",
      "### 2026-08-31 — critic — in-progress notes",
      "Still reviewing. For reference, a finished verdict looks like this:",
      "",
      "```",
      "### 2026-08-31 — critic — VERDICT: verified",
      "- Run: agent-run:maple/run-b",
      `- Branch: ${ORIGIN.stream}@${offsetForOrdinal(3)}`,
      "- Evidence: run.bin",
      "- Summary: EXAMPLE ONLY — not a verdict.",
      "```",
      "",
    ].join("\n");
    const bText = new TextDecoder().decode(world.filesAtBranch(branchB).get(README_PATH));
    await b.userWrite(
      README_PATH,
      bText.replace(/## Verification log[\s\S]*$/, `## Verification log${quotedVerdict}`),
    );
    const state = replayTaskLog(STREAM, world.read(STREAM));
    expect(state.status).toBe("implemented");
    expect(state.verification).toBeUndefined();
    const types = world.read(STREAM).map((record) => record.type);
    expect(types).not.toContain("task.verified");
    expect(
      types.filter((type) => type.startsWith("task.") && type !== "task.spec-revised"),
    ).toEqual(
      eventsBefore.filter((type) => type.startsWith("task.") && type !== "task.spec-revised"),
    );
    // Whatever artifacts the race leaves, none of them may be about the quoted verdict:
    // documentation is never a refused lifecycle claim. (Without fence-aware heading
    // detection the fenced entry is parsed and refused, and this goes red.)
    const decoder = new TextDecoder();
    const reasons = [...world.filesAtBranch(branchB)]
      .filter(([path]) => path.includes("work/.sync/") && path.endsWith(".json"))
      .map(([, bytes]) => JSON.parse(decoder.decode(bytes)).reason as string);
    expect(
      reasons.filter((reason) => reason.startsWith("log/") || reason.startsWith("task/no-claim")),
    ).toEqual([]);
  });

  it("SABOTAGE: with the origin filter off, the engine re-ingests its own projection and the event count moves", async () => {
    expect(E6_T05_ORIGIN_FILTER_GUARD).toBe(true);
    const worldOn = new MemoryWorld();
    const on = makeEngine(worldOn, ORIGIN.stream, "agent-ash");
    await on.userWrite(
      README_PATH,
      CANONICAL.replace("id: E9-T01\nepic: 9", "epic: 9\nid: E9-T01"),
    );
    const eventsOn = worldOn.read(STREAM).map((record) => record.type);

    const worldOff = new MemoryWorld();
    const off = makeEngine(worldOff, ORIGIN.stream, "agent-ash", false);
    await off.userWrite(
      README_PATH,
      CANONICAL.replace("id: E9-T01\nepic: 9", "epic: 9\nid: E9-T01"),
    );
    const eventsOff = worldOff.read(STREAM).map((record) => record.type);
    expect(eventsOn).toEqual(["issue.opened", "task.spec-revised"]);
    expect(eventsOff.length).toBeGreaterThan(eventsOn.length);
    expect(eventsOff.filter((type) => type === "task.spec-revised").length).toBeGreaterThan(1);
    // And the journal multiplicity is broken: own offsets show up as ingested.
    const audit = auditTaskSyncJournal(off.journal.state, {
      branch: {
        stream: ORIGIN.stream,
        offsets: worldOff.branchOf(ORIGIN.stream).log.map((entry) => entry.offset),
      },
      streams: [{ stream: STREAM, offsets: worldOff.read(STREAM).map((record) => record.offset) }],
    });
    expect(audit.ok).toBe(false);
  });
});
