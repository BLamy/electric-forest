import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { fsInitialState, fsReducer, treeDigest } from "@eforest/streamfs";
import { describe, expect, it } from "vitest";
import {
  repositoryBranchesInitialState,
  repositoryBranchesReducerDefinition,
  repositoryNamespaceReducerDefinition,
  repositoryStatusReducerDefinition,
  reducerForStream,
  replayWithReducer,
  requireReducer,
  streamFsReducerDefinition,
} from "./index.js";

const records = [
  {
    type: "fs.dir.create",
    payload: { v: 2, path: "docs" },
    ts: 1,
    offset: offsetForOrdinal(0),
  },
  {
    type: "fs.file.create",
    payload: { v: 2, path: "docs/readme.md", contentStreamId: "content-readme" },
    ts: 2,
    offset: offsetForOrdinal(1),
  },
] as const;

describe("shared reducer registry", () => {
  it("binds the StreamFS reducer once for platform, CLI, and browser consumers", () => {
    const definition = requireReducer("streamfs", "fs:maple/reading-room:main:meta");
    expect(definition).toBe(streamFsReducerDefinition);
    expect(definition.reduce).toBe(streamFsReducerDefinition.reduce);
    expect(reducerForStream("fs:maple/reading-room:main:meta")).toBe(definition);
    expect(reducerForStream("identity:control")).toBeUndefined();
  });

  it("replays to the exact independent StreamFS digest", () => {
    const shared = replayWithReducer(streamFsReducerDefinition, records);
    const independentState = records.reduce(fsReducer, fsInitialState);
    expect(shared.state).toEqual(independentState);
    expect(shared.digest).toBe(treeDigest(independentState));
  });

  it("removes platform writer metadata before the product reducer", () => {
    const stamped = records.map((record, index) => ({
      ...record,
      payload: {
        ...record.payload,
        actor: "alice",
        writer: { v: 1, sub: "alice", seq: index + 1 },
      },
    }));
    expect(replayWithReducer(streamFsReducerDefinition, stamped).digest).toBe(
      replayWithReducer(streamFsReducerDefinition, records).digest,
    );
  });

  it("refuses reducer and stream mismatches", () => {
    expect(() => requireReducer("streamfs", "identity:control")).toThrow(
      "reducer streamfs does not match stream identity:control",
    );
    expect(() => requireReducer("unknown", "fs:maple/reading-room:main:meta")).toThrow(
      "reducer unknown does not match",
    );
  });

  it("binds all three repository-home projections to distinct virtual streams", () => {
    expect(requireReducer("repo-namespace", "repo-home:maple/reading-room:namespace")).toBe(
      repositoryNamespaceReducerDefinition,
    );
    expect(requireReducer("repo-branches", "repo-home:maple/reading-room:branches")).toBe(
      repositoryBranchesReducerDefinition,
    );
    expect(requireReducer("repo-status", "repo-home:maple/reading-room:status")).toBe(
      repositoryStatusReducerDefinition,
    );
    expect(() => requireReducer("repo-status", "repo-home:maple/reading-room:branches")).toThrow(
      "does not match",
    );
  });

  it("reduces repository namespace metadata and its live visibility transition", () => {
    const loadedEvent = {
      type: "repo.namespace.loaded",
      payload: {
        v: 1,
        org: "maple",
        repo: "reading-room",
        project: "canopy",
        projectOwner: "ada",
        repoOwner: "ada",
        visibility: "public",
      },
      ts: 1,
    } as const;
    const loaded = repositoryNamespaceReducerDefinition.reduce(
      repositoryNamespaceReducerDefinition.initialState,
      loadedEvent,
    );
    expect(loaded).toEqual({
      metadata: {
        org: "maple",
        repo: "reading-room",
        project: "canopy",
        projectOwner: "ada",
        repoOwner: "ada",
        visibility: "public",
      },
    });
    expect(
      repositoryNamespaceReducerDefinition.reduce(loaded, {
        type: "repo.namespace.visibility-set",
        payload: { v: 1, visibility: "private" },
        ts: 2,
      }),
    ).toEqual({
      metadata: {
        org: "maple",
        repo: "reading-room",
        project: "canopy",
        projectOwner: "ada",
        repoOwner: "ada",
        visibility: "private",
      },
    });
    expect(() => repositoryNamespaceReducerDefinition.reduce(loaded, loadedEvent)).toThrow(
      "malformed or duplicate metadata",
    );
  });

  it("reduces native branch ancestry and refuses a cyclic catalog entry", () => {
    const main = {
      type: "repo.branch.created",
      payload: {
        v: 1,
        name: "main",
        streamId: "fs:maple/reading-room:main:meta",
        parentStreamId: null,
        forkOffset: "-1",
      },
      ts: 1,
    } as const;
    const feature = {
      type: "repo.branch.created",
      payload: {
        v: 1,
        name: "feature",
        streamId: "fs:maple/reading-room:feature:meta",
        parentStreamId: "fs:maple/reading-room:main:meta",
        forkOffset: offsetForOrdinal(4),
      },
      ts: 2,
    } as const;
    const state = repositoryBranchesReducerDefinition.reduce(
      repositoryBranchesReducerDefinition.reduce(repositoryBranchesInitialState, main),
      feature,
    );
    expect(state).toEqual({
      branches: {
        main: {
          name: "main",
          streamId: "fs:maple/reading-room:main:meta",
          parentStreamId: null,
          forkOffset: "-1",
        },
        feature: {
          name: "feature",
          streamId: "fs:maple/reading-room:feature:meta",
          parentStreamId: "fs:maple/reading-room:main:meta",
          forkOffset: offsetForOrdinal(4),
        },
      },
    });
    const cyclic = {
      ...feature,
      payload: {
        ...feature.payload,
        name: "cycle",
        streamId: "fs:maple/reading-room:cycle:meta",
        parentStreamId: "fs:maple/reading-room:cycle:meta",
      },
    };
    expect(() =>
      repositoryBranchesReducerDefinition.reduce(repositoryBranchesInitialState, cyclic),
    ).toThrow("cyclic branch ancestry");
    expect(() =>
      repositoryBranchesReducerDefinition.reduce(repositoryBranchesInitialState, {
        ...main,
        payload: {
          ...main.payload,
          name: "meta",
          streamId: "fs:maple/reading-room:meta:meta",
        },
      }),
    ).toThrow("malformed branch event");
  });

  it("refuses every project status outside the frozen four-value state machine", () => {
    const accepted = ["building", "complete", "paused", "invalid_loop"] as const;
    for (const status of accepted) {
      expect(
        repositoryStatusReducerDefinition.reduce(repositoryStatusReducerDefinition.initialState, {
          type: "project.status.set",
          payload: { v: 1, status },
          ts: 1,
        }),
      ).toEqual({ status });
    }
    expect(() =>
      repositoryStatusReducerDefinition.reduce(repositoryStatusReducerDefinition.initialState, {
        type: "project.status.set",
        payload: { v: 1, status: "done" },
        ts: 1,
      }),
    ).toThrow("malformed status transition");
  });
});
