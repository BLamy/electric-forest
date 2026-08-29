import { type Event, type Offset } from "@eforest/protocol";
import {
  ActionValidatorRegistry,
  registerApplicationValidators,
  type ActionValidationContext,
} from "@eforest/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  event,
  openedPayload,
  prSnapshot,
  startPrHttpFixture,
  type PrHttpFixture,
} from "./helpers.js";

class StallingMergeRegistry extends ActionValidatorRegistry {
  readonly mergeHeads: Offset[] = [];
  readonly entered: Promise<void>;

  private enter!: () => void;
  private releaseStall!: () => void;
  private stalled = false;
  private readonly released: Promise<void>;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.enter = resolve;
    });
    this.released = new Promise((resolve) => {
      this.releaseStall = resolve;
    });
  }

  override async validate(action: Event, context: ActionValidationContext): Promise<void> {
    if (action.type === "pr.merged") this.mergeHeads.push(context.headOffset);
    await super.validate(action, context);
    if (action.type === "pr.merged" && !this.stalled) {
      this.stalled = true;
      this.enter();
      await this.released;
    }
  }

  release(): void {
    this.releaseStall();
  }
}

let fixture: PrHttpFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

async function approvedPr(fixtureValue: PrHttpFixture, prId: string): Promise<string> {
  const streamId = await fixtureValue.createPr(prId);
  expect(
    (await fixtureValue.dispatch(streamId, event("pr.opened", openedPayload(fixtureValue)))).status,
  ).toBe(202);
  expect(
    (await fixtureValue.dispatch(streamId, event("pr.approved", { v: 1, reviewer: "bob" }))).status,
  ).toBe(202);
  return streamId;
}

describe("serialized PR validation across independent gateways", () => {
  it("reruns a stalled merge after changes-requested wins the CAS", async () => {
    fixture = await startPrHttpFixture();
    const registry = new StallingMergeRegistry();
    registerApplicationValidators(registry);
    const stalledGateway = await fixture.attachGateway(registry);
    const streamId = await approvedPr(fixture, "race-changes-vs-merge");

    const merge = fixture.dispatch(
      streamId,
      event("pr.merged", { v: 1, mergedBy: "alice" }),
      stalledGateway.baseUrl,
    );
    await registry.entered;
    try {
      expect(
        (
          await fixture.dispatch(
            streamId,
            event("pr.changes-requested", {
              v: 1,
              reviewer: "bob",
              body: "Do not merge yet",
            }),
          )
        ).status,
      ).toBe(202);
    } finally {
      registry.release();
    }

    const result = await merge;
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toEqual({
      error: { class: "validator-rejected", reason: "pr/merge-without-approval" },
    });
    const snapshot = await prSnapshot(fixture.streams, streamId);
    expect(snapshot.records.map((record) => record.type)).toEqual([
      "pr.opened",
      "pr.approved",
      "pr.changes-requested",
    ]);
    expect(snapshot.state.status).toBe("open");
    expect(snapshot.state.approvals).toEqual([]);
    expect(registry.mergeHeads).toEqual([snapshot.records[1]!.offset, snapshot.records[2]!.offset]);
  });

  it("reruns a stalled merge after close wins the CAS", async () => {
    fixture = await startPrHttpFixture();
    const registry = new StallingMergeRegistry();
    registerApplicationValidators(registry);
    const stalledGateway = await fixture.attachGateway(registry);
    const streamId = await approvedPr(fixture, "race-close-vs-merge");

    const merge = fixture.dispatch(
      streamId,
      event("pr.merged", { v: 1, mergedBy: "alice" }),
      stalledGateway.baseUrl,
    );
    await registry.entered;
    try {
      expect(
        (
          await fixture.dispatch(
            streamId,
            event("pr.closed", { v: 1, closedBy: "alice", reason: "superseded" }),
          )
        ).status,
      ).toBe(202);
    } finally {
      registry.release();
    }

    const result = await merge;
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toEqual({
      error: { class: "validator-rejected", reason: "pr/terminal" },
    });
    const snapshot = await prSnapshot(fixture.streams, streamId);
    expect(snapshot.records.map((record) => record.type)).toEqual([
      "pr.opened",
      "pr.approved",
      "pr.closed",
    ]);
    expect(snapshot.state.status).toBe("closed");
    expect(snapshot.state.resolvedAtOffset).toBe(snapshot.records[2]!.offset);
    expect(registry.mergeHeads).toEqual([snapshot.records[1]!.offset, snapshot.records[2]!.offset]);
  });
});
