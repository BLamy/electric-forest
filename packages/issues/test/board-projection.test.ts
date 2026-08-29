import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  BOARD_REDUCER,
  boardDigest,
  deriveBoard,
  isIssueBoardReplacementEvent,
  isRepoIssueBoardStreamId,
  issueBoardInitialState,
  issueBoardReducerDefinition,
  issueBoardReplacementEvent,
  repoIssueBoardStreamId,
} from "../src/index.js";

describe("durable issue-board projection contract", () => {
  it("binds the named stream helper to the fixed replacement reducer", () => {
    const streamId = repoIssueBoardStreamId("maple", "reading-room");
    expect(streamId).toBe("issue-board:maple/reading-room");
    expect(isRepoIssueBoardStreamId(streamId)).toBe(true);
    expect(isRepoIssueBoardStreamId("issue-board:Maple/reading-room")).toBe(false);
    expect(issueBoardReducerDefinition).toMatchObject({ id: BOARD_REDUCER, version: 1 });
    expect(issueBoardReducerDefinition.matchesStream(streamId)).toBe(true);
    expect(issueBoardReducerDefinition.initialState).toEqual(deriveBoard([], []));
    expect(issueBoardInitialState).toEqual(deriveBoard([], []));
  });

  it("validates one exact snapshot event and replaces the complete board state", () => {
    const board = deriveBoard([], []);
    const provenance = {
      inputs: [
        { streamId: "repo-issues:maple/reading-room", offset: offsetForOrdinal(0) },
        { streamId: "repo-labels:maple/reading-room", offset: OFFSET_BEFORE_FIRST },
      ],
    } as const;
    const replacement = issueBoardReplacementEvent(board, provenance, 7);
    expect(isIssueBoardReplacementEvent(replacement)).toBe(true);
    const reduced = issueBoardReducerDefinition.reduce(issueBoardInitialState, replacement);
    expect(reduced).toBe(board);
    expect(issueBoardReducerDefinition.digest(reduced)).toBe(boardDigest(board));

    expect(
      isIssueBoardReplacementEvent({
        ...replacement,
        payload: {
          ...replacement.payload,
          board: {
            ...board,
            columns: { ...board.columns, open: { count: 1, issues: [] } },
          },
        },
      }),
    ).toBe(false);
  });
});
