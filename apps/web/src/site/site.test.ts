import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { indexTasks, taskFromFrontmatter } from "../../eforest-content.plugin.js";
import { parseFrontmatter } from "./frontmatter.js";
import { milestoneLadder } from "./ladder.js";
import { hasReplayedSession, publicSitePage } from "./session.js";

const root = resolve(import.meta.dirname, "../../../..");
const tasksRoot = resolve(root, ".eforest/tasks");

describe("public site: task board index", () => {
  it("parses the flat-YAML frontmatter dialect of tools/build_queue.py", () => {
    const parsed = parseFrontmatter(
      '---\nid: E5-T14\nepic: 5\ntitle: "Capstone: colons, stay"\npriority: 514.5 # queue jump\nstatus: verified\ndepends_on: [E5-T13, E5]\ncapstone: true\n---\n\n## Goal\n',
    );
    expect(parsed.fields).toEqual({
      id: "E5-T14",
      epic: "5",
      title: "Capstone: colons, stay",
      priority: "514.5",
      status: "verified",
      depends_on: "[E5-T13, E5]",
      capstone: "true",
    });
    expect(parsed.body).toBe("\n## Goal\n");
    expect(taskFromFrontmatter(parsed.fields, "epic-5-the-meadow/E5-T14-x")).toEqual({
      id: "E5-T14",
      epic: 5,
      title: "Capstone: colons, stay",
      priority: 514.5,
      status: "verified",
      dependsOn: ["E5-T13", "E5"],
      estimate: undefined,
      capstone: true,
      folder: "epic-5-the-meadow/E5-T14-x",
    });
    expect(parseFrontmatter("no frontmatter").body).toBe("no frontmatter");
    expect(taskFromFrontmatter({ id: "X", epic: "1", priority: "1", status: "bogus" }, "f")).toBe(
      undefined,
    );
  });

  it("indexes every task folder under .eforest/tasks exactly once, in queue order", () => {
    const index = indexTasks(tasksRoot);
    const folders = readdirSync(tasksRoot)
      .filter((name) => /^epic-\d+-/.test(name))
      .flatMap((epic) =>
        readdirSync(resolve(tasksRoot, epic))
          .filter((name) => /^E[0-9.]+-T[0-9]+/.test(name))
          .map((task) => `${epic}/${task}`),
      );
    expect(index.tasks.map((task) => task.folder).sort()).toEqual(folders.sort());
    expect(new Set(index.tasks.map((task) => task.id)).size).toBe(index.tasks.length);
    for (const task of index.tasks) {
      expect(task.folder.split("/")[1]!.startsWith(task.id), task.folder).toBe(true);
      expect(
        index.epics.some((epic) => epic.number === task.epic),
        task.id,
      ).toBe(true);
    }
    const priorities = index.tasks.map((task) => task.priority);
    expect(priorities).toEqual([...priorities].sort((left, right) => left - right));
    expect(index.epics.map((epic) => epic.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("agrees with the generated QUEUE.md about the verified count", async () => {
    const queue = await readFile(resolve(tasksRoot, "QUEUE.md"), "utf8");
    const match = /\*\*(\d+) \/ (\d+) tasks verified\.\*\*/.exec(queue);
    expect(match).not.toBeNull();
    const index = indexTasks(tasksRoot);
    expect(index.tasks.filter((task) => task.status === "verified").length).toBe(Number(match![1]));
    expect(index.tasks.length).toBe(Number(match![2]));
  });
});

describe("public site: roadmap ladder", () => {
  it("reads the milestone ladder from ROADMAP.md", async () => {
    const ladder = milestoneLadder(await readFile(resolve(root, "ROADMAP.md"), "utf8"));
    expect(ladder.map((row) => row.epic)).toEqual([
      "E0",
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "E7",
      "E8",
    ]);
    expect(ladder[0]).toMatchObject({ name: "the-seed", milestone: "two-terminals-one-log" });
    expect(ladder.at(-1)?.name).toBe("the-mirror");
  });
});

describe("public site: routing", () => {
  it("mirrors the platform's public routes and makes / session-aware", () => {
    expect(publicSitePage("/", false)).toEqual({ kind: "landing" });
    expect(publicSitePage("/", true)).toBe(undefined);
    expect(publicSitePage("/home", true)).toEqual({ kind: "landing" });
    expect(publicSitePage("/roadmap", true)).toEqual({ kind: "roadmap" });
    expect(publicSitePage("/roadmap/document", false)).toEqual({ kind: "roadmap-document" });
    expect(publicSitePage("/roadmap/E5-T14", false)).toEqual({ kind: "task", id: "E5-T14" });
    expect(publicSitePage("/docs", false)).toEqual({ kind: "docs", slug: undefined });
    expect(publicSitePage("/docs/concepts/one-model/", false)).toEqual({
      kind: "docs",
      slug: "concepts/one-model",
    });
    for (const path of ["/docsy", "/roadmapper", "/maple/reading-room", "/repositories"]) {
      expect(publicSitePage(path, false), path).toBe(undefined);
    }
  });

  it("only trusts the exact server-stamped session marker", () => {
    const doc = (head: string): Document =>
      ({
        querySelector: (selector: string) =>
          head.includes('name="ef-session" content="replayed"') &&
          selector === 'meta[name="ef-session"][content="replayed"]'
            ? {}
            : null,
      }) as unknown as Document;
    expect(hasReplayedSession(doc('<meta name="ef-session" content="replayed">'))).toBe(true);
    expect(hasReplayedSession(doc("<title>ef</title>"))).toBe(false);
  });
});
