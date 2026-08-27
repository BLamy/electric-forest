import { describe, expect, it } from "vitest";
import { stateDigest, type Event } from "@eforest/protocol";
import {
  BOARD_REDUCER,
  BOARD_VIEW_VERSION,
  boardDigest,
  compareUtf8,
  deriveBoard,
  filterBoard,
  type IssueLog,
} from "../src/index.js";

function event(type: string, payload: Record<string, unknown>, ts = 1): Event {
  return { type, payload, ts };
}

const labels = [
  event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "red" }),
  event("label.created", { v: 1, labelId: "kind", name: "Kind", color: "blue" }, 2),
];

function issue(issueId: string, state: string, labelIds: readonly string[] = []): IssueLog {
  const events: Event[] = [
    event("issue.opened", { v: 1, title: issueId, body: "" }),
    ...labelIds.map((labelId, index) =>
      event("issue.labeled", { v: 1, label: labelId }, index + 2),
    ),
  ];
  if (state === "closed") events.push(event("issue.closed", { v: 1 }, 20));
  else if (state !== "open") events.push(event("issue.state-changed", { v: 1, to: state }, 20));
  return { streamId: `issue:maple/reading-room/${issueId}`, events };
}

describe("issue-board@1", () => {
  it("freezes the empty five-column shape", () => {
    const board = deriveBoard([], []);
    expect(board).toEqual({
      v: BOARD_VIEW_VERSION,
      reducer: BOARD_REDUCER,
      columns: {
        open: { count: 0, issues: [] },
        "in-progress": { count: 0, issues: [] },
        done: { count: 0, issues: [] },
        closed: { count: 0, issues: [] },
        "wont-do": { count: 0, issues: [] },
      },
      labels: {},
    });
  });

  it("places every issue exactly once and sorts by UTF-8 bytes", () => {
    const logs = [
      issue("a", "open", ["bug"]),
      issue("B", "in-progress", ["bug", "kind"]),
      issue("_", "done"),
      issue("z", "closed", ["kind"]),
      issue("A", "wont-do"),
    ];
    const board = deriveBoard(labels, logs.slice().reverse());
    expect(
      Object.values(board.columns)
        .flatMap((column) => column.issues)
        .sort(compareUtf8),
    ).toEqual(["A", "B", "_", "a", "z"].sort(compareUtf8));
    for (const column of Object.values(board.columns))
      expect(column.count).toBe(column.issues.length);
    expect(board.labels.bug?.issues).toEqual(["B", "a"]);
    expect(boardDigest(board)).toBe(stateDigest(board));

    const ordered = deriveBoard(labels, [
      issue("a", "open"),
      issue("_", "open"),
      issue("B", "open"),
    ]);
    expect(ordered.columns.open.issues).toEqual(["B", "_", "a"]);
  });

  it("filters by labelId, recomputes counts, and refuses unknown labels", () => {
    const board = deriveBoard(labels, [
      issue("a", "open", ["bug"]),
      issue("b", "done", ["kind"]),
      issue("c", "done", ["bug", "kind"]),
    ]);
    const filtered = filterBoard(board, "bug");
    expect(filtered.columns.open).toEqual({ count: 1, issues: ["a"] });
    expect(filtered.columns.done).toEqual({ count: 1, issues: ["c"] });
    expect(filtered.labels.bug?.issues).toEqual(["a", "c"]);
    expect(filtered.labels.kind?.issues).toEqual(["c"]);
    for (const labelId of ["missing", "constructor", "toString", "__proto__"])
      expect(() => filterBoard(board, labelId)).toThrow(`unknown labelId: ${labelId}`);
  });

  it("preserves membership across label rename and recolor while changing the digest", () => {
    const logs = [issue("a", "open", ["bug"]), issue("b", "done", ["bug"])];
    const before = deriveBoard(labels, logs);
    const after = deriveBoard(
      [
        ...labels,
        event("label.renamed", { v: 1, labelId: "bug", name: "Defect" }, 3),
        event("label.recolored", { v: 1, labelId: "bug", color: "maroon" }, 4),
      ],
      logs,
    );
    expect(after.labels.bug?.issues).toEqual(before.labels.bug?.issues);
    expect(filterBoard(after, "bug").columns).toEqual(filterBoard(before, "bug").columns);
    expect(boardDigest(after)).not.toBe(boardDigest(before));
  });

  it("is independent of issue-log fold order across seeded permutations", () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const logs = Array.from({ length: 12 }, (_, index) =>
        issue(
          `i-${String(index).padStart(2, "0")}`,
          ["open", "in-progress", "done", "closed", "wont-do"][(seed + index) % 5]!,
          index % 3 === 0 ? ["bug"] : index % 3 === 1 ? ["kind"] : [],
        ),
      );
      const shuffled = [...logs];
      let random = seed >>> 0;
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        random = (random * 1664525 + 1013904223) >>> 0;
        const swap = random % (index + 1);
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
      }
      expect(boardDigest(deriveBoard(labels, shuffled))).toBe(
        boardDigest(deriveBoard(labels, logs)),
      );
    }
  });

  it("converges after a 200-event run under three per-stream-valid interleavings", () => {
    const logs = Array.from({ length: 20 }, (_, index): IssueLog => {
      const id = `long-${String(index).padStart(2, "0")}`;
      return {
        streamId: `issue:maple/reading-room/${id}`,
        events: [
          event("issue.opened", { v: 1, title: id, body: "" }, 1),
          event("issue.labeled", { v: 1, label: "bug" }, 2),
          event("issue.state-changed", { v: 1, to: "in-progress" }, 3),
          event("issue.commented", { v: 1, commentId: `${id}-1`, body: "one" }, 4),
          event("issue.unlabeled", { v: 1, label: "bug" }, 5),
          event("issue.labeled", { v: 1, label: "kind" }, 6),
          event("issue.state-changed", { v: 1, to: "done" }, 7),
          event("issue.commented", { v: 1, commentId: `${id}-2`, body: "two" }, 8),
          event("issue.reopened", { v: 1 }, 9),
          event("issue.state-changed", { v: 1, to: "wont-do" }, 10),
        ],
      };
    });
    expect(logs.reduce((count, log) => count + log.events.length, 0)).toBe(200);

    const expected = boardDigest(deriveBoard(labels, logs));
    const schedules = [
      logs,
      [...logs].reverse(),
      [...logs.slice(0, 10).reverse(), ...logs.slice(10).reverse()],
    ];
    for (const schedule of schedules) {
      const prefixes = new Map(schedule.map((log) => [log.streamId, [] as Event[]]));
      for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
        for (const log of schedule) prefixes.get(log.streamId)!.push(log.events[eventIndex]!);
      }
      const interleaved = schedule.map((log) => ({
        streamId: log.streamId,
        events: prefixes.get(log.streamId)!,
      }));
      expect(boardDigest(deriveBoard(labels, interleaved))).toBe(expected);
    }
  });

  it("fails closed instead of silently ignoring corrupt issue records", () => {
    expect(() =>
      deriveBoard(labels, [
        {
          streamId: "issue:maple/reading-room/corrupt",
          events: [
            event("issue.opened", { v: 1, title: "Corrupt", body: "" }),
            event("issue.state-changed", { v: 1, to: "closed" }, 2),
          ],
        },
      ]),
    ).toThrow("illegal issue transition");
    expect(() =>
      deriveBoard(labels, [
        {
          streamId: "issue:maple/reading-room/malformed",
          events: [event("issue.opened", { v: 1, title: "Missing body" })],
        },
      ]),
    ).toThrow("corrupt issue event");
  });
});
