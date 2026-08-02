import { describe, expect, it } from "vitest";
import {
  FILE_VIEW_MAX_BYTES,
  fileContentInitialState,
  fileContentReducer,
  fileContentReducerDefinition,
} from "./file-content.js";
import { digestBytes } from "@eforest/streamfs";

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function content(bytes: Uint8Array): {
  readonly contentBase64: string;
  readonly contentSha256: string;
  readonly size: number;
} {
  return {
    contentBase64: base64(bytes),
    contentSha256: digestBytes(bytes),
    size: bytes.byteLength,
  };
}

function event(type: string, payload: Record<string, unknown>, ts = 1) {
  return { type, payload, ts } as const;
}

function patch(
  path: string,
  base: Uint8Array,
  ops: readonly (readonly ["=" | "-", number] | readonly ["+", string])[],
  result: Uint8Array,
) {
  return event("fs.file.patch", {
    v: 2,
    path,
    base: "BASE_NONE",
    baseDigest: digestBytes(base),
    ops,
    resultDigest: digestBytes(result),
  });
}

function loadedFile(path = "docs/readme.md", stream = "content-a") {
  const bytes = encoder.encode("hello world\n");
  let state = fileContentReducer(
    fileContentInitialState,
    event("file.view.target", { v: 1, path }),
  );
  state = fileContentReducer(
    state,
    event("fs.file.create", { v: 2, path, contentStreamId: stream }),
  );
  state = fileContentReducer(
    state,
    event("fs.file.write", {
      v: 2,
      path,
      base: "BASE_NONE",
      ...content(bytes),
    }),
  );
  return { state, bytes };
}

describe("file-content reducer", () => {
  it("replays one full generation and a canonical text patch", () => {
    const { state, bytes } = loadedFile();
    const result = encoder.encode("hello durable streams\n");
    const next = fileContentReducer(
      state,
      patch(
        "docs/readme.md",
        bytes,
        [
          ["=", 6],
          ["+", "durable streams"],
          ["-", 5],
          ["=", 1],
        ],
        result,
      ),
    );

    expect(next.status).toBe("text");
    expect(next.text).toBe("hello durable streams\n");
    expect(next.bytes).toEqual(result);
    expect(next.contentDigest).toBe(digestBytes(result));
    expect(next.size).toBe(result.byteLength);
    expect(next.identity).toBe("content-a");
    expect(fileContentReducerDefinition.digest(next)).toBe(digestBytes(result));
  });

  it.each([
    [
      "wrong base",
      patch(
        "docs/readme.md",
        encoder.encode("hello world!"),
        [["=", 12]],
        encoder.encode("hello world!"),
      ),
      "file/patch-base-mismatch",
    ],
    [
      "wrong result",
      {
        ...patch(
          "docs/readme.md",
          encoder.encode("hello world\n"),
          [["=", 12]],
          encoder.encode("hello world\n"),
        ),
        payload: {
          ...patch(
            "docs/readme.md",
            encoder.encode("hello world\n"),
            [["=", 12]],
            encoder.encode("hello world\n"),
          ).payload,
          resultDigest: "0".repeat(64),
        },
      },
      "file/patch-result-mismatch",
    ],
    [
      "truncated ops",
      {
        ...patch(
          "docs/readme.md",
          encoder.encode("hello world\n"),
          [["=", 5]],
          encoder.encode("hello"),
        ),
        payload: {
          ...patch(
            "docs/readme.md",
            encoder.encode("hello world\n"),
            [["=", 5]],
            encoder.encode("hello"),
          ).payload,
          ops: [["=", 5]],
        },
      },
      "file/patch-malformed",
    ],
    [
      "reordered patch",
      patch(
        "docs/readme.md",
        encoder.encode("hello world?"),
        [["=", 12]],
        encoder.encode("hello world?"),
      ),
      "file/patch-base-mismatch",
    ],
  ] as const)("refuses %s without changing the rendered bytes", (_name, invalid, code) => {
    const { state, bytes } = loadedFile();
    expect(() => fileContentReducer(state, invalid)).toThrowError(
      expect.objectContaining({ code }),
    );
    expect(state.text).toBe("hello world\n");
    expect(state.bytes).toEqual(bytes);
    expect(state.contentDigest).toBe(digestBytes(bytes));
  });

  it("preserves binary bytes and refuses to coerce them to text", () => {
    const path = "assets/logo.bin";
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    let state = fileContentReducer(
      fileContentReducer(fileContentInitialState, event("file.view.target", { v: 1, path })),
      event("fs.file.create", { v: 2, path, contentStreamId: "content-bin" }),
    );
    state = fileContentReducer(
      state,
      event("fs.file.write", { v: 2, path, base: "BASE_NONE", ...content(bytes) }),
    );

    expect(state.status).toBe("binary");
    expect(state.text).toBeNull();
    expect(state.bytes).toEqual(bytes);
    expect(() =>
      fileContentReducer(state, patch(path, bytes, [["=", bytes.byteLength]], bytes)),
    ).toThrowError(expect.objectContaining({ code: "file/patch-base-unavailable" }));
  });

  it("marks oversized files without retaining browser-rendered bytes", () => {
    const path = "artifacts/large.txt";
    const bytes = new Uint8Array(FILE_VIEW_MAX_BYTES + 1).fill(65);
    let state = fileContentReducer(
      fileContentReducer(fileContentInitialState, event("file.view.target", { v: 1, path })),
      event("fs.file.create", { v: 2, path, contentStreamId: "content-large" }),
    );
    state = fileContentReducer(
      state,
      event("fs.file.write", { v: 2, path, base: "BASE_NONE", ...content(bytes) }),
    );

    expect(state.status).toBe("oversize");
    expect(state.text).toBeNull();
    expect(state.bytes).toBeNull();
    expect(state.size).toBe(FILE_VIEW_MAX_BYTES + 1);
    expect(state.contentDigest).toBe(digestBytes(bytes));
  });

  it("keeps identity through rename, tombstones deletes, and follows a recreated path", () => {
    const { state } = loadedFile();
    const renamed = fileContentReducer(
      state,
      event("fs.rename", { v: 2, from: "docs/readme.md", to: "archive/readme.md" }),
    );
    expect(renamed.identity).toBe("content-a");
    expect(renamed.currentPath).toBe("archive/readme.md");
    expect(renamed.known["archive/readme.md"]?.contentStreamId).toBe("content-a");

    const deleted = fileContentReducer(
      renamed,
      event("fs.file.delete", { v: 2, path: "archive/readme.md" }),
    );
    expect(deleted.status).toBe("deleted");
    expect(deleted.currentPath).toBeNull();
    expect(deleted.bytes).toBeNull();

    const recreatedBytes = encoder.encode("recreated\n");
    const recreated = fileContentReducer(
      fileContentReducer(
        deleted,
        event("fs.file.create", {
          v: 2,
          path: "docs/readme.md",
          contentStreamId: "content-b",
        }),
      ),
      event("fs.file.write", {
        v: 2,
        path: "docs/readme.md",
        base: "BASE_NONE",
        ...content(recreatedBytes),
      }),
    );
    expect(recreated.identity).toBe("content-b");
    expect(recreated.currentPath).toBe("docs/readme.md");
    expect(recreated.text).toBe("recreated\n");
    expect(recreated.contentDigest).toBe(digestBytes(recreatedBytes));
  });
});
