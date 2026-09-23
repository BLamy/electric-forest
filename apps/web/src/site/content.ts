import { parseFrontmatter } from "./frontmatter.js";
import { milestoneLadder as ladder, type Milestone } from "./ladder.js";
import roadmapIndex from "virtual:eforest-roadmap";
import roadmapDocument from "../../../../ROADMAP.md?raw";
import architectureDocument from "../../../../ARCHITECTURE.md?raw";
import loopDocument from "../../../../.eforest/loop.md?raw";
import taskSystemDocument from "../../../../.eforest/tasks/README.md?raw";

export type {
  EpicIndexEntry,
  RoadmapIndex,
  TaskIndexEntry,
  TaskStatus,
} from "../../eforest-content.plugin.js";

export const roadmap = roadmapIndex;
export const documents = {
  roadmap: roadmapDocument,
  architecture: architectureDocument,
  loop: loopDocument,
  taskSystem: taskSystemDocument,
} as const;

export const GITHUB_URL = "https://github.com/BLamy/electric-forest";

/** One chunk per task readme; the roadmap list never pays for 3 MB of specs. */
const taskBodies = import.meta.glob<string>("../../../../.eforest/tasks/epic-*/E*-T*/readme.md", {
  query: "?raw",
  import: "default",
});

export async function loadTaskReadme(folder: string): Promise<string | undefined> {
  const loader = taskBodies[`../../../../.eforest/tasks/${folder}/readme.md`];
  if (loader === undefined) return undefined;
  return loader();
}

export interface DocPage {
  /** Route slug under `/docs/`, e.g. `concepts/streams-not-git`. */
  readonly slug: string;
  readonly title: string;
  readonly section: string;
  readonly order: number;
  readonly summary: string;
  readonly body: string;
}

const docSources = import.meta.glob<string>("../../../../docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const SECTION_ORDER = ["Start here", "Concepts", "Guides", "Doctrine", "Reference"] as const;

function docPage(slug: string, text: string): DocPage {
  const { fields, body } = parseFrontmatter(text);
  const order = Number(fields["order"]);
  return {
    slug,
    title: fields["title"] ?? slug,
    section: fields["section"] ?? "Reference",
    order: Number.isFinite(order) ? order : 999,
    summary: fields["summary"] ?? "",
    body,
  };
}

function referencePage(
  slug: string,
  title: string,
  order: number,
  summary: string,
  body: string,
): DocPage {
  return { slug, title, section: "Reference", order, summary, body };
}

export const docPages: readonly DocPage[] = [
  ...Object.entries(docSources).map(([path, text]) =>
    docPage(path.replace(/^\.\.\/\.\.\/\.\.\/\.\.\/docs\//, "").replace(/\.md$/, ""), text),
  ),
  referencePage(
    "reference/architecture",
    "Runtime architecture",
    10,
    "The ownership boundary between electric-forest and Electric Durable Streams.",
    documents.architecture,
  ),
  referencePage(
    "reference/loop",
    "The loop (.eforest/loop.md)",
    20,
    "The builder / critic / progress-critic contract that builds this project.",
    documents.loop,
  ),
  referencePage(
    "reference/task-system",
    "The task system",
    30,
    "Task folders, the priority queue, and the adversarial verification protocol.",
    documents.taskSystem,
  ),
].sort((left, right) => {
  const section =
    SECTION_ORDER.indexOf(left.section as (typeof SECTION_ORDER)[number]) -
    SECTION_ORDER.indexOf(right.section as (typeof SECTION_ORDER)[number]);
  return section !== 0
    ? section
    : left.order - right.order || left.title.localeCompare(right.title);
});

export const docSections: readonly {
  readonly title: string;
  readonly pages: readonly DocPage[];
}[] = SECTION_ORDER.map((title) => ({
  title,
  pages: docPages.filter((page) => page.section === title),
})).filter((section) => section.pages.length > 0);

export type { Milestone } from "./ladder.js";

export function milestoneLadder(): readonly Milestone[] {
  return ladder(documents.roadmap);
}
