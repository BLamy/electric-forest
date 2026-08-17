import { describe, expect, it } from "vitest";
import type { Offset } from "@eforest/protocol";
import { decisionLine, planUplink, repairJournal } from "../src/sync/reconcile.js";

describe("offline reconcile planning", () => {
  it("confirms accepted journal offsets without creating dispatches", () => {
    expect(
      repairJournal(
        [{ kind: "accepted", path: "docs/a.md", offset: "0000000000000000_0000000000000001" }],
        [{ offset: "0000000000000000_0000000000000001" } as never],
      ),
    ).toEqual([
      {
        phase: "repair",
        action: "confirmed",
        path: "docs/a.md",
        offset: "0000000000000000_0000000000000001" as Offset,
      },
    ]);
  });

  it("fails closed when the journal cites an unassigned offset", () => {
    expect(() => repairJournal([{ kind: "accepted", path: "a", offset: "bad" }], [])).toThrow(
      "reconcile/journal-offset-unassigned",
    );
  });

  it("plans ledger-based paths in byte order and suppresses downlink echoes", () => {
    expect(
      planUplink({ added: ["z"], deleted: [], modified: ["a", "remote"] }, ["remote"], {
        files: { a: { base: "0000000000000000_0000000000000004" } },
      } as never),
    ).toEqual([
      {
        phase: "uplink",
        action: "dispatched",
        path: "a",
        base: "0000000000000000_0000000000000004",
      },
      { phase: "uplink", action: "dispatched", path: "z", base: "BASE_NONE" },
    ]);
  });

  it("serializes each decision as one canonical LF-delimited record", () => {
    expect(
      decisionLine({
        phase: "downlink",
        action: "suppressed",
        path: "docs/a.md",
        offset: "0000000000000000_0000000000000001" as Offset,
      }),
    ).toBe(
      '{"action":"suppressed","offset":"0000000000000000_0000000000000001","path":"docs/a.md","phase":"downlink"}\n',
    );
  });

  it("is independent of mtime and directory enumeration order", () => {
    const ledger = {
      files: {
        "docs/z.txt": { base: "0000000000000000_0000000000000007" },
        "docs/a.txt": { base: "0000000000000000_0000000000000008" },
      },
    } as never;
    const first = planUplink(
      { added: ["docs/new.txt"], deleted: [], modified: ["docs/z.txt", "docs/a.txt"] },
      [],
      ledger,
    );
    const second = planUplink(
      { added: ["docs/new.txt"], deleted: [], modified: ["docs/a.txt", "docs/z.txt"] },
      [],
      ledger,
    );
    expect(second).toEqual(first);
  });
});
