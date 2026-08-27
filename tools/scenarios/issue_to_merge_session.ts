import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { uploadAttachment } from "../../packages/evidence/dist/src/index.js";
import { emptyView } from "../../packages/identity/dist/src/index.js";
import {
  OfficialStreamAdapter,
  PlatformGateway,
  type AuthorizationVerifier,
  type AuthzInput,
} from "../../packages/platform/dist/src/index.js";
import type { Event } from "../../packages/protocol/dist/src/index.js";
import { StreamFsRepo } from "../../packages/streamfs/dist/src/index.js";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import { captureSession } from "../../packages/cli/dist/src/index.js";

const outIndex = process.argv.indexOf("--out");
const requestedOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
const scratch =
  requestedOut === undefined ? await mkdtemp(join(tmpdir(), "e5-t12-session-")) : undefined;
const out = resolve(requestedOut ?? join(scratch!, "issue-to-merge"));
const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });

const REPO = "maple/reading-room";
const ISSUE = `issue:${REPO}/negotiation`;
const PR = `pr:${REPO}/negotiation`;
const MAIN = `fs:${REPO}:main:meta`;
const FEATURE = `fs:${REPO}:feature-negotiation:meta`;
const WIKI = `fs:${REPO}:wiki:meta`;
const TOKEN = "e5-t12-scenario";

function action(type: string, payload: Record<string, unknown>, ts: number): Event {
  return { type, payload, ts };
}

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async (header) => {
    if (header !== `Bearer ${TOKEN}`) throw new Error("scenario authorization mismatch");
    return { sub: "alice" };
  },
  authorizationContext: async (header) => {
    if (header !== `Bearer ${TOKEN}`) throw new Error("scenario authorization mismatch");
    return {
      principal: { kind: "identified", sub: "alice" },
      identity: emptyView(),
      identityOffset: "-1",
    };
  },
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
        : PR,
  };
}

async function dispatch(gateway: PlatformGateway, streamId: string, event: Event): Promise<void> {
  const response = await gateway.handle(
    new Request("https://platform.test/api/dispatch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-eforest-dispatch-receipt": "offset",
      },
      body: JSON.stringify({ streamId, event }),
    }),
  );
  if (response.status !== 202) {
    throw new Error(
      `dispatch ${event.type} to ${streamId} returned ${response.status}: ${await response.text()}`,
    );
  }
}

try {
  const baseUrl = await server.start();
  let tick = 1_700_000_000_000;
  const now = () => tick++;
  const streams = new OfficialStreamAdapter({ baseUrl });

  // StreamFS owns filesystem writes. These calls generate the branch and wiki
  // histories through its validated writer surface; no fixture records are seeded.
  await streams.create(MAIN);
  const main = new StreamFsRepo(baseUrl, fetch, REPO, "main", now);
  await main.mkdir("src");
  await main.createFile("src/base.txt", new TextEncoder().encode("base\n"));
  await main.createBranch("wiki");
  const wiki = await main.openBranch("wiki");
  await wiki.mkdir("docs");
  await wiki.createFile("docs/home.md", new TextEncoder().encode("# Home\n"));
  const fork = await main.createBranch("feature-negotiation");
  const feature = await main.openBranch("feature-negotiation");
  await feature.createFile("src/feature.txt", new TextEncoder().encode("feature\n"));

  const branches = new Map<string, StreamFsRepo>([
    [MAIN, main],
    [FEATURE, feature],
    [WIKI, wiki],
  ]);
  const gateway = new PlatformGateway({
    verifier,
    streams,
    decideAuthorization: allow,
    namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    prMerge: {
      resolveBranch: async (streamId) => branches.get(streamId),
      now,
    },
  });

  await dispatch(
    gateway,
    ISSUE,
    action(
      "issue.opened",
      { v: 1, title: "Ship the meadow", body: "Track the complete negotiation" },
      now(),
    ),
  );
  await dispatch(gateway, ISSUE, action("issue.state-changed", { v: 1, to: "in-progress" }, now()));
  await dispatch(
    gateway,
    "issue:maple/reading-room/unrelated",
    action(
      "issue.opened",
      { v: 1, title: "Unrelated", body: "Closure must exclude this stream" },
      now(),
    ),
  );
  await dispatch(
    gateway,
    PR,
    action(
      "pr.opened",
      {
        v: 1,
        sourceBranch: FEATURE,
        targetBranch: MAIN,
        forkOffset: fork.forkOffset,
        title: "Ship the meadow",
        body: "Close the issue with a replayable merge",
        author: "alice",
        closes: [{ entity: "issue", stream: ISSUE }],
      },
      now(),
    ),
  );

  await uploadAttachment(
    {
      dispatch: (streamId, event) => dispatch(gateway, streamId, event),
      read: async (streamId) => (await streams.read(streamId)) as readonly Event[],
      now,
    },
    {
      entityRef: {
        org: "maple",
        repo: "reading-room",
        entityType: "pr",
        entityId: "negotiation",
      },
      attachmentId: "session-log",
      kind: "event-log",
      name: "negotiation.events.jsonl",
      mediaType: "application/x-ndjson",
      bytes: new TextEncoder().encode("E5-T12 negotiation evidence\n"),
    },
  );
  await dispatch(
    gateway,
    PR,
    action(
      "pr.review-comment",
      { v: 1, author: "reviewer", body: "The evidence attachment is sealed" },
      now(),
    ),
  );
  await dispatch(gateway, PR, action("pr.approved", { v: 1, reviewer: "reviewer" }, now()));
  await dispatch(gateway, PR, action("pr.merge", { v: 1 }, now()));

  const prRecords = (await streams.read(PR)) as readonly (Event & { readonly offset: string })[];
  const issueRecords = (await streams.read(ISSUE)) as readonly (Event & {
    readonly offset: string;
  })[];
  if (prRecords.some(({ type }) => type === "pr.merge")) {
    throw new Error("merge command leaked into the durable PR history");
  }
  const merged = prRecords.find(({ type }) => type === "pr.merged");
  if (
    merged === undefined ||
    !issueRecords.some(({ type, payload }) => {
      const value = payload as {
        readonly to?: unknown;
        readonly via?: { readonly prStream?: unknown };
      };
      return type === "issue.state-changed" && value.to === "done" && value.via?.prStream === PR;
    })
  ) {
    throw new Error("live merge did not durably merge the PR and close the issue");
  }

  const captured = await captureSession({ server: baseUrl, root: PR, out });
  if (captured.manifest.streams.length !== 7) {
    throw new Error(`expected seven closure members, got ${captured.manifest.streams.length}`);
  }
  process.stdout.write(
    `LIVE-DISPATCH pr-merged=${merged.offset} issue-done=true command-persisted=false OK\n` +
      `LIVE-SESSION streams=${captured.manifest.streams.length} composite=${captured.replay.digest} out=${captured.directory} OK\n`,
  );
} finally {
  await server.stop();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
}
