import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { parseFrontmatter } from "./src/site/frontmatter.js";

export { parseFrontmatter };

/**
 * Build-time index of the repository's own `.eforest/tasks/` board, exposed to the
 * public site as the virtual module `virtual:eforest-roadmap`. It mirrors the flat-YAML
 * frontmatter contract of `tools/build_queue.py` so the roadmap page and the generated
 * queue can never disagree about what a task is. Task bodies are not inlined here; the
 * site loads each readme lazily through `import.meta.glob` and renders it with Docstream.
 */

export type TaskStatus =
  "pending" | "in-progress" | "implemented" | "refuted" | "verified" | "cancelled";

export interface TaskIndexEntry {
  readonly id: string;
  readonly epic: number;
  readonly title: string;
  readonly priority: number;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly estimate: string | undefined;
  readonly capstone: boolean;
  /** `epic-5-the-meadow/E5-T14-visual-product-capstone` — the folder under `.eforest/tasks/`. */
  readonly folder: string;
}

export interface EpicIndexEntry {
  readonly number: number;
  /** `the-meadow` */
  readonly slug: string;
  /** `epic-5-the-meadow` */
  readonly folder: string;
}

export interface RoadmapIndex {
  readonly epics: readonly EpicIndexEntry[];
  readonly tasks: readonly TaskIndexEntry[];
}

const STATUSES: readonly TaskStatus[] = [
  "pending",
  "in-progress",
  "implemented",
  "refuted",
  "verified",
  "cancelled",
];

export function taskFromFrontmatter(
  fields: Readonly<Record<string, string>>,
  folder: string,
): TaskIndexEntry | undefined {
  const id = fields["id"];
  const epic = Number(fields["epic"]);
  const priority = Number(fields["priority"]);
  const status = fields["status"];
  if (id === undefined || !Number.isFinite(epic) || !Number.isFinite(priority)) return undefined;
  if (!STATUSES.includes(status as TaskStatus)) return undefined;
  const dependsOn = (fields["depends_on"] ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    id,
    epic,
    title: fields["title"] ?? id,
    priority,
    status: status as TaskStatus,
    dependsOn,
    estimate: fields["estimate"],
    capstone: (fields["capstone"] ?? "").toLowerCase() === "true",
    folder,
  };
}

export function indexTasks(tasksRoot: string): RoadmapIndex {
  const epics: EpicIndexEntry[] = [];
  const tasks: TaskIndexEntry[] = [];
  for (const epicFolder of readdirSync(tasksRoot).sort()) {
    const epicMatch = /^epic-(\d+(?:\.\d+)?)-(.+)$/.exec(epicFolder);
    if (epicMatch === null || !statSync(resolve(tasksRoot, epicFolder)).isDirectory()) continue;
    epics.push({ number: Number(epicMatch[1]), slug: epicMatch[2]!, folder: epicFolder });
    for (const taskFolder of readdirSync(resolve(tasksRoot, epicFolder)).sort()) {
      if (!/^E[0-9.]+-T[0-9]+[a-z]*/.test(taskFolder)) continue;
      let text: string;
      try {
        text = readFileSync(resolve(tasksRoot, epicFolder, taskFolder, "readme.md"), "utf8");
      } catch {
        continue;
      }
      const entry = taskFromFrontmatter(
        parseFrontmatter(text).fields,
        `${epicFolder}/${taskFolder}`,
      );
      if (entry !== undefined) tasks.push(entry);
    }
  }
  epics.sort((left, right) => left.number - right.number);
  tasks.sort((left, right) => left.priority - right.priority);
  return { epics, tasks };
}

const VIRTUAL_ID = "virtual:eforest-roadmap";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

export function eforestContent(options: { readonly root: string }): Plugin {
  const tasksRoot = resolve(options.root, ".eforest/tasks");
  return {
    name: "eforest-content",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export default ${JSON.stringify(indexTasks(tasksRoot))};`;
    },
    configureServer(server) {
      server.watcher.add(tasksRoot);
      server.watcher.on("all", (_event, path) => {
        if (!path.startsWith(tasksRoot)) return;
        const module = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (module !== undefined) server.moduleGraph.invalidateModule(module);
      });
    },
  };
}
