import { canonicalJson, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
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

function at(ordinal: number): Offset {
  return offsetForOrdinal(ordinal);
}

describe("PR compacted target frontier", () => {
  it("refuses compacted-away offsets and accepts retained dump offsets", async () => {
    fixture = await startPrHttpFixture();
    const targetBranch = "fs:maple/reading-room:compacted-target:meta";
    await fixture.streams.create(targetBranch);
    for (const [ordinal, path] of ["compacted-away", "retained"].entries()) {
      await fixture.streams.append(
        targetBranch,
        event("fs.dir.create", { path, v: 2 }, ordinal + 1),
        { sequence: at(ordinal), applicationOffset: at(ordinal) },
      );
    }

    const dumpUrl = `${fixture.officialUrl}/streams/${encodeURIComponent(targetBranch)}/dump`;
    const beforeCompaction = await fetch(dumpUrl);
    expect(beforeCompaction.status).toBe(200);
    const transportOffsets = JSON.parse(
      beforeCompaction.headers.get("stream-dump-offsets") ?? "null",
    ) as string[];
    expect(transportOffsets).toHaveLength(2);
    const compact = await fetch(
      `${fixture.officialUrl}/streams/${encodeURIComponent(targetBranch)}/compact`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotOffset: at(0), transportOffset: transportOffsets[0] }),
      },
    );
    expect(compact.status).toBe(200);

    const retainedDump = await fetch(dumpUrl);
    expect(retainedDump.status).toBe(200);
    expect((await retainedDump.text()).trim()).toBe(
      canonicalJson([
        {
          offset: at(1),
          payload: { path: "retained", v: 2 },
          ts: 2,
          type: "fs.dir.create",
        },
      ]),
    );

    const compactedAwayPr = await fixture.createPr("compacted-away-frontier");
    const beforeRefusal = await prSnapshot(fixture.streams, compactedAwayPr);
    const refused = await fixture.dispatch(
      compactedAwayPr,
      event("pr.opened", openedPayload(fixture, { targetBranch, forkOffset: at(0) })),
    );
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toEqual({
      error: { class: "validator-rejected", reason: "pr/fork-offset-out-of-range" },
    });
    expect(await prSnapshot(fixture.streams, compactedAwayPr)).toEqual(beforeRefusal);

    const retainedPr = await fixture.createPr("retained-frontier");
    const accepted = await fixture.dispatch(
      retainedPr,
      event("pr.opened", openedPayload(fixture, { targetBranch, forkOffset: at(1) })),
    );
    expect(accepted.status).toBe(202);
    expect((await prSnapshot(fixture.streams, retainedPr)).state).toMatchObject({
      status: "open",
      sourceBranch: fixture.sourceStream,
      targetBranch,
      forkOffset: at(1),
    });
  });
});
