import { describe, expect, it } from "vitest";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { BASE_NONE } from "./fencing.js";
import { chooseWriteEvent } from "./patch/choose.js";
import {
  chooseFileWriteEvent,
  fileContentEvent,
  fileCreateEvent,
  fileDeleteEvent,
  filePatchEvent,
  fileRenameEvent,
  fileWriteEvent,
} from "./writer-events.js";

const encoder = new TextEncoder();

describe("canonical StreamFS writer event constructors", () => {
  it("constructs the frozen create, delete, rename, and explicit patch envelopes", () => {
    expect(fileCreateEvent("home.md", "fs:acme/wiki:wiki:file:home", 10)).toEqual({
      type: "fs.file.create",
      payload: {
        v: 2,
        path: "home.md",
        contentStreamId: "fs:acme/wiki:wiki:file:home",
      },
      ts: 10,
    });
    expect(fileContentEvent("fs:acme/wiki:wiki:file:home", encoder.encode("# Home\n"), 10)).toEqual(
      {
        type: "fs.file.content",
        payload: {
          v: 2,
          contentStreamId: "fs:acme/wiki:wiki:file:home",
          contentBase64: "IyBIb21lCg==",
        },
        ts: 10,
      },
    );
    expect(fileDeleteEvent("home.md", 11)).toEqual({
      type: "fs.file.delete",
      payload: { v: 2, path: "home.md" },
      ts: 11,
    });
    expect(fileRenameEvent("home.md", "start.md", 12)).toEqual({
      type: "fs.rename",
      payload: { v: 2, from: "home.md", to: "start.md" },
      ts: 12,
    });
    expect(
      filePatchEvent(new Uint8Array(), encoder.encode("# Home\n"), "home.md", BASE_NONE, 13),
    ).toMatchObject({
      type: "fs.file.patch",
      payload: { v: 2, path: "home.md", base: BASE_NONE, ops: [["+", "# Home\n"]] },
      ts: 13,
    });
    expect(fileWriteEvent(encoder.encode("replacement\n"), "home.md", BASE_NONE, 14)).toEqual({
      type: "fs.file.write",
      payload: {
        v: 2,
        path: "home.md",
        base: BASE_NONE,
        contentSha256: "1d054714357ce5ee01723ed91fcaa69206e221faaf9c1fad64f73be2e5d051da",
        size: 12,
      },
      ts: 14,
    });
  });

  it("preserves both canonical chooser branches byte-for-byte before timestamping", () => {
    const base = encoder.encode(`${"stable line\n".repeat(256)}tail\n`);
    const patchTarget = encoder.encode(`${"stable line\n".repeat(256)}changed tail\n`);
    const fullTarget = encoder.encode("replacement\n");

    for (const [target, expectedType] of [
      [patchTarget, "fs.file.patch"],
      [fullTarget, "fs.file.write"],
    ] as const) {
      const baseOffset = offsetForOrdinal(7);
      const choice = chooseWriteEvent(base, target, "home.md", baseOffset);
      expect(choice.type).toBe(expectedType);
      expect(chooseFileWriteEvent(base, target, "home.md", baseOffset, 14)).toEqual({
        ...choice,
        ts: 14,
      });
    }
  });
});
