import {
  ATTACHMENT_EVENT_VERSION,
  attachmentInitialStateForStream,
  attachmentReducer,
  contentInitialStateForStream,
  contentReducer,
  encodeCanonicalBase64,
  evidenceContentStreamId,
  evidenceStreamId,
} from "@eforest/evidence";
import { sha256Hex, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { event, startPrHttpFixture, type PrHttpFixture } from "../../pr/test/helpers.js";

interface ProjectionBody {
  readonly ok: true;
  readonly events: readonly Event[];
  readonly checkpoint: Offset;
  readonly reducer: { readonly id: string; readonly version: number };
}

describe("evidence dispatch and application projection integration", () => {
  let fixture: PrHttpFixture;

  beforeAll(async () => {
    fixture = await startPrHttpFixture();
    const opened = await fixture.dispatch(
      "issue:maple/reading-room/17",
      event("issue.opened", { v: 1, title: "Evidence owner", body: "Attach proof" }),
    );
    expect(opened.status).toBe(202);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("creates, validates, attaches, and projects sealed bytes through the existing repo route", async () => {
    const bytes = new TextEncoder().encode("canonical evidence\n");
    const digest = sha256Hex(bytes);
    const contentStream = evidenceContentStreamId("maple", "reading-room", "run-17");
    const attachmentStream = evidenceStreamId({
      org: "maple",
      repo: "reading-room",
      entityType: "issue",
      entityId: "17",
    });

    expect(
      (
        await fixture.dispatch(
          contentStream,
          event("content.chunk", {
            v: ATTACHMENT_EVENT_VERSION,
            seq: 0,
            bytes: encodeCanonicalBase64(bytes),
          }),
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await fixture.dispatch(
          contentStream,
          event("content.sealed", {
            v: ATTACHMENT_EVENT_VERSION,
            sha256: digest,
            size: bytes.byteLength,
            chunks: 1,
          }),
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await fixture.dispatch(
          attachmentStream,
          event("evidence.attached", {
            v: ATTACHMENT_EVENT_VERSION,
            attachmentId: "run-17",
            kind: "event-log",
            name: "events.jsonl",
            mediaType: "application/x-ndjson",
            size: bytes.byteLength,
            sha256: digest,
            contentStream,
          }),
        )
      ).status,
    ).toBe(202);

    const contentResponse = await fetch(
      `${fixture.baseUrl}/api/repos/maple/reading-room/main/events?stream=evidence-content&attachmentId=run-17&projection=1&reducer=evidence-content`,
      { headers: { authorization: "Bearer test" } },
    );
    expect(contentResponse.status).toBe(200);
    const contentProjection = (await contentResponse.json()) as ProjectionBody;
    expect(contentProjection.reducer).toEqual({ id: "evidence-content", version: 1 });
    const contentState = contentProjection.events.reduce(
      contentReducer,
      contentInitialStateForStream(contentStream),
    );
    expect(contentState).toMatchObject({
      sealed: true,
      size: bytes.byteLength,
      chunks: 1,
      sha256: digest,
    });

    const attachmentResponse = await fetch(
      `${fixture.baseUrl}/api/repos/maple/reading-room/main/events?stream=evidence&entityType=issue&entityId=17&projection=1&reducer=evidence`,
      { headers: { authorization: "Bearer test" } },
    );
    expect(attachmentResponse.status).toBe(200);
    const attachmentProjection = (await attachmentResponse.json()) as ProjectionBody;
    expect(attachmentProjection.reducer).toEqual({ id: "evidence", version: 1 });
    const attachmentState = attachmentProjection.events.reduce(
      attachmentReducer,
      attachmentInitialStateForStream(attachmentStream),
    );
    expect(attachmentState.attachments).toHaveLength(1);
    expect(attachmentState.attachments[0]).toMatchObject({
      attachmentId: "run-17",
      type: "content",
      sha256: digest,
      contentStream,
    });
    expect(stateDigest(attachmentState)).toBe(
      stateDigest(
        (await fixture.streams.read(attachmentStream)).reduce(
          attachmentReducer,
          attachmentInitialStateForStream(attachmentStream),
        ),
      ),
    );
  });

  it("preserves exact refusal taxonomy and leaves accepted logs unchanged", async () => {
    const contentStream = evidenceContentStreamId("maple", "reading-room", "run-17");
    const attachmentStream = evidenceStreamId({
      org: "maple",
      repo: "reading-room",
      entityType: "issue",
      entityId: "17",
    });
    const contentBefore = await fixture.streams.read(contentStream);
    const sealed = await fixture.dispatch(
      contentStream,
      event("content.chunk", {
        v: ATTACHMENT_EVENT_VERSION,
        seq: 1,
        bytes: encodeCanonicalBase64(new Uint8Array([1])),
      }),
    );
    expect(sealed.status).toBe(409);
    expect(JSON.parse(sealed.body)).toEqual({
      error: { class: "validator-rejected", reason: "evidence/sealed-terminal" },
    });
    expect(await fixture.streams.read(contentStream)).toEqual(contentBefore);

    const attachmentBefore = await fixture.streams.read(attachmentStream);
    const wrongFamily = await fixture.dispatch(
      attachmentStream,
      event("content.chunk", {
        v: ATTACHMENT_EVENT_VERSION,
        seq: 0,
        bytes: "",
      }),
    );
    expect(wrongFamily.status).toBe(404);
    expect(JSON.parse(wrongFamily.body)).toEqual({ error: { class: "unknown-action-type" } });
    expect(await fixture.streams.read(attachmentStream)).toEqual(attachmentBefore);

    const unknownEntityType = await fixture.dispatch(
      "evidence:maple/reading-room/wiki/home",
      event("evidence.waived", {
        v: ATTACHMENT_EVENT_VERSION,
        justification: "server-only proof",
      }),
    );
    expect(unknownEntityType.status).toBe(409);
    expect(JSON.parse(unknownEntityType.body)).toEqual({
      error: { class: "validator-rejected", reason: "evidence/unknown-entity-type" },
    });
  });
});
