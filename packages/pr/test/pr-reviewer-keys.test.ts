import { afterEach, describe, expect, it } from "vitest";
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

describe("PR reviewer keys", () => {
  it("derives verdicts for every schema-valid string through the HTTP dispatch door", async () => {
    fixture = await startPrHttpFixture();
    const streamId = await fixture.createPr("prototype-free-reviewers");
    expect(
      (await fixture.dispatch(streamId, event("pr.opened", openedPayload(fixture)))).status,
    ).toBe(202);

    const reviewers = ["__proto__", "constructor", "toString"] as const;
    const canonicalReviewers = ["__proto__", "constructor", "toString"];
    for (const reviewer of reviewers) {
      expect(
        (await fixture.dispatch(streamId, event("pr.approved", { v: 1, reviewer }))).status,
      ).toBe(202);
      const beforeDuplicate = await prSnapshot(fixture.streams, streamId);
      const duplicate = await fixture.dispatch(streamId, event("pr.approved", { v: 1, reviewer }));
      expect(duplicate.status).toBe(409);
      expect(JSON.parse(duplicate.body)).toEqual({
        error: { class: "validator-rejected", reason: "pr/duplicate-verdict" },
      });
      expect(await prSnapshot(fixture.streams, streamId)).toEqual(beforeDuplicate);
    }

    expect((await prSnapshot(fixture.streams, streamId)).state).toMatchObject({
      status: "approved",
      approvals: canonicalReviewers,
    });

    for (const reviewer of reviewers) {
      expect(
        (
          await fixture.dispatch(
            streamId,
            event("pr.changes-requested", { v: 1, reviewer, body: "revise" }),
          )
        ).status,
      ).toBe(202);
      expect((await prSnapshot(fixture.streams, streamId)).state).toMatchObject({
        status: "open",
        approvals: canonicalReviewers.filter((candidate) => candidate !== reviewer),
      });

      const beforeDuplicate = await prSnapshot(fixture.streams, streamId);
      const duplicate = await fixture.dispatch(
        streamId,
        event("pr.changes-requested", { v: 1, reviewer, body: "still revise" }),
      );
      expect(duplicate.status).toBe(409);
      expect(JSON.parse(duplicate.body)).toEqual({
        error: { class: "validator-rejected", reason: "pr/duplicate-verdict" },
      });
      expect(await prSnapshot(fixture.streams, streamId)).toEqual(beforeDuplicate);

      expect(
        (await fixture.dispatch(streamId, event("pr.approved", { v: 1, reviewer }))).status,
      ).toBe(202);
      expect((await prSnapshot(fixture.streams, streamId)).state).toMatchObject({
        status: "approved",
        approvals: canonicalReviewers,
      });
    }

    expect(
      (await fixture.dispatch(streamId, event("pr.merged", { v: 1, mergedBy: "maintainer" })))
        .status,
    ).toBe(202);
    expect((await prSnapshot(fixture.streams, streamId)).state.status).toBe("merged");
  });
});
