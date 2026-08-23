import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { afterEach, describe, expect, it } from "vitest";
import { PR_REFUSAL_REASONS, type PrRefusalReason } from "../src/index.js";
import {
  event,
  openedPayload,
  prSnapshot,
  startPrHttpFixture,
  type PrHttpFixture,
} from "./helpers.js";

let fixture: PrHttpFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

describe("PR refusal taxonomy", () => {
  it("drives all ten frozen validator reasons through HTTP with byte-neutral logs", async () => {
    fixture = await startPrHttpFixture();
    const observed = new Set<PrRefusalReason>();
    const transcript: string[] = [];

    const refuse = async (
      streamId: string,
      current: ReturnType<typeof event>,
      reason: PrRefusalReason,
    ) => {
      const before = await prSnapshot(fixture!.streams, streamId);
      const result = await fixture!.dispatch(streamId, current);
      const after = await prSnapshot(fixture!.streams, streamId);
      expect(result.status, reason).toBe(409);
      expect(JSON.parse(result.body), reason).toEqual({
        error: { class: "validator-rejected", reason },
      });
      expect(after.headOffset, reason).toBe(before.headOffset);
      expect(after.digest, reason).toBe(before.digest);
      expect(after.dumpSha256, reason).toBe(before.dumpSha256);
      expect(after.dump, reason).toBe(before.dump);
      observed.add(reason);
      transcript.push(
        `E5_T02_REFUSAL ${canonicalJson({
          after: {
            digest: after.digest,
            dumpSha256: after.dumpSha256,
            headOffset: after.headOffset,
          },
          before: {
            digest: before.digest,
            dumpSha256: before.dumpSha256,
            headOffset: before.headOffset,
          },
          dispatch: current,
          reason,
          response: JSON.parse(result.body),
          status: result.status,
          streamId,
        })}`,
      );
    };

    const open = async (prId: string) => {
      const streamId = await fixture!.createPr(prId);
      expect(
        (await fixture!.dispatch(streamId, event("pr.opened", openedPayload(fixture!)))).status,
      ).toBe(202);
      return streamId;
    };

    const first = await fixture.createPr("refuse-first");
    await refuse(
      first,
      event("pr.review-comment", { v: 1, author: "bob", body: "no root" }),
      "pr/first-event-must-be-opened",
    );

    const already = await open("refuse-already");
    await refuse(already, event("pr.opened", openedPayload(fixture)), "pr/already-opened");

    const unknown = await fixture.createPr("refuse-unknown");
    await refuse(
      unknown,
      event(
        "pr.opened",
        openedPayload(fixture, {
          targetBranch: "fs:maple/reading-room:missing:meta",
        }),
      ),
      "pr/unknown-branch",
    );

    const same = await fixture.createPr("refuse-same");
    await refuse(
      same,
      event(
        "pr.opened",
        openedPayload(fixture, {
          sourceBranch: fixture.mainStream,
          targetBranch: fixture.mainStream,
        }),
      ),
      "pr/same-branch",
    );

    const frontier = await fixture.createPr("refuse-frontier");
    const sourceOnlyOffset = offsetForOrdinal(1);
    expect(
      (await fixture.streams.read(fixture.sourceStream)).some(
        (record) =>
          record !== null &&
          typeof record === "object" &&
          !Array.isArray(record) &&
          (record as { readonly offset?: unknown }).offset === sourceOnlyOffset,
      ),
    ).toBe(true);
    expect(
      (await fixture.streams.read(fixture.mainStream)).some(
        (record) =>
          record !== null &&
          typeof record === "object" &&
          !Array.isArray(record) &&
          (record as { readonly offset?: unknown }).offset === sourceOnlyOffset,
      ),
    ).toBe(false);
    await refuse(
      frontier,
      event("pr.opened", openedPayload(fixture, { forkOffset: sourceOnlyOffset })),
      "pr/fork-offset-out-of-range",
    );

    const merge = await open("refuse-merge");
    expect(
      (await fixture.dispatch(merge, event("pr.approved", { v: 1, reviewer: "bob" }))).status,
    ).toBe(202);
    expect(
      (
        await fixture.dispatch(
          merge,
          event("pr.changes-requested", {
            v: 1,
            reviewer: "bob",
            body: "approval revoked",
          }),
        )
      ).status,
    ).toBe(202);
    await refuse(
      merge,
      event("pr.merged", { v: 1, mergedBy: "alice" }),
      "pr/merge-without-approval",
    );

    const terminal = await open("refuse-terminal");
    expect(
      (await fixture.dispatch(terminal, event("pr.approved", { v: 1, reviewer: "bob" }))).status,
    ).toBe(202);
    expect(
      (await fixture.dispatch(terminal, event("pr.merged", { v: 1, mergedBy: "alice" }))).status,
    ).toBe(202);
    await refuse(
      terminal,
      event("pr.review-comment", { v: 1, author: "bob", body: "late" }),
      "pr/terminal",
    );

    const duplicate = await open("refuse-duplicate");
    expect(
      (await fixture.dispatch(duplicate, event("pr.approved", { v: 1, reviewer: "bob" }))).status,
    ).toBe(202);
    await refuse(
      duplicate,
      event("pr.approved", { v: 1, reviewer: "bob" }),
      "pr/duplicate-verdict",
    );

    const self = await open("refuse-self");
    await refuse(self, event("pr.approved", { v: 1, reviewer: "alice" }), "pr/self-review");

    const reply = await open("refuse-reply");
    expect(
      (await fixture.dispatch(reply, event("pr.approved", { v: 1, reviewer: "bob" }))).status,
    ).toBe(202);
    await refuse(
      reply,
      event("pr.review-comment", {
        v: 1,
        author: "carol",
        body: "not a comment",
        replyTo: offsetForOrdinal(1),
      }),
      "pr/reply-to-unknown-comment",
    );

    expect([...observed].sort()).toEqual([...PR_REFUSAL_REASONS].sort());
    expect(transcript).toHaveLength(10);
    for (const line of transcript) console.info(line);
  });

  it("rejects the full vocabulary after merged and closed without moving a byte", async () => {
    fixture = await startPrHttpFixture();
    const terminalEvents = [
      event("pr.opened", openedPayload(fixture)),
      event("pr.review-comment", { v: 1, author: "bob", body: "late" }),
      event("pr.approved", { v: 1, reviewer: "bob" }),
      event("pr.changes-requested", { v: 1, reviewer: "bob", body: "late" }),
      event("pr.merged", { v: 1, mergedBy: "alice" }),
      event("pr.closed", { v: 1, closedBy: "alice" }),
    ];
    for (const terminalKind of ["merged", "closed"] as const) {
      const streamId = await fixture.createPr(`terminal-${terminalKind}`);
      expect(
        (await fixture.dispatch(streamId, event("pr.opened", openedPayload(fixture)))).status,
      ).toBe(202);
      if (terminalKind === "merged") {
        expect(
          (await fixture.dispatch(streamId, event("pr.approved", { v: 1, reviewer: "bob" })))
            .status,
        ).toBe(202);
        expect(
          (await fixture.dispatch(streamId, event("pr.merged", { v: 1, mergedBy: "alice" })))
            .status,
        ).toBe(202);
      } else {
        expect(
          (await fixture.dispatch(streamId, event("pr.closed", { v: 1, closedBy: "alice" })))
            .status,
        ).toBe(202);
      }
      const before = await prSnapshot(fixture.streams, streamId);
      for (const current of terminalEvents) {
        const result = await fixture.dispatch(streamId, current);
        expect(result.status, `${terminalKind}:${current.type}`).toBe(409);
        expect(JSON.parse(result.body)).toEqual({
          error: { class: "validator-rejected", reason: "pr/terminal" },
        });
      }
      const unknown = await fixture.dispatch(
        streamId,
        event("issue.opened", { v: 1, title: "wrong stream", body: "wrong" }),
      );
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({ error: { class: "unknown-action-type" } });
      const invalid = await fixture.dispatch(
        streamId,
        event("pr.approved", { v: 1, reviewer: "bob", extra: true }),
      );
      expect(invalid.status).toBe(422);
      expect(JSON.parse(invalid.body)).toEqual({ error: { class: "schema-violation" } });
      const after = await prSnapshot(fixture.streams, streamId);
      expect(after).toEqual(before);
    }
  });

  it("classifies unknown fields on all six schemas before workflow validation", async () => {
    fixture = await startPrHttpFixture();
    const valid = [
      event("pr.opened", openedPayload(fixture)),
      event("pr.review-comment", { v: 1, author: "bob", body: "comment" }),
      event("pr.approved", { v: 1, reviewer: "bob" }),
      event("pr.changes-requested", { v: 1, reviewer: "bob", body: "change" }),
      event("pr.merged", { v: 1, mergedBy: "alice" }),
      event("pr.closed", { v: 1, closedBy: "alice" }),
    ];
    for (const [index, current] of valid.entries()) {
      const streamId = await fixture.createPr(`schema-extra-${index}`);
      const before = await prSnapshot(fixture.streams, streamId);
      const result = await fixture.dispatch(streamId, {
        ...current,
        payload: { ...(current.payload as Record<string, unknown>), extra: true },
      });
      expect(result.status, current.type).toBe(422);
      expect(JSON.parse(result.body), current.type).toEqual({
        error: { class: "schema-violation" },
      });
      expect(await prSnapshot(fixture.streams, streamId)).toEqual(before);
    }
  });

  it("accepts exact target head and refuses head+1, sentinel, and mid-gap domains", async () => {
    fixture = await startPrHttpFixture();
    const sparseTarget = "fs:maple/reading-room:sparse:meta";
    await fixture.streams.create(sparseTarget);
    await fixture.streams.append(sparseTarget, event("fs.dir.create", { path: "src", v: 2 }, 0), {
      sequence: offsetForOrdinal(0),
      applicationOffset: offsetForOrdinal(0),
    });
    await fixture.streams.append(sparseTarget, event("fs.dir.create", { path: "docs", v: 2 }, 0), {
      sequence: offsetForOrdinal(1),
      applicationOffset: offsetForOrdinal(2),
    });
    const accepted = await fixture.createPr("frontier-accepted");
    expect(
      (
        await fixture.dispatch(
          accepted,
          event(
            "pr.opened",
            openedPayload(fixture, {
              targetBranch: sparseTarget,
              forkOffset: offsetForOrdinal(2),
            }),
          ),
        )
      ).status,
    ).toBe(202);
    expect((await prSnapshot(fixture.streams, accepted)).state).toMatchObject({
      sourceBranch: fixture.sourceStream,
      targetBranch: sparseTarget,
      forkOffset: offsetForOrdinal(2),
    });

    for (const [name, forkOffset] of [
      ["head-plus-one", offsetForOrdinal(3)],
      ["sentinel", "-1"],
      ["mid-gap", offsetForOrdinal(1)],
    ] as const) {
      const streamId = await fixture.createPr(`frontier-${name}`);
      const before = await prSnapshot(fixture.streams, streamId);
      const result = await fixture.dispatch(
        streamId,
        event("pr.opened", openedPayload(fixture, { targetBranch: sparseTarget, forkOffset })),
      );
      expect(result.status).toBe(409);
      expect(JSON.parse(result.body)).toEqual({
        error: { class: "validator-rejected", reason: "pr/fork-offset-out-of-range" },
      });
      expect(await prSnapshot(fixture.streams, streamId)).toEqual(before);
    }
  });

  it("refuses a nonexistent source and a never-approved merge without mutation", async () => {
    fixture = await startPrHttpFixture();

    const unknownSource = await fixture.createPr("unknown-source");
    const beforeUnknown = await prSnapshot(fixture.streams, unknownSource);
    const unknownResult = await fixture.dispatch(
      unknownSource,
      event(
        "pr.opened",
        openedPayload(fixture, {
          sourceBranch: "fs:maple/reading-room:missing-source:meta",
        }),
      ),
    );
    expect(unknownResult.status).toBe(409);
    expect(JSON.parse(unknownResult.body)).toEqual({
      error: { class: "validator-rejected", reason: "pr/unknown-branch" },
    });
    expect(await prSnapshot(fixture.streams, unknownSource)).toEqual(beforeUnknown);

    const neverApproved = await fixture.createPr("never-approved");
    expect(
      (await fixture.dispatch(neverApproved, event("pr.opened", openedPayload(fixture)))).status,
    ).toBe(202);
    const beforeMerge = await prSnapshot(fixture.streams, neverApproved);
    const mergeResult = await fixture.dispatch(
      neverApproved,
      event("pr.merged", { v: 1, mergedBy: "alice" }),
    );
    expect(mergeResult.status).toBe(409);
    expect(JSON.parse(mergeResult.body)).toEqual({
      error: { class: "validator-rejected", reason: "pr/merge-without-approval" },
    });
    expect(await prSnapshot(fixture.streams, neverApproved)).toEqual(beforeMerge);
  });
});
