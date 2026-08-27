import { checkpoint } from "@eforest/client";
import {
  BOARD_REDUCER,
  boardDigest,
  issueStreamId,
  repoIssueBoardStreamId,
  type IssueBoard,
  type IssueBoardProvenance,
  type IssueBoardReplacementPayload,
} from "@eforest/issues";
import { emptyView } from "@eforest/identity";
import { type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { requireReducer, replayWithReducer } from "@eforest/reducers";
import { createDurableStreamTestServer } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  OfficialStreamAdapter,
  PlatformGateway,
  type AuthorizationVerifier,
  type NamespaceDispatcher,
} from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

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
    basis: "repo-owner" as const,
    streamId: "streamId" in input.target ? input.target.streamId : "",
  };
}

function event(type: string, payload: Record<string, unknown>, ts: number): Event {
  return { type, payload, ts };
}

describe("issue and board live-read bridge", () => {
  it("opens a fresh issue through dispatch, projects/follows it, and serves durable board history", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaces: {
        isEventType: async () => false,
      } as unknown as NamespaceDispatcher,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const org = "maple";
    const repo = "reading-room";
    const issueId = "fresh";
    const issueStream = issueStreamId(org, repo, issueId);
    const boardStream = repoIssueBoardStreamId(org, repo);
    const dispatch = (streamId: string, current: Event) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ streamId, event: current }),
        }),
      );
    const issueProjection = (suffix = "") =>
      gateway.handle(
        new Request(
          `https://platform.test/api/repos/${org}/${repo}/main/events?stream=issue&issueId=${issueId}&projection=1&reducer=issue${suffix}`,
          { headers: { authorization: "Bearer test" } },
        ),
      );
    const board = (suffix = "") =>
      gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board${suffix}`, {
          headers: { authorization: "Bearer test" },
        }),
      );

    try {
      expect(await streams.exists(issueStream)).toBe(false);
      const opened = await dispatch(
        issueStream,
        event("issue.opened", { v: 1, title: "Fresh", body: "Created by dispatch" }, 1),
      );
      expect(opened.status).toBe(202);
      expect(await streams.exists(issueStream)).toBe(true);

      const issueBootstrapResponse = await issueProjection();
      expect(issueBootstrapResponse.status).toBe(200);
      const issueBootstrap = (await issueBootstrapResponse.json()) as {
        readonly events: readonly (Event & { readonly offset: Offset })[];
        readonly checkpoint: Offset;
        readonly reducer: { readonly id: string; readonly version: number };
      };
      expect(issueBootstrap).toMatchObject({
        checkpoint: offsetForOrdinal(0),
        reducer: { id: "issue", version: 1 },
      });
      const issueState = replayWithReducer(
        requireReducer("issue", issueStream),
        issueBootstrap.events,
        issueStream,
      ).state;
      expect(issueState).toMatchObject({
        issueId,
        title: "Fresh",
        body: "Created by dispatch",
        state: "open",
      });

      const firstBoardResponse = await board();
      expect(firstBoardResponse.status).toBe(200);
      const firstBoard = (await firstBoardResponse.json()) as {
        readonly board: IssueBoard;
        readonly digest: string;
        readonly provenance: IssueBoardProvenance;
      };
      expect(Object.keys(firstBoard).sort()).toEqual(["board", "digest", "provenance"]);
      expect(firstBoard.board.columns.open.issues).toEqual([issueId]);

      const boardBootstrapResponse = await board(`?projection=1&reducer=${BOARD_REDUCER}`);
      expect(boardBootstrapResponse.status).toBe(200);
      const boardBootstrap = (await boardBootstrapResponse.json()) as {
        readonly events: readonly {
          readonly offset: Offset;
          readonly payload: IssueBoardReplacementPayload;
        }[];
        readonly checkpoint: Offset;
        readonly reducer: { readonly id: string; readonly version: number };
      };
      expect(boardBootstrap).toMatchObject({
        checkpoint: offsetForOrdinal(0),
        reducer: { id: BOARD_REDUCER, version: 1 },
      });
      expect(boardBootstrap.events).toHaveLength(1);
      expect(boardBootstrap.events[0]?.payload.board).toEqual(firstBoard.board);
      expect(boardDigest(boardBootstrap.events[0]!.payload.board)).toBe(firstBoard.digest);

      const historicalResponse = await board(`?at=${encodeURIComponent(offsetForOrdinal(0))}`);
      expect(historicalResponse.status).toBe(200);
      expect(await historicalResponse.json()).toEqual(firstBoard);

      const commented = await dispatch(
        issueStream,
        event("issue.commented", { v: 1, commentId: "c-1", body: "Following" }, 2),
      );
      expect(commented.status).toBe(202);

      const issueFollowResponse = await issueProjection(
        `&live=1&checkpoint=${encodeURIComponent(issueBootstrap.checkpoint)}&waitMs=1000`,
      );
      expect(issueFollowResponse.status).toBe(200);
      const issueFollow = (await issueFollowResponse.json()) as {
        readonly events: readonly { readonly type: string; readonly offset: Offset }[];
        readonly checkpoint: Offset;
      };
      expect(issueFollow).toMatchObject({ checkpoint: offsetForOrdinal(1) });
      expect(issueFollow.events).toEqual([
        expect.objectContaining({ type: "issue.commented", offset: offsetForOrdinal(1) }),
      ]);

      const boardFollowResponse = await board(
        `?projection=1&reducer=${BOARD_REDUCER}&live=1&checkpoint=${encodeURIComponent(boardBootstrap.checkpoint)}&waitMs=1000`,
      );
      expect(boardFollowResponse.status).toBe(200);
      const boardFollow = (await boardFollowResponse.json()) as {
        readonly events: readonly {
          readonly offset: Offset;
          readonly payload: IssueBoardReplacementPayload;
        }[];
        readonly checkpoint: Offset;
      };
      expect(boardFollow).toMatchObject({ checkpoint: offsetForOrdinal(1) });
      expect(boardFollow.events).toHaveLength(1);
      expect(boardFollow.events[0]?.payload.board).toEqual(firstBoard.board);
      expect(boardFollow.events[0]?.payload.provenance).not.toEqual(
        boardBootstrap.events[0]?.payload.provenance,
      );

      expect((await board("?at=bogus")).status).toBe(400);
      expect((await board(`?at=${encodeURIComponent(offsetForOrdinal(9))}`)).status).toBe(404);

      const beforeRefusal = await streams.applicationBootstrap(boardStream);
      expect(beforeRefusal.checkpoint).toEqual(checkpoint(offsetForOrdinal(1)));
      const refusedDerivedWrite = await dispatch(boardStream, {
        type: "issue-board.replaced",
        payload: boardBootstrap.events[0]!.payload,
        ts: 3,
      });
      expect(refusedDerivedWrite.status).toBe(404);
      expect((await streams.applicationBootstrap(boardStream)).checkpoint).toEqual(
        beforeRefusal.checkpoint,
      );

      const repeated = await board(`?projection=1&reducer=${BOARD_REDUCER}`);
      const repeatedBody = (await repeated.json()) as { readonly events: readonly unknown[] };
      expect(repeatedBody.events).toHaveLength(2);
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });
});
