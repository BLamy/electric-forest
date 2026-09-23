/**
 * E6-T05 integration: two real sync clients (one branch each, one shared task stream)
 * against the published durable stream server and the real platform gateway. Client A
 * is the builder's machine, client B the critic's. Everything mutates through the
 * dispatch door; the test asserts exact event counts, byte-identical folders on both
 * branches, refusal/conflict artifacts, and journal audits.
 */
import type { Server } from "node:http";
import { canonicalJson, sha256Hex, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import { createDurableJsonStream, readDurableJson } from "@eforest/client";
import { StreamFsRepo } from "@eforest/streamfs";
import { auditTaskSyncJournal, projectTaskFolder, replayTaskLog } from "@eforest/tasks";
import { TaskSyncClient } from "@eforest/tasks/sync-node";
import {
  attachmentInitialStateForStream,
  attachmentReducer,
  contentBytes,
  reduceContentEvents,
  type ContentAttachment,
} from "@eforest/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FixedWindowRateLimiter,
  OfficialStreamAdapter,
  PlatformGateway,
  createPlatformServer,
  listenPlatformServer,
  type AuthzInput,
  type AuthorizationVerifier,
} from "../src/index.js";

const ORG = "maple";
const REPO = "sync-live";
const TASK = "E9-T01";
const FOLDER = "epic-9/E9-T01-sync-live";
const ROOT = ".eforest/tasks";
const README_PATH = `${ROOT}/${FOLDER}/readme.md`;
const TASK_STREAM = `issue:${ORG}/${REPO}/${TASK}`;
const EVIDENCE_STREAM = `evidence:${ORG}/${REPO}/issue/${TASK}`;
const BUILDER = "agent-ash";
const CRITIC = "agent-fern";

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async (header) => {
    const sub = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : "";
    if (sub === "") throw new TypeError("missing bearer identity");
    return { sub };
  },
};

function decide(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write" as const,
    streamId: "streamId" in input.target ? input.target.streamId : "",
  };
}

const README = (status: string, context: string, log: string): string =>
  [
    "---",
    `id: ${TASK}`,
    "epic: 9",
    "title: Live sync task",
    "priority: 901",
    `status: ${status}`,
    "depends_on: []",
    "estimate: S",
    "capstone: false",
    "---",
    "",
    "## Goal",
    "Prove the folder is the stream.",
    "",
    "## Context",
    context,
    "",
    "## Deliverables",
    "- Folder sync.",
    "",
    "## Acceptance criteria",
    "- [ ] Byte parity.",
    "",
    "## Adversarial verification",
    "1. Race the watchers.",
    "",
    "## Verification log",
    log,
  ].join("\n");

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

describe("task folders on streams: two real clients (E6-T05)", () => {
  let official: ReturnType<typeof createDurableStreamTestServer>;
  let officialUrl: string;
  let server: Server;
  let gateway: PlatformGateway;
  let gatewayUrl: string;
  let clientA: TaskSyncClient;
  let clientB: TaskSyncClient;
  let repoA: StreamFsRepo;
  let repoB: StreamFsRepo;
  const warnings: string[] = [];
  const userFileSeq = new Map<string, number>();

  beforeAll(async () => {
    official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    officialUrl = await official.start();
    gateway = new PlatformGateway({
      verifier,
      streams: new OfficialStreamAdapter({ baseUrl: officialUrl }),
      decideAuthorization: decide,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      rateLimiter: new FixedWindowRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }),
    });
    server = createPlatformServer((request) => gateway.handle(request));
    gatewayUrl = await listenPlatformServer(server);
    await createDurableJsonStream({
      url: `${officialUrl}/streams/${encodeURIComponent(`fs:${ORG}/${REPO}:main:meta`)}`,
    });
    const main = new StreamFsRepo(officialUrl, fetch, `${ORG}/${REPO}`);
    await main.createFile("README.md", new TextEncoder().encode("seed\n"));
    await main.createBranch("client-a");
    await main.createBranch("client-b");
    repoA = new StreamFsRepo(officialUrl, fetch, `${ORG}/${REPO}`, "client-a");
    repoB = new StreamFsRepo(officialUrl, fetch, `${ORG}/${REPO}`, "client-b");
    clientA = new TaskSyncClient({
      org: ORG,
      repo: REPO,
      branch: "client-a",
      actor: BUILDER,
      token: BUILDER,
      gatewayUrl,
      streamServerUrl: officialUrl,
      pollMs: 120,
      onWarning: (message) => warnings.push(`A: ${message}`),
    });
    clientB = new TaskSyncClient({
      org: ORG,
      repo: REPO,
      branch: "client-b",
      actor: CRITIC,
      token: CRITIC,
      gatewayUrl,
      streamServerUrl: officialUrl,
      pollMs: 120,
      onWarning: (message) => warnings.push(`B: ${message}`),
    });
    await clientA.start();
    await clientB.start();
  }, 120_000);

  afterAll(async () => {
    await clientA.stop();
    await clientB.stop();
    gateway.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await official.stop();
  });

  async function dispatchAs(
    sub: string,
    streamId: string,
    event: Event,
    contentEvent?: Event,
  ): Promise<Offset> {
    const response = await fetch(`${gatewayUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sub}`,
        "content-type": "application/json",
        "x-eforest-dispatch-receipt": "offset",
      },
      body: JSON.stringify({ streamId, event, ...(contentEvent ? { contentEvent } : {}) }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(202);
    return (JSON.parse(body) as { readonly offset: Offset }).offset;
  }

  /** A user edit on a branch, dispatched through the door like the E4 uplink. */
  async function userWrite(
    branch: "client-a" | "client-b",
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const sub = branch === "client-a" ? BUILDER : CRITIC;
    const repo = branch === "client-a" ? repoA : repoB;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const tree = await repo.tree();
    const meta = repo.metadataStreamId;
    const dirs = new Set(Object.keys(tree.dirs));
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const dir = segments.slice(0, depth).join("/");
      if (dirs.has(dir)) continue;
      await dispatchAs(sub, meta, {
        type: "fs.dir.create",
        payload: { v: 2, path: dir },
        ts: Date.now(),
      });
      dirs.add(dir);
    }
    const existing = tree.files[path];
    let contentStreamId: string;
    let base: string;
    if (existing === undefined || existing.lastContentOffset === "BASE_NONE") {
      const seq = (userFileSeq.get(branch) ?? 0) + 1;
      userFileSeq.set(branch, seq);
      contentStreamId = `fs:${ORG}/${REPO}:${branch}:file:user-${seq}`;
      if (existing === undefined) {
        await dispatchAs(sub, meta, {
          type: "fs.file.create",
          payload: { v: 2, path, contentStreamId },
          ts: Date.now(),
        });
      }
      base = "BASE_NONE";
    } else {
      contentStreamId = existing.contentStreamId;
      base = existing.lastContentOffset;
    }
    await dispatchAs(
      sub,
      meta,
      {
        type: "fs.file.write",
        payload: { v: 2, path, base, contentSha256: sha256Hex(bytes), size: bytes.byteLength },
        ts: Date.now(),
      },
      {
        type: "fs.file.content",
        payload: {
          v: 2,
          contentStreamId,
          contentBase64: Buffer.from(bytes).toString("base64"),
        },
        ts: Date.now(),
      },
    );
  }

  async function userDelete(branch: "client-a" | "client-b", path: string): Promise<void> {
    const sub = branch === "client-a" ? BUILDER : CRITIC;
    const repo = branch === "client-a" ? repoA : repoB;
    await dispatchAs(sub, repo.metadataStreamId, {
      type: "fs.file.delete",
      payload: { v: 2, path },
      ts: Date.now(),
    });
  }

  async function branchText(repo: StreamFsRepo, path: string): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await repo.readFile(path));
    } catch {
      return undefined;
    }
  }

  async function taskRecords(streamId: string): Promise<readonly (Event & { offset: Offset })[]> {
    let raw: readonly Event[];
    try {
      raw = await readDurableJson<Event>({
        url: `${officialUrl}/streams/${encodeURIComponent(streamId)}`,
      });
    } catch {
      return [];
    }
    return raw.map((value, index) => ({
      type: value.type,
      payload: Object.fromEntries(
        Object.entries(value.payload as Record<string, unknown>).filter(
          ([key]) => key !== "actor" && key !== "writer",
        ),
      ),
      ts: value.ts,
      offset: offsetForOrdinal(index),
    }));
  }

  it(
    "runs the issue-to-verified lifecycle through folder edits on two branches",
    { timeout: 300_000 },
    async () => {
      // 1. Creation on A, with non-canonical frontmatter order: exactly one issue.opened
      //    + one task.spec-revised; both branches converge on the canonical bytes.
      const canonical = README("pending", "Created by A.", "") + "\n";
      const nonCanonical = canonical.replace("id: E9-T01\nepic: 9", "epic: 9\nid: E9-T01");
      await userWrite("client-a", README_PATH, nonCanonical);
      await waitFor(
        async () => (await branchText(repoB, README_PATH)) === canonical,
        "B materializes the canonical folder",
      );
      expect(await branchText(repoA, README_PATH)).toBe(canonical);
      expect((await taskRecords(TASK_STREAM)).map((record) => record.type)).toEqual([
        "issue.opened",
        "task.spec-revised",
      ]);

      // 2. Remote prose revision from B.
      const revised = canonical.replace("Created by A.", "Created by A; B revised.");
      await userWrite("client-b", README_PATH, revised);
      await waitFor(
        async () => (await branchText(repoA, README_PATH)) === revised,
        "A sees B's revision",
      );

      // 3. Evidence: binary bytes on A become one content stream + one attachment.
      const bin = new Uint8Array(300).map((_, index) => (index * 7) % 256);
      await userWrite("client-a", `${ROOT}/${FOLDER}/evidence/run.bin`, bin);
      await waitFor(async () => {
        try {
          return (
            sha256Hex(await repoB.readFile(`${ROOT}/${FOLDER}/evidence/run.bin`)) === sha256Hex(bin)
          );
        } catch {
          return false;
        }
      }, "B materializes the evidence bytes");
      const contentStream = `evidence-content:${ORG}/${REPO}/${sha256Hex(bin)}`;
      const content = reduceContentEvents(await taskRecords(contentStream));
      expect(content.sealed).toBe(true);
      expect(content.sha256).toBe(sha256Hex(bin));

      // 4. Builder log entries: started + claimed in one append → two lifecycle events.
      const branchRef = `fs:${ORG}/${REPO}:client-a:meta@${offsetForOrdinal(4)}`;
      const log = [
        "",
        "",
        "### 2026-08-30 — builder — started",
        "- Run: agent-run:maple/e9-t01-run-1",
        "",
        "### 2026-08-30 — builder — claimed",
        "- Run: agent-run:maple/e9-t01-run-1",
        `- Branch: ${branchRef}`,
        "- Evidence: run.bin",
        "- Summary: folder sync demonstrated end to end.",
        "",
      ].join("\n");
      const current = (await branchText(repoA, README_PATH))!;
      await userWrite("client-a", README_PATH, current.replace(/\n$/, log));
      await waitFor(async () => {
        const text = await branchText(repoB, README_PATH);
        return text !== undefined && text.includes("status: implemented");
      }, "status implemented projected to B");
      let records = await taskRecords(TASK_STREAM);
      expect(records.map((record) => record.type)).toEqual([
        "issue.opened",
        "task.spec-revised",
        "task.spec-revised",
        "task.spec-revised",
        "task.started",
        "task.claimed",
      ]);

      // 5. Forgery: a builder paragraph claiming a critic verdict, plus a raw
      //    frontmatter edit to verified. No path to verified without a critic event.
      const forgedLog = [
        "",
        "### 2026-08-30 — builder — verified",
        "- Run: agent-run:maple/e9-t01-run-1",
        `- Branch: ${branchRef}`,
        "- Evidence: run.bin",
        "- Summary: trust me, I checked.",
        "",
      ].join("\n");
      const beforeForgery = (await branchText(repoA, README_PATH))!;
      const forged = beforeForgery
        .replace("status: implemented", "status: verified")
        .replace(/\n$/, `${forgedLog}`);
      await userWrite("client-a", README_PATH, forged);
      await waitFor(async () => {
        const text = await branchText(repoA, README_PATH);
        return (
          text !== undefined &&
          text.includes("status: implemented") &&
          text.includes("trust me, I checked.")
        );
      }, "forged status restored while the text lands");
      records = await taskRecords(TASK_STREAM);
      expect(records.map((record) => record.type)).not.toContain("task.verified");
      expect(replayTaskLog(TASK_STREAM, records).status).toBe("implemented");
      const treeA = await repoA.tree();
      const artifactPaths = Object.keys(treeA.files).filter((path) =>
        path.includes(`${FOLDER}/work/.sync/`),
      );
      expect(artifactPaths.some((path) => path.endsWith(".json"))).toBe(true);
      const artifactJson = await branchText(
        repoA,
        artifactPaths.find((path) => path.endsWith(".json"))!,
      );
      expect(artifactJson).toContain("log/role-kind-mismatch");

      // 6. The critic verdict from B's machine (B's principal is not the builder).
      const verdict = [
        "",
        "### 2026-08-30 — critic — VERDICT: verified",
        "- Run: agent-run:maple/e9-t01-run-2",
        `- Branch: ${branchRef}`,
        "- Evidence: run.bin",
        "- Summary: interrogated the run; no refutation held.",
        "",
      ].join("\n");
      const bText = (await branchText(repoB, README_PATH))!;
      await userWrite("client-b", README_PATH, bText.replace(/\n$/, `${verdict}`));
      await waitFor(async () => {
        const text = await branchText(repoA, README_PATH);
        return text !== undefined && text.includes("status: verified");
      }, "verified status projected to A");
      records = await taskRecords(TASK_STREAM);
      expect(records.at(-1)!.type).toBe("task.verified");
      expect(replayTaskLog(TASK_STREAM, records).status).toBe("verified");

      // 7. work/ changes: zero events on every stream, durable digests untouched.
      const taskLen = records.length;
      const evidenceLen = (await taskRecords(EVIDENCE_STREAM)).length;
      await userWrite("client-a", `${ROOT}/${FOLDER}/work/notes.txt`, "scratch\n");
      await waitFor(async () => {
        const journal = clientA.journal.state;
        return journal.some((record) => record.kinds.includes("workshop"));
      }, "workshop write accounted");
      expect((await taskRecords(TASK_STREAM)).length).toBe(taskLen);
      expect((await taskRecords(EVIDENCE_STREAM)).length).toBe(evidenceLen);

      // 8. Delete the derived folder on B; projection recreates the exact bytes.
      const readmeBytesBefore = (await branchText(repoB, README_PATH))!;
      await userDelete("client-b", README_PATH);
      await userDelete("client-b", `${ROOT}/${FOLDER}/evidence/run.bin`);
      await waitFor(async () => {
        const text = await branchText(repoB, README_PATH);
        if (text !== readmeBytesBefore) return false;
        try {
          return (
            sha256Hex(await repoB.readFile(`${ROOT}/${FOLDER}/evidence/run.bin`)) === sha256Hex(bin)
          );
        } catch {
          return false;
        }
      }, "deleted folder recreated byte-for-byte");
      expect(
        (await taskRecords(EVIDENCE_STREAM)).filter((r) => r.type === "evidence.detached"),
      ).toEqual([]);

      // 9. Independent replay parity: project the folder from the streams alone and
      //    compare byte-for-byte with both branches.
      records = await taskRecords(TASK_STREAM);
      const state = replayTaskLog(TASK_STREAM, records);
      const attachments = (await taskRecords(EVIDENCE_STREAM)).reduce(
        attachmentReducer,
        attachmentInitialStateForStream(EVIDENCE_STREAM),
      );
      const live = attachments.attachments.filter(
        (attachment): attachment is ContentAttachment =>
          attachment.type === "content" && attachment.detachedAtOffset === undefined,
      );
      const evidenceSources = [];
      for (const attachment of live) {
        evidenceSources.push({
          attachmentId: attachment.attachmentId,
          name: attachment.name,
          sha256: attachment.sha256,
          bytes: contentBytes(reduceContentEvents(await taskRecords(attachment.contentStream))),
        });
      }
      const projection = projectTaskFolder({ state, evidence: evidenceSources });
      for (const file of projection.files) {
        const full = `${ROOT}/${FOLDER}/${file.path}`;
        expect(sha256Hex(await repoA.readFile(full)), `A ${file.path}`).toBe(sha256Hex(file.bytes));
        expect(sha256Hex(await repoB.readFile(full)), `B ${file.path}`).toBe(sha256Hex(file.bytes));
      }
      // Replay determinism: same records replayed twice → identical state digest.
      expect(stateDigest(replayTaskLog(TASK_STREAM, records))).toBe(stateDigest(state));

      // 10. Journal audits: every branch offset under the root and every stream record
      //     in its frozen multiplicity, for both clients.
      for (const [client, repo] of [
        [clientA, repoA],
        [clientB, repoB],
      ] as const) {
        const dump = await repo.rawDump();
        const offsets = dump
          .filter((record) => {
            const payload = record.payload as { readonly path?: unknown };
            return typeof payload.path === "string" && payload.path.startsWith(ROOT);
          })
          .map((record) => record.offset);
        // Content streams are digest-bound through evidence.attached, not journaled.
        const streams = [TASK_STREAM, EVIDENCE_STREAM];
        const streamOffsets = [];
        for (const stream of streams) {
          streamOffsets.push({
            stream,
            offsets: (await taskRecords(stream)).map((record) => record.offset),
          });
        }
        const audit = auditTaskSyncJournal(client.journal.state, {
          branch: { stream: client.branchStream, offsets },
          streams: streamOffsets,
        });
        expect(audit.violations, canonicalJson(audit)).toEqual([]);
        expect(audit.ok).toBe(true);
      }
      // The only warnings are the designed refusals: the illegal status edit, the
      // forged verdict paragraph, and the readme-missing restores of step 8.
      const unexpected = warnings.filter(
        (message) =>
          !message.includes("status/illegal-edit") &&
          !message.includes("log/role-kind-mismatch") &&
          !message.includes("folder/readme-missing"),
      );
      expect(unexpected).toEqual([]);
    },
  );
});
