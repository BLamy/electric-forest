import type { Event } from "@eforest/protocol";
import { fsInitialState, fsReducer, treeDigest } from "@eforest/streamfs";
import { describe, expect, it } from "vitest";
import {
  bindWikiProvisioningDoor,
  isWikiSlug,
  wikiBranchStreamId,
  wikiEditRoute,
  wikiIndexRoute,
  wikiPagePath,
  wikiPageRoute,
  type WikiDispatchDoor,
} from "../src/index.js";

class MemoryDispatchDoor implements WikiDispatchDoor {
  readonly streams = new Map<string, Event[]>();
  readonly dispatches: Array<{ readonly streamId: string; readonly event: Event }> = [];

  async inspect(streamId: string) {
    const events = this.streams.get(streamId);
    return { events: events === undefined ? undefined : [...events] };
  }

  async dispatch(streamId: string, event: Event): Promise<void> {
    this.dispatches.push({ streamId, event });
    if (this.streams.has(streamId)) throw new Error("stream already exists");
    this.streams.set(streamId, [event]);
  }
}

describe("wiki branch provisioning", () => {
  it("uses the frozen E2 repo prefix and E1 branch metadata stream id", () => {
    expect(wikiBranchStreamId("acme", "field-notes")).toBe("fs:acme/field-notes:wiki:meta");
  });

  it("creates a parentless branch whose reduced tree is empty", async () => {
    const door = new MemoryDispatchDoor();
    const provisioner = bindWikiProvisioningDoor(door, { now: () => 42 });

    const result = await provisioner.ensureWikiBranch("acme", "field-notes");
    const events = door.streams.get(result.streamId)!;

    expect(result).toEqual({ streamId: "fs:acme/field-notes:wiki:meta", created: true });
    expect(events).toEqual([
      {
        type: "fs.branch.genesis",
        payload: { v: 1, branch: "wiki" },
        ts: 42,
      },
    ]);
    expect(events.some((event) => event.type === "fs.branch.fork")).toBe(false);
    expect(treeDigest(events.reduce(fsReducer, fsInitialState))).toBe(treeDigest(fsInitialState));
  });

  it("is idempotent: the second call appends nothing and returns the same stream id", async () => {
    const door = new MemoryDispatchDoor();
    const provisioner = bindWikiProvisioningDoor(door, { now: () => 42 });

    const first = await provisioner.ensureWikiBranch("acme", "field-notes");
    const eventCount = door.streams.get(first.streamId)!.length;
    const second = await provisioner.ensureWikiBranch("acme", "field-notes");

    expect(second).toEqual({ streamId: first.streamId, created: false });
    expect(door.dispatches).toHaveLength(1);
    expect(door.streams.get(first.streamId)).toHaveLength(eventCount);
  });

  it("is idempotent when two first-open callers race after the same absent inspection", async () => {
    const streamId = wikiBranchStreamId("acme", "field-notes");
    const streams = new Map<string, Event[]>();
    const inspections: string[] = [];
    const dispatches: Event[] = [];
    let waiting = 0;
    let releaseInspections: (() => void) | undefined;
    const bothInspected = new Promise<void>((resolve) => {
      releaseInspections = resolve;
    });
    const door: WikiDispatchDoor = {
      inspect: async (candidate) => {
        inspections.push(candidate);
        const events = streams.get(candidate);
        if (events !== undefined) return { events: [...events] };
        waiting += 1;
        if (waiting === 2) releaseInspections?.();
        await bothInspected;
        return { events: undefined };
      },
      dispatch: async (candidate, event) => {
        dispatches.push(event);
        if (streams.has(candidate)) throw new Error("stream already exists");
        streams.set(candidate, [event]);
      },
    };
    const provisioner = bindWikiProvisioningDoor(door, { now: () => 42 });

    const results = await Promise.all([
      provisioner.ensureWikiBranch("acme", "field-notes"),
      provisioner.ensureWikiBranch("acme", "field-notes"),
    ]);

    expect(results.map((result) => result.streamId)).toEqual([streamId, streamId]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(dispatches).toHaveLength(2);
    expect(streams.get(streamId)).toHaveLength(1);
    expect(streams.get(streamId)?.[0]).toMatchObject({
      type: "fs.branch.genesis",
      payload: { v: 1, branch: "wiki" },
    });
    expect(inspections).toHaveLength(4);
  });
});

describe("wiki slug, path, and route contracts", () => {
  it("accepts only flat lowercase slugs and derives the frozen paths", () => {
    expect(isWikiSlug("getting-started")).toBe(true);
    expect(wikiPagePath("getting-started")).toBe("getting-started.md");
    expect(isWikiSlug("trailing-")).toBe(true);
    for (const invalid of ["Getting-Started", "nested/page", "-leading", ""])
      expect(isWikiSlug(invalid)).toBe(false);
    expect(() => wikiPagePath("nested/page")).toThrow(TypeError);

    expect(wikiIndexRoute("acme", "field-notes")).toBe("/orgs/acme/repos/field-notes/wiki");
    expect(wikiPageRoute("acme", "field-notes", "getting-started")).toBe(
      "/orgs/acme/repos/field-notes/wiki/getting-started",
    );
    expect(wikiEditRoute("acme", "field-notes", "getting-started")).toBe(
      "/orgs/acme/repos/field-notes/wiki/getting-started/edit",
    );
  });
});
