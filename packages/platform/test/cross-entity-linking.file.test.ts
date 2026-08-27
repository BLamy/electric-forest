import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyView } from "@eforest/identity";
import {
  meadowPrInitialStateForStream,
  meadowPrReducer,
  type MergeBranch,
  type MergeStreamRecord,
} from "@eforest/meadow";
import { canonicalJson, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { issueInitialStateFor, reduceIssueApplicationEvent } from "@eforest/reducers";
import { createDurableStreamTestServer } from "@eforest/server";
import { fsInitialState, type FastForwardMergeReceipt } from "@eforest/streamfs";
import { describe, expect, it } from "vitest";
import {
  OfficialStreamAdapter,
  PlatformGateway,
  type AuthorizationVerifier,
} from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const PR_STREAM = "pr:maple/reading-room/42";
const ISSUE_STREAM = "issue:maple/reading-room/7";
const TARGET_STREAM = "fs:maple/reading-room:main:meta";
const SOURCE_STREAM = "fs:maple/reading-room:feature:meta";
const EVIDENCE_STREAM = "evidence:maple/reading-room/pr/42";
const RESULT_DIGEST = "a".repeat(64);
const at = offsetForOrdinal;
const fixtureRoot = new URL("../../meadow/fixtures/linking/close-on-merge/", import.meta.url);
const taskEvidenceRoot = new URL(
  "../../../.eforest/tasks/epic-5-the-meadow/E5-T07-cross-entity-linking/evidence/",
  import.meta.url,
);

function event(type: string, payload: Record<string, unknown>, ts: number): Event {
  return { type, payload, ts };
}

function mergeRecord(
  ordinal: number,
  type: string,
  payload: Record<string, unknown>,
): MergeStreamRecord {
  return { ...event(type, payload, ordinal + 1), offset: at(ordinal) };
}

class MemoryBranch implements MergeBranch {
  constructor(
    readonly metadataStreamId: string,
    readonly records: MergeStreamRecord[],
  ) {}

  async rawDump(): Promise<readonly MergeStreamRecord[]> {
    return [...this.records];
  }

  async treeAt() {
    return fsInitialState;
  }
}

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: "alice" }),
  authorizationContext: async () => ({
    principal: { kind: "identified", sub: "alice" },
    identity: emptyView(),
    identityOffset: "-1",
  }),
};

function allow(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "public" as const,
    streamId:
      input.target.kind === "repo" ||
      input.target.kind === "control" ||
      input.target.kind === "sandbox" ||
      input.target.kind === "internal"
        ? input.target.streamId
        : PR_STREAM,
  };
}

function request(streamId: string, action: Event): Request {
  return new Request("https://platform.test/api/dispatch", {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify({ streamId, event: action }),
  });
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => canonicalJson(record)).join("\n") + "\n";
}

async function appendSeed(
  streams: OfficialStreamAdapter,
  streamId: string,
  action: Event,
): Promise<void> {
  await streams.create(streamId);
  await streams.append(streamId, action, {
    sequence: at(0),
    applicationOffset: at(0),
  });
}

describe("E5-T07 file-backed golden lifecycle", () => {
  it("reproduces both committed streams, pinned digests, and reciprocal citations", async () => {
    const runs: Array<{
      readonly issueSource: string;
      readonly prSource: string;
      readonly observedDigests: unknown;
    }> = [];
    for (let run = 0; run < 2; run += 1) {
      const dataDir = mkdtempSync(join(tmpdir(), `eforest-e5-t07-store-${String(run)}-`));
      const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
      try {
        const baseUrl = await server.start();
        const streams = new OfficialStreamAdapter({ baseUrl });
        await appendSeed(
          streams,
          TARGET_STREAM,
          event("fs.branch.genesis", { v: 1, branch: "main" }, 1),
        );
        await appendSeed(
          streams,
          SOURCE_STREAM,
          event("fs.branch.fork", { v: 1, parentStreamId: TARGET_STREAM, forkOffset: at(0) }, 2),
        );
        await appendSeed(
          streams,
          EVIDENCE_STREAM,
          event(
            "evidence.linked",
            {
              v: 1,
              attachmentId: "replay",
              kind: "replay-recording",
              url: "https://app.replay.io/recording/test",
            },
            3,
          ),
        );
        await streams.create(PR_STREAM);

        const target = new MemoryBranch(TARGET_STREAM, [
          mergeRecord(0, "fs.branch.genesis", { v: 1, branch: "main" }),
        ]);
        const source = new MemoryBranch(SOURCE_STREAM, [
          mergeRecord(0, "fs.branch.fork", {
            v: 1,
            parentStreamId: TARGET_STREAM,
            forkOffset: at(0),
          }),
        ]);
        const gateway = new PlatformGateway({
          verifier,
          streams,
          decideAuthorization: allow,
          namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
          prMerge: {
            resolveBranch: async (streamId) =>
              streamId === TARGET_STREAM ? target : streamId === SOURCE_STREAM ? source : undefined,
            operations: {
              mergeFastForward: async (branch: MergeBranch): Promise<FastForwardMergeReceipt> => {
                const persisted = mergeRecord(1, "fs.branch.merge", {
                  v: 1,
                  sourceStreamId: SOURCE_STREAM,
                  forkOffset: at(0),
                  mergedThroughOffset: at(0),
                });
                (branch as MemoryBranch).records.push(persisted);
                return {
                  mergeOffset: persisted.offset,
                  mergedThroughOffset: at(0),
                  treeDigest: RESULT_DIGEST,
                };
              },
            },
            now: () => 42,
          },
        });
        const dispatch = async (streamId: string, action: Event) => {
          const response = await gateway.handle(request(streamId, action));
          const body = await response.text();
          expect(response.status, body).toBe(202);
        };

        await dispatch(
          ISSUE_STREAM,
          event("issue.opened", { v: 1, title: "Linked issue", body: "Body" }, 10),
        );
        await dispatch(ISSUE_STREAM, event("issue.state-changed", { v: 1, to: "in-progress" }, 11));
        await dispatch(
          PR_STREAM,
          event(
            "pr.opened",
            {
              v: 1,
              sourceBranch: SOURCE_STREAM,
              targetBranch: TARGET_STREAM,
              forkOffset: at(0),
              title: "Close the issue",
              body: "Cross-stream lifecycle",
              author: "alice",
              closes: [{ entity: "issue", stream: ISSUE_STREAM }],
            },
            20,
          ),
        );
        await dispatch(PR_STREAM, event("pr.approved", { v: 1, reviewer: "bob" }, 21));
        await dispatch(PR_STREAM, event("pr.merge", { v: 1 }, 22));

        const issueRecords = (await streams.readResolved(ISSUE_STREAM)) as readonly Event[];
        const prRecords = (await streams.readResolved(PR_STREAM)) as readonly Event[];
        const issueSource = jsonl(issueRecords);
        const prSource = jsonl(prRecords);
        expect(issueSource).toBe(readFileSync(new URL("issue.events.jsonl", fixtureRoot), "utf8"));
        expect(prSource).toBe(readFileSync(new URL("pr.events.jsonl", fixtureRoot), "utf8"));
        expect(issueSource).toBe(
          readFileSync(new URL("e5-t07-issue-log.jsonl", taskEvidenceRoot), "utf8"),
        );
        expect(prSource).toBe(
          readFileSync(new URL("e5-t07-pr-log.jsonl", taskEvidenceRoot), "utf8"),
        );

        const expected = JSON.parse(
          readFileSync(new URL("expected.json", fixtureRoot), "utf8"),
        ) as {
          issue: { beforeLink: string; afterLink: string; final: string };
          pr: { final: string };
          citations: { prMergedOffset: Offset; issueOffset: Offset };
        };
        const issueDigestAt = (length: number) =>
          stateDigest(
            issueRecords
              .slice(0, length)
              .reduce(reduceIssueApplicationEvent, issueInitialStateFor("7")),
          );
        const observedDigests = {
          issue: {
            beforeLink: issueDigestAt(2),
            afterLink: issueDigestAt(3),
            final: issueDigestAt(4),
          },
          pr: {
            final: stateDigest(
              prRecords.reduce(meadowPrReducer, meadowPrInitialStateForStream(PR_STREAM)),
            ),
          },
        };
        expect(observedDigests).toEqual({ issue: expected.issue, pr: expected.pr });

        const merged = prRecords.find(({ type }) => type === "pr.merged") as Event & {
          readonly offset: Offset;
        };
        const closed = issueRecords.find(
          ({ type, payload }) =>
            type === "issue.state-changed" && (payload as { readonly to?: unknown }).to === "done",
        ) as Event & { readonly offset: Offset };
        const backlink = prRecords.find(({ type }) => type === "pr.link-closed")!;
        expect((closed.payload as { via: { prMergedOffset: Offset } }).via.prMergedOffset).toBe(
          merged.offset,
        );
        expect((backlink.payload as { issueOffset: Offset }).issueOffset).toBe(closed.offset);
        expect(expected.citations).toEqual({
          prMergedOffset: merged.offset,
          issueOffset: closed.offset,
        });
        runs.push({ issueSource, prSource, observedDigests });
      } finally {
        await server.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual(runs[0]);
  });
});
