import { emptyView } from "@eforest/identity";
import { type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import { expect, it } from "vitest";
import {
  createPlatformProductionRuntime,
  OfficialStreamAdapter,
  type AuthzInput,
  type AuthorizationVerifier,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const ACTOR = "alice";
const PR_STREAM = "pr:maple/reading-room/42";
const ISSUE_STREAM = "issue:maple/reading-room/7";
const SECOND_ISSUE_STREAM = "issue:maple/reading-room/8";
const TARGET_STREAM = "fs:maple/reading-room:main:meta";
const SOURCE_STREAM = "fs:maple/reading-room:feature:meta";
const at = offsetForOrdinal;

function event(type: string, payload: Record<string, unknown>): Event {
  return { type, payload, ts: NOW };
}

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

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: ACTOR }),
  authorizationContext: async () => ({
    principal: { kind: "identified", sub: ACTOR },
    identity: emptyView(),
    identityOffset: "-1",
  }),
};

function openedPr(): Event {
  return event("pr.opened", {
    v: 1,
    sourceBranch: SOURCE_STREAM,
    targetBranch: TARGET_STREAM,
    forkOffset: at(0),
    title: "Recover production open",
    body: "Operation recovery must propagate the issue backlink",
    author: ACTOR,
    closes: [
      { entity: "issue", stream: ISSUE_STREAM },
      { entity: "issue", stream: SECOND_ISSUE_STREAM },
    ],
  });
}

it("production operation recovery: revalidates and propagates before completion", async () => {
  const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const officialUrl = await official.start();
  let runtime: Awaited<ReturnType<typeof createPlatformProductionRuntime>> | undefined;
  try {
    runtime = await createPlatformProductionRuntime(
      {
        EF_OIDC_ISSUER: "https://issuer.example.test/",
        EF_OIDC_CLIENT_ID: "eforest-e5-t07",
        EF_SESSION_SECRET: "e5-t07-production-recovery-session-secret",
        EF_SESSION_TTL: "60",
        EFOREST_SERVER_URL: officialUrl,
      },
      {
        now: () => NOW,
        gatewayVerifier: verifier,
        gatewayDecideAuthorization: allow,
      },
    );
    const streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
    await streams.create(TARGET_STREAM);
    await streams.append(TARGET_STREAM, event("fs.branch.genesis", { v: 1, branch: "main" }), {
      sequence: at(0),
      applicationOffset: at(0),
    });
    await streams.create(SOURCE_STREAM);
    await streams.append(
      SOURCE_STREAM,
      event("fs.branch.fork", {
        v: 1,
        parentStreamId: TARGET_STREAM,
        forkOffset: at(0),
      }),
      { sequence: at(0), applicationOffset: at(0) },
    );
    await streams.create(PR_STREAM);

    for (const streamId of [ISSUE_STREAM, SECOND_ISSUE_STREAM]) {
      const issueOpened = await runtime.gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({
            streamId,
            event: event("issue.opened", { v: 1, title: streamId, body: "Body" }),
          }),
        }),
      );
      expect(issueOpened.status, await issueOpened.text()).toBe(202);
    }

    const grantId = "e5-t07-production-recovery-grant";
    const operationId = "e5-t07-production-recovery-operation";
    await runtime.identity.ensureUser(ACTOR, "alice@example.test");
    await runtime.identity.issueCliGrant({
      grantId,
      sub: ACTOR,
      tokenKind: "device",
      tokenHash: "a".repeat(64),
      scopes: ["repo:write"],
    });
    const opened = openedPr();
    await runtime.identity.beginGrantOperation(grantId, operationId, {
      streamId: PR_STREAM,
      event: {
        ...opened,
        payload: { ...(opened.payload as Record<string, unknown>), actor: ACTOR },
      },
    });

    await runtime.identity.revokeCliGrant(grantId);

    const prRecords = (await streams.readResolved(PR_STREAM)) as readonly (Event & {
      readonly offset: Offset;
    })[];
    const issueRecords = (await streams.readResolved(ISSUE_STREAM)) as readonly (Event & {
      readonly offset: Offset;
    })[];
    const secondIssueRecords = (await streams.readResolved(
      SECOND_ISSUE_STREAM,
    )) as readonly (Event & { readonly offset: Offset })[];
    expect(prRecords.map(({ type }) => type)).toEqual(["pr.opened"]);
    expect(prRecords[0]?.payload).toMatchObject({
      actor: ACTOR,
      writer: { v: 1, sub: ACTOR, seq: 1, op: operationId },
    });
    expect(
      issueRecords.map(({ type }) => type),
      "E5_T07_PRODUCTION_RECOVERY_BOUNDARY",
    ).toEqual(["issue.opened", "issue.linked"]);
    expect(secondIssueRecords.map(({ type }) => type)).toEqual(["issue.opened", "issue.linked"]);
    expect(issueRecords[1]?.payload).toMatchObject({
      by: { entity: "pr", stream: PR_STREAM },
      atOffset: prRecords[0]?.offset,
    });
    expect(secondIssueRecords[1]?.payload).toMatchObject({
      by: { entity: "pr", stream: PR_STREAM },
      atOffset: prRecords[0]?.offset,
    });
    const identity = await runtime.identity.snapshot();
    expect(identity.view.grantOperations?.[operationId]?.status).toBe("completed");
    expect(identity.view.grants[grantId]?.status).toBe("revoked");
  } finally {
    if (runtime !== undefined) {
      runtime.gateway.terminate();
      await runtime.registry.stop();
    }
    await official.stop();
  }
});
