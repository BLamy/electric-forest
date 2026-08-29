import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { fsInitialState, fsReducer, treeDigest } from "@eforest/streamfs";
import { describe, expect, it } from "vitest";
import {
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
});
