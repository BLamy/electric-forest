import { describe, expect, it, vi } from "vitest";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import {
  DispatchRefusalError,
  dispatchConfirmed,
  dispatchRefused,
  dispatchStarted,
  initialDispatchLifecycle,
  postDispatch,
  reconcileDispatches,
} from "./useDispatch.js";

const action = {
  type: "label.created",
  payload: { v: 1, labelId: "bug", name: "bug", color: "#d1242f" },
  ts: 1,
};

describe("useDispatch v1 core", () => {
  it("posts exactly one same-origin dispatch and returns the confirmed offset", async () => {
    const offset = offsetForOrdinal(3);
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, offset }, { status: 202 }),
    );

    await expect(
      postDispatch("repo-labels:maple/reading-room", action, { fetch: fetcher }),
    ).resolves.toEqual({ offset });
    expect(fetcher).toHaveBeenCalledOnce();
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/dispatch");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(init?.headers).get("x-eforest-dispatch-receipt")).toBe("offset");
    expect(JSON.parse(String(init?.body))).toEqual({
      streamId: "repo-labels:maple/reading-room",
      event: action,
    });
  });

  it("carries a canonical full-write content generation in the same dispatch request", async () => {
    const offset = offsetForOrdinal(4);
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, offset }, { status: 202 }),
    );
    const write = {
      type: "fs.file.write",
      payload: {
        v: 2,
        path: "home.md",
        base: offsetForOrdinal(3),
        contentSha256: "a".repeat(64),
        size: 5,
      },
      ts: 2,
    };
    const contentEvent = {
      type: "fs.file.content",
      payload: {
        v: 2,
        contentStreamId: "fs:maple/reading-room:wiki:file:home",
        contentBase64: "aGVsbG8=",
      },
      ts: 2,
    };

    await expect(
      postDispatch("fs:maple/reading-room:wiki:meta", write, {
        fetch: fetcher,
        contentEvent,
      }),
    ).resolves.toEqual({ offset });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      streamId: "fs:maple/reading-room:wiki:meta",
      event: write,
      contentEvent,
    });
  });

  it("rejects with the server refusal code, message, and original action", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            class: "validator-rejected",
            reason: "label/duplicate-name",
            message: "label/duplicate-name",
          },
        },
        { status: 409 },
      ),
    );

    const refusal = await postDispatch("repo-labels:maple/reading-room", action, {
      fetch: fetcher,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DispatchRefusalError);
    expect(refusal).toMatchObject({
      code: "label/duplicate-name",
      message: "label/duplicate-name",
      refusedAction: action,
    });
  });

  it("rejects malformed confirmations instead of fabricating an offset", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }, { status: 202 }));
    await expect(
      postDispatch("repo-labels:maple/reading-room", action, { fetch: fetcher }),
    ).rejects.toThrow("omitted a valid append offset");
  });

  it("keeps confirmations pending until replay and handles out-of-order promises", () => {
    const offset0 = offsetForOrdinal(0);
    const offset1 = offsetForOrdinal(1);
    let lifecycle = dispatchStarted(initialDispatchLifecycle);
    lifecycle = dispatchStarted(lifecycle);
    lifecycle = dispatchConfirmed(lifecycle, offset1, OFFSET_BEFORE_FIRST);
    lifecycle = dispatchConfirmed(lifecycle, offset0, OFFSET_BEFORE_FIRST);
    expect(lifecycle).toMatchObject({
      confirmedOffset: offset1,
      counters: { sent: 2, confirmed: 2, reconciled: 0, refused: 0 },
    });
    expect(lifecycle.pendingOffsets).toEqual([offset1, offset0]);

    lifecycle = reconcileDispatches(lifecycle, offset0);
    expect(lifecycle.counters.reconciled).toBe(1);
    expect(lifecycle.pendingOffsets).toEqual([offset1]);
    lifecycle = reconcileDispatches(lifecycle, offset1);
    expect(lifecycle.counters.reconciled).toBe(2);
    expect(lifecycle.pendingOffsets).toEqual([]);
  });

  it("counts transport failures as refused without confirming or reconciling", () => {
    const lifecycle = dispatchRefused(dispatchStarted(initialDispatchLifecycle));
    expect(lifecycle.counters).toEqual({ sent: 1, confirmed: 0, reconciled: 0, refused: 1 });
  });
});
