import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  chooseWriteEvent,
  fileContentEvent,
  fileCreateEvent,
  fileDeleteEvent,
  fileRenameEvent,
} from "@eforest/streamfs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWikiBranchThroughBrowser } from "./provisionWiki.js";
import {
  chooseWikiSaveEvent,
  chooseWikiSaveRequest,
  createWikiPageEvent,
  deleteWikiPageEvent,
  renameWikiPageEvent,
} from "./useWiki.js";

const encoder = new TextEncoder();

afterEach(() => vi.restoreAllMocks());

describe("wiki canonical StreamFS writers", () => {
  it("delegates create, delete, and rename envelopes to the canonical constructors", () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(createWikiPageEvent("maple", "reading-room", "home")).toEqual(
      fileCreateEvent(
        "home.md",
        "fs:maple/reading-room:wiki:file:00000000-0000-4000-8000-000000000001",
        42,
      ),
    );
    expect(deleteWikiPageEvent("home")).toEqual(fileDeleteEvent("home.md", 42));
    expect(renameWikiPageEvent("home", "start")).toEqual(
      fileRenameEvent("home.md", "start.md", 42),
    );
  });

  it("emits the canonical patch when patch bytes win", () => {
    vi.spyOn(Date, "now").mockReturnValue(43);
    const baseText = `${"stable line\n".repeat(256)}tail\n`;
    const targetText = `${"stable line\n".repeat(256)}changed tail\n`;
    const baseOffset = offsetForOrdinal(7);
    const canonical = chooseWriteEvent(
      encoder.encode(baseText),
      encoder.encode(targetText),
      "home.md",
      baseOffset,
    );
    expect(canonical.type).toBe("fs.file.patch");
    const actual = chooseWikiSaveEvent(baseText, targetText, "home.md", baseOffset);
    expect(actual.type, "canonical-patch-chooser").toBe("fs.file.patch");
    expect(actual).toEqual({
      ...canonical,
      ts: 43,
    });
  });

  it("retains the caller base revision in a canonical full-write fallback", () => {
    vi.spyOn(Date, "now").mockReturnValue(44);
    const baseText = `${"stable line\n".repeat(256)}tail\n`;
    const targetText = "replacement\n";
    const baseOffset = offsetForOrdinal(8);
    const canonical = chooseWriteEvent(
      encoder.encode(baseText),
      encoder.encode(targetText),
      "home.md",
      baseOffset,
    );
    expect(canonical.type).toBe("fs.file.write");
    const actual = chooseWikiSaveEvent(baseText, targetText, "home.md", baseOffset);
    expect(actual.payload.base, "caller-base-revision").toBe(baseOffset);
    expect(actual).toEqual({
      ...canonical,
      ts: 44,
    });
  });

  it("pairs full-write metadata with exact canonical content bytes in one request", () => {
    vi.spyOn(Date, "now").mockReturnValue(45);
    const baseText = `${"stable line\n".repeat(256)}tail\n`;
    const targetText = "exact replacement bytes\n";
    const baseOffset = offsetForOrdinal(9);
    const contentStreamId = "fs:maple/reading-room:wiki:file:home";
    const request = chooseWikiSaveRequest(
      baseText,
      targetText,
      "home.md",
      contentStreamId,
      baseOffset,
    );

    expect(request.event.type).toBe("fs.file.write");
    expect(request.contentEvent).toEqual(
      fileContentEvent(contentStreamId, encoder.encode(targetText), 45),
    );
    expect(request.event.payload.base).toBe(baseOffset);
  });
});

describe("production wiki provisioning binding", () => {
  it("inspects and provisions through the existing session read and dispatch doors", async () => {
    const offset = offsetForOrdinal(0);
    const calls: Array<{ readonly path: string; readonly init: RequestInit | undefined }> = [];
    let exists = false;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === "/api/dispatch") {
        const body = JSON.parse(String(init?.body)) as {
          readonly streamId: string;
          readonly event: { readonly type: string; readonly payload: unknown };
        };
        expect(body.streamId).toBe("fs:maple/reading-room:wiki:meta");
        expect(body.event).toMatchObject({
          type: "fs.branch.genesis",
          payload: { v: 1, branch: "wiki" },
        });
        exists = true;
        return Response.json({ ok: true, offset }, { status: 202 });
      }
      expect(path).toBe("/api/repos/maple/reading-room/wiki/events");
      return Response.json({
        events: exists
          ? [
              {
                offset,
                type: "fs.branch.genesis",
                payload: { v: 1, branch: "wiki", actor: "auth0|browser" },
                ts: 42,
              },
            ]
          : [],
      });
    });

    await expect(ensureWikiBranchThroughBrowser("maple", "reading-room", fetcher)).resolves.toEqual(
      { streamId: "fs:maple/reading-room:wiki:meta", created: true },
    );
    expect(calls.map((call) => [call.path, call.init?.method ?? "GET"])).toEqual([
      ["/api/repos/maple/reading-room/wiki/events", "GET"],
      ["/api/dispatch", "POST"],
      ["/api/repos/maple/reading-room/wiki/events", "GET"],
    ]);
    expect(calls.every((call) => call.init?.credentials === "same-origin")).toBe(true);
  });
});
