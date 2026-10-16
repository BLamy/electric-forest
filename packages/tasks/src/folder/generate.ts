/**
 * Deterministic generator of valid task folders for the round-trip property: every
 * folder it produces must parse, and parse -> render -> parse must be a fixed point.
 * Bodies deliberately include `---` lines, fences containing `## Goal`, indented
 * heading look-alikes, blank sections, and binary evidence with NUL bytes at nested
 * paths, plus random `work/` scratch that must never touch the durable digest.
 */
import { seededRandom } from "../generate.js";
import {
  TASK_ESTIMATES,
  TASK_FOLDER_STATUSES,
  TASK_SECTIONS,
  type FolderEntry,
  type TaskFolderSnapshot,
} from "./schema.js";

const WORDS = [
  "stream",
  "replay",
  "digest",
  "branch",
  "offset",
  "fence",
  "evidence",
  "critic",
  "builder",
  "canonical",
];
const TITLE_SPICE = [
  "ef status: classify",
  "A #hash title",
  " leading space",
  "- dash first",
  '"quoted" word',
  "plain title",
  "tail \\ backslash",
  "colon:tight",
];
const BODY_LINES = [
  "---",
  "```",
  "## Goal",
  "   ## Goal",
  "##Goal",
  "### Sub heading",
  "- [ ] a box",
  "~~~md",
  "text with `## Context` inline",
  "",
  "    indented code",
  "# H1 inside body",
];

export function generateTaskFolder(seed: number): TaskFolderSnapshot {
  const random = seededRandom(seed);
  const int = (max: number): number => Math.floor(random() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const word = (): string => pick(WORDS);

  const epic = int(10);
  const task = 1 + int(99);
  const suffix = random() < 0.15 ? "abc"[int(3)]! : "";
  const id = `E${epic}-T${String(task).padStart(2, "0")}${suffix}`;
  const slugWords = 1 + int(4);
  const slug = Array.from({ length: slugWords }, () =>
    random() < 0.2 ? String(int(100)) : word(),
  ).join("-");
  const folderName = `${id}-${slug}`;

  const title =
    random() < 0.4 ? pick(TITLE_SPICE) : Array.from({ length: 2 + int(6) }, word).join(" ");
  const priority =
    random() < 0.2 ? `${epic * 100 + task}.${1 + int(9)}` : String(epic * 100 + task);
  const dependsCount = int(4);
  const depends = new Set<string>();
  while (depends.size < dependsCount) {
    depends.add(
      random() < 0.3 ? `E${int(9)}` : `E${int(9)}-T${String(1 + int(20)).padStart(2, "0")}`,
    );
  }

  const frontmatter = [
    "---",
    `id: ${id}`,
    `epic: ${epic}`,
    `title: ${quoteForGenerator(title)}`,
    `priority: ${priority}`,
    `status: ${pick(TASK_FOLDER_STATUSES)}`,
    `depends_on: [${[...depends].join(", ")}]`,
    `estimate: ${pick(TASK_ESTIMATES)}`,
    `capstone: ${random() < 0.2 ? "true" : "false"}`,
    "---",
  ];
  const body: string[] = [];
  if (random() < 0.5) body.push("");
  for (const section of TASK_SECTIONS) {
    body.push(`## ${section}`);
    const lineCount = section === "Verification log" && random() < 0.5 ? 0 : int(8);
    let fenceOpen: string | undefined;
    for (let index = 0; index < lineCount; index += 1) {
      const line =
        random() < 0.5 ? pick(BODY_LINES) : Array.from({ length: 1 + int(8) }, word).join(" ");
      if (line === "```" || line === "~~~md") {
        if (fenceOpen === undefined) {
          fenceOpen = line.slice(0, 3);
          body.push(line);
        } else if (line.startsWith(fenceOpen)) {
          body.push(fenceOpen);
          fenceOpen = undefined;
        }
        continue;
      }
      // Heading look-alikes only appear inside a fence, where they are inert.
      if ((line === "## Goal" || line === "   ## Goal") && fenceOpen === undefined) {
        body.push("```", line, "```");
        continue;
      }
      body.push(line);
    }
    if (fenceOpen !== undefined) body.push(fenceOpen);
    if (random() < 0.7) body.push("");
  }
  const readme = `${frontmatter.join("\n")}\n${body.join("\n")}${body.length > 0 ? "\n" : ""}`;

  const entries: FolderEntry[] = [
    { path: "readme.md", kind: "file", bytes: new TextEncoder().encode(readme) },
  ];
  const used = new Set<string>();
  const evidenceCount = int(5);
  for (let index = 0; index < evidenceCount; index += 1) {
    const depth = 1 + int(3);
    const segments = Array.from({ length: depth }, () => `${word()}${int(10)}`);
    const path = `evidence/${segments.join("/")}${pick([".bin", ".txt", ".jsonl", ""])}`;
    if (
      used.has(path.toLowerCase()) ||
      [...used].some(
        (other) =>
          path.toLowerCase().startsWith(`${other}/`) || other.startsWith(`${path.toLowerCase()}/`),
      )
    )
      continue;
    used.add(path.toLowerCase());
    entries.push({ path, kind: "file", bytes: randomBytes(random, int(64)) });
  }
  const workCount = int(3);
  for (let index = 0; index < workCount; index += 1) {
    const path = `work/${word()}-${index}.tmp`;
    entries.push({ path, kind: "file", bytes: randomBytes(random, int(32)) });
  }
  return { folderName, entries };
}

function quoteForGenerator(title: string): string {
  const needsQuote =
    title !== title.trim() ||
    /^["'[\]{}&*!|>%@`#,?:-]/.test(title) ||
    title.includes(": ") ||
    title.includes(" #") ||
    title.includes("\\");
  return needsQuote ? `"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : title;
}

function randomBytes(random: () => number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const roll = random();
    bytes[index] = roll < 0.15 ? 0 : roll < 0.2 ? 0xff : Math.floor(random() * 256);
  }
  return bytes;
}
