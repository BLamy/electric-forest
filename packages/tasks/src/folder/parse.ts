/**
 * `parseTaskFolder`: snapshot -> TaskFolderV1 or one stable refusal. Pure: no I/O, no
 * clock, no randomness. The frontmatter reader is a deliberately tiny flat-YAML
 * subset — `key: value` lines, double-quoted or plain scalars, one inline list — so
 * duplicate keys, anchors, aliases, merge keys, block values, and tags are refused
 * rather than silently resolved the way a general YAML library would.
 */
import { sha256Hex } from "@eforest/protocol";
import { caseFoldKey, checkRelativePath, comparePaths, pathRefusal } from "./paths.js";
import {
  TASK_DEPENDENCY_PATTERN,
  TASK_ESTIMATES,
  TASK_FOLDER_STATUSES,
  TASK_FOLDER_VERSION,
  TASK_FRONTMATTER_KEYS,
  TASK_ID_PATTERN,
  TASK_PRIORITY_PATTERN,
  TASK_SECTIONS,
  TASK_SLUG_PATTERN,
  type EvidenceFileV1,
  type FolderEntry,
  type ReadmeSpan,
  type TaskEstimate,
  type TaskFolderParseResult,
  type TaskFolderRefusal,
  type TaskFolderRefusalReason,
  type TaskFolderSnapshot,
  type TaskFolderStatus,
  type TaskFrontmatterKey,
  type TaskFrontmatterV1,
  type TaskReadmeV1,
  type TaskSectionName,
  type TaskSectionV1,
  type WorkshopEntryV1,
} from "./schema.js";

/**
 * Sabotage sentinel for the critic's attack 5: this constant guards the duplicate-key
 * refusal. Removing the guard makes `id: A\nid: B` parse as whichever key wins, and the
 * committed ambiguous fixture in `evidence/fixtures/invalid/` turns verify-E6-T02 red.
 */
export const E6_T02_DUPLICATE_KEY_GUARD = true;

const README = "readme.md";
const FOLDER_NAME_PATTERN = /^(E(?:0|[1-9][0-9]*)-T[0-9]{2}[a-z]?)-(.+)$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const H2_PATTERN = /^ {0,3}##(?: |$)/;
const KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;
const PLAIN_TITLE_INDICATORS = new Set([
  '"',
  "'",
  "[",
  "]",
  "{",
  "}",
  "&",
  "*",
  "!",
  "|",
  ">",
  "%",
  "@",
  "`",
  "#",
  ",",
  "?",
  ":",
  "-",
]);

class Refusal extends Error {
  constructor(readonly refusal: TaskFolderRefusal) {
    super(`${refusal.reason} ${refusal.path}:${refusal.line}:${refusal.column} ${refusal.message}`);
  }
}

function refuseText(
  reason: TaskFolderRefusalReason,
  line: number,
  column: number,
  message: string,
): never {
  throw new Refusal({ reason, path: README, line, column, message });
}

function refusePath(reason: TaskFolderRefusalReason, path: string, message: string): never {
  throw new Refusal(pathRefusal(reason, path, message));
}

export function parseTaskFolder(snapshot: TaskFolderSnapshot): TaskFolderParseResult {
  try {
    return { ok: true, folder: parseOrThrow(snapshot) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

function parseOrThrow(snapshot: TaskFolderSnapshot) {
  const nameMatch = FOLDER_NAME_PATTERN.exec(snapshot.folderName);
  if (!nameMatch || !TASK_SLUG_PATTERN.test(nameMatch[2]!)) {
    refusePath(
      "folder/name-invalid",
      ".",
      `folder name ${JSON.stringify(snapshot.folderName)} is not <E<n>-T<nn>>-<kebab-slug>`,
    );
  }
  const id = nameMatch[1]!;
  const slug = nameMatch[2]!;

  const entries = [...snapshot.entries].sort((a, b) => comparePaths(a.path, b.path));
  const seenExact = new Set<string>();
  const seenFolded = new Map<string, string>();
  const directoryPrefixes = new Set<string>();
  let readme: FolderEntry | undefined;
  const evidenceEntries: FolderEntry[] = [];
  const workEntries: FolderEntry[] = [];

  for (const entry of entries) {
    const check = checkRelativePath(entry.path);
    if (!check.ok) refusePath(check.reason, entry.path, check.message);
    if (entry.kind === "symlink") refusePath("paths/symlink", entry.path, "symlinks are refused");
    if (entry.kind === "other") {
      refusePath("paths/unsupported-kind", entry.path, "not a regular file or directory");
    }
    if (seenExact.has(entry.path)) refusePath("paths/duplicate", entry.path, "listed twice");
    seenExact.add(entry.path);
    const folded = caseFoldKey(entry.path);
    const collision = seenFolded.get(folded);
    if (collision !== undefined) {
      refusePath(
        "paths/case-collision",
        entry.path,
        `collides with ${JSON.stringify(collision)} on a case-folding filesystem`,
      );
    }
    seenFolded.set(folded, entry.path);
    for (let depth = 1; depth < check.segments.length; depth += 1) {
      directoryPrefixes.add(check.segments.slice(0, depth).join("/"));
    }

    const [root] = check.segments;
    if (root === README && check.segments.length === 1) {
      if (entry.kind !== "file") {
        refusePath("folder/readme-not-file", entry.path, "readme.md must be a regular file");
      }
      readme = entry;
    } else if (root === "evidence") {
      if (entry.kind === "directory") {
        if (check.segments.length > 1) {
          refusePath("evidence/empty-directory", entry.path, "empty directories are not durable");
        }
      } else {
        evidenceEntries.push(entry);
      }
    } else if (root === "work") {
      if (entry.kind === "file") workEntries.push(entry);
    } else {
      refusePath(
        "folder/unexpected-entry",
        entry.path,
        "only readme.md, work/, and evidence/ may exist at the folder root",
      );
    }
  }
  for (const entry of entries) {
    if (entry.kind === "file" && directoryPrefixes.has(entry.path)) {
      refusePath("paths/duplicate", entry.path, "is both a file and a directory");
    }
    if (
      entry.kind === "directory" &&
      seenExact.has(entry.path) &&
      directoryPrefixes.has(entry.path)
    ) {
      refusePath("paths/duplicate", entry.path, "listed as empty but has children");
    }
  }
  if (readme === undefined) refusePath("folder/readme-missing", README, "readme.md is required");

  const parsedReadme = parseReadme(readme.bytes ?? new Uint8Array());
  if (parsedReadme.frontmatter.id !== id) {
    refuseText(
      "frontmatter/id-mismatch",
      parsedReadme.keyLines.id,
      1,
      `frontmatter id ${JSON.stringify(parsedReadme.frontmatter.id)} does not match folder ${JSON.stringify(snapshot.folderName)}`,
    );
  }
  const epicOfId = Number(TASK_ID_PATTERN.exec(id)![1]);
  if (parsedReadme.frontmatter.epic !== epicOfId) {
    refuseText(
      "frontmatter/epic-mismatch",
      parsedReadme.keyLines.epic,
      1,
      `epic ${parsedReadme.frontmatter.epic} does not match id ${id}`,
    );
  }

  const evidence: EvidenceFileV1[] = evidenceEntries.map((entry) => {
    const bytes = entry.bytes ?? new Uint8Array();
    return {
      path: entry.path.slice("evidence/".length),
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
      bytes,
    };
  });
  const work: WorkshopEntryV1[] = workEntries.map((entry) => {
    const bytes = entry.bytes ?? new Uint8Array();
    return {
      path: entry.path.slice("work/".length),
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
  });

  return {
    v: TASK_FOLDER_VERSION,
    folderName: snapshot.folderName,
    id,
    slug,
    frontmatter: parsedReadme.frontmatter,
    readme: parsedReadme.readme,
    evidence,
    work,
  };
}

/** Index of the first C0 control (other than TAB) or DEL, else -1. */
function firstControlCharacter(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return index;
  }
  return -1;
}

interface ParsedReadme {
  readonly frontmatter: TaskFrontmatterV1;
  readonly keyLines: Record<TaskFrontmatterKey, number>;
  readonly readme: TaskReadmeV1;
}

/** Parse the bytes of one `readme.md` on its own (used by the folder parser and tests). */
export function parseTaskReadme(
  bytes: Uint8Array,
):
  | { ok: true; frontmatter: TaskFrontmatterV1; readme: TaskReadmeV1 }
  | { ok: false; refusal: TaskFolderRefusal } {
  try {
    const parsed = parseReadme(bytes);
    return { ok: true, frontmatter: parsed.frontmatter, readme: parsed.readme };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

function parseReadme(bytes: Uint8Array): ParsedReadme {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    refuseText("readme/not-utf8", 0, 0, "readme.md is not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) refuseText("readme/bom", 1, 1, "byte-order mark is refused");
  const lines = text.split("\n");
  if (lines.at(-1) !== "") {
    refuseText(
      "readme/no-trailing-newline",
      lines.length,
      lines.at(-1)!.length + 1,
      "readme.md must end with a newline",
    );
  }
  lines.pop();
  for (const [index, line] of lines.entries()) {
    const cr = line.indexOf("\r");
    if (cr >= 0)
      refuseText("readme/crlf", index + 1, cr + 1, "carriage return is refused (LF only)");
    const control = firstControlCharacter(line);
    if (control >= 0) {
      refuseText(
        "readme/control-character",
        index + 1,
        control + 1,
        `control character U+${line.charCodeAt(control).toString(16).padStart(4, "0")}`,
      );
    }
  }

  const { frontmatter, keyLines, closeLine } = parseFrontmatter(lines);
  const encoder = new TextEncoder();
  const lineStartBytes: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStartBytes.push(offset);
    offset += encoder.encode(line).byteLength + 1;
  }
  lineStartBytes.push(offset);
  const readme = parseSections(lines, closeLine + 1, lineStartBytes);
  return { frontmatter, keyLines, readme };
}

function parseFrontmatter(lines: readonly string[]) {
  if (lines[0] !== "---")
    refuseText("frontmatter/missing-open", 1, 1, "readme.md must open with a `---` line");
  const values = new Map<TaskFrontmatterKey, { raw: string; line: number; column: number }>();
  let closeLine = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    if (line === "---") {
      closeLine = index;
      break;
    }
    if (line === "...")
      refuseText(
        "frontmatter/missing-close",
        lineNumber,
        1,
        "document end marker `...` is refused; close with `---`",
      );
    const tab = line.indexOf("\t");
    if (tab >= 0)
      refuseText("frontmatter/tab", lineNumber, tab + 1, "tabs are refused in frontmatter");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line !== line.trimStart()) {
      refuseText(
        "frontmatter/non-flat",
        lineNumber,
        1,
        "indented line: frontmatter values must be flat and inline",
      );
    }
    if (line.startsWith("- "))
      refuseText(
        "frontmatter/non-flat",
        lineNumber,
        1,
        "block sequence item: frontmatter values must be inline",
      );
    if (line.startsWith("<<"))
      refuseText("frontmatter/anchor", lineNumber, 1, "merge keys are refused");
    const keyMatch = KEY_PATTERN.exec(line);
    if (!keyMatch) refuseText("frontmatter/malformed-line", lineNumber, 1, "expected `key: value`");
    const key = keyMatch[1]!;
    const rest = keyMatch[2]!;
    if (rest !== "" && !rest.startsWith(" ")) {
      refuseText(
        "frontmatter/malformed-line",
        lineNumber,
        key.length + 2,
        "expected a space after `:`",
      );
    }
    if (!(TASK_FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      refuseText("frontmatter/unknown-key", lineNumber, 1, `unknown key ${JSON.stringify(key)}`);
    }
    const known = key as TaskFrontmatterKey;
    if (E6_T02_DUPLICATE_KEY_GUARD && values.has(known)) {
      refuseText(
        "frontmatter/duplicate-key",
        lineNumber,
        1,
        `duplicate key ${JSON.stringify(key)} (first at line ${values.get(known)!.line})`,
      );
    }
    const valueColumn = key.length + 2 + 1;
    const stripped = stripComment(rest.slice(1), lineNumber, valueColumn);
    values.set(known, {
      raw: stripped.value,
      line: lineNumber,
      column: valueColumn + stripped.leading,
    });
  }
  if (closeLine < 0)
    refuseText("frontmatter/missing-close", lines.length, 1, "frontmatter never closed with `---`");
  for (const key of TASK_FRONTMATTER_KEYS) {
    if (!values.has(key))
      refuseText("frontmatter/missing-key", closeLine + 1, 1, `missing key ${JSON.stringify(key)}`);
  }
  const get = (key: TaskFrontmatterKey) => values.get(key)!;
  const scalar = (key: TaskFrontmatterKey): string => {
    const { raw, line, column } = get(key);
    checkInline(raw, line, column, key);
    if (/[ \t]/.test(raw) || raw.startsWith('"')) {
      refuseText("frontmatter/invalid-value", line, column, `${key} must be a bare scalar`);
    }
    return raw;
  };

  const id = scalar("id");
  if (!TASK_ID_PATTERN.test(id))
    refuseText(
      "frontmatter/invalid-value",
      get("id").line,
      get("id").column,
      `id ${JSON.stringify(id)} is not E<n>-T<nn>`,
    );
  const epicRaw = scalar("epic");
  if (!/^(0|[1-9][0-9]*)$/.test(epicRaw))
    refuseText(
      "frontmatter/invalid-value",
      get("epic").line,
      get("epic").column,
      "epic must be a non-negative integer",
    );
  const title = parseTitle(get("title").raw, get("title").line, get("title").column);
  const priority = scalar("priority");
  if (!TASK_PRIORITY_PATTERN.test(priority))
    refuseText(
      "frontmatter/invalid-value",
      get("priority").line,
      get("priority").column,
      "priority must be a decimal literal without leading or trailing zeros",
    );
  const status = scalar("status");
  if (!(TASK_FOLDER_STATUSES as readonly string[]).includes(status))
    refuseText(
      "frontmatter/invalid-value",
      get("status").line,
      get("status").column,
      `status must be one of ${TASK_FOLDER_STATUSES.join("|")}`,
    );
  const dependsOn = parseDependsOn(
    get("depends_on").raw,
    get("depends_on").line,
    get("depends_on").column,
  );
  const estimate = scalar("estimate");
  if (!(TASK_ESTIMATES as readonly string[]).includes(estimate))
    refuseText(
      "frontmatter/invalid-value",
      get("estimate").line,
      get("estimate").column,
      "estimate must be S, M, or L",
    );
  const capstoneRaw = scalar("capstone");
  if (capstoneRaw !== "true" && capstoneRaw !== "false")
    refuseText(
      "frontmatter/invalid-value",
      get("capstone").line,
      get("capstone").column,
      "capstone must be true or false",
    );

  const keyLines = Object.fromEntries(
    TASK_FRONTMATTER_KEYS.map((key) => [key, get(key).line]),
  ) as Record<TaskFrontmatterKey, number>;
  const frontmatter: TaskFrontmatterV1 = {
    id,
    epic: Number(epicRaw),
    title,
    priority,
    status: status as TaskFolderStatus,
    depends_on: dependsOn,
    estimate: estimate as TaskEstimate,
    capstone: capstoneRaw === "true",
  };
  return { frontmatter, keyLines, closeLine };
}

/** Strip a trailing ` #comment` outside double quotes, then trim. Returns leading-space count. */
function stripComment(
  raw: string,
  line: number,
  column: number,
): { value: string; leading: number } {
  let inQuote = false;
  let end = raw.length;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inQuote) {
      if (char === "\\") index += 1;
      else if (char === '"') inQuote = false;
    } else if (char === '"' && raw.slice(0, index).trim() === "") {
      inQuote = true;
    } else if (char === "#" && (index === 0 || raw[index - 1] === " ")) {
      end = index;
      break;
    }
  }
  if (inQuote)
    refuseText("frontmatter/invalid-value", line, column, "unterminated double-quoted scalar");
  const before = raw.slice(0, end);
  const leading = before.length - before.trimStart().length;
  return { value: before.trim(), leading };
}

function checkInline(raw: string, line: number, column: number, key: string): void {
  if (raw === "")
    refuseText(
      "frontmatter/non-flat",
      line,
      column,
      `${key} has no inline value (block values are refused)`,
    );
  const first = raw[0]!;
  if (first === "&" || first === "*")
    refuseText("frontmatter/anchor", line, column, "anchors and aliases are refused");
  if (first === "!") refuseText("frontmatter/invalid-value", line, column, "tags are refused");
  if (first === "{" || first === "|" || first === ">")
    refuseText("frontmatter/non-flat", line, column, `${key} must be a flat scalar`);
  if (first === "[" && key !== "depends_on")
    refuseText("frontmatter/non-flat", line, column, `${key} must be a flat scalar, not a list`);
}

function parseTitle(raw: string, line: number, column: number): string {
  checkInline(raw, line, column, "title");
  if (raw.startsWith('"')) {
    let value = "";
    for (let index = 1; index < raw.length; index += 1) {
      const char = raw[index]!;
      if (char === "\\") {
        const next = raw[index + 1];
        if (next !== '"' && next !== "\\") {
          refuseText(
            "frontmatter/invalid-value",
            line,
            column + index,
            `unsupported escape \\${next ?? ""} (only \\" and \\\\)`,
          );
        }
        value += next;
        index += 1;
      } else if (char === '"') {
        if (index !== raw.length - 1)
          refuseText(
            "frontmatter/invalid-value",
            line,
            column + index + 1,
            "text after the closing quote",
          );
        if (value === "")
          refuseText("frontmatter/invalid-value", line, column, "title must not be empty");
        return value;
      } else {
        value += char;
      }
    }
    refuseText("frontmatter/invalid-value", line, column, "unterminated double-quoted title");
  }
  if (PLAIN_TITLE_INDICATORS.has(raw[0]!)) {
    refuseText(
      "frontmatter/invalid-value",
      line,
      column,
      `plain title may not start with ${JSON.stringify(raw[0])}; quote it`,
    );
  }
  if (raw.includes(": "))
    refuseText(
      "frontmatter/invalid-value",
      line,
      column + raw.indexOf(": "),
      "plain title contains `: `; quote it",
    );
  return raw;
}

function parseDependsOn(raw: string, line: number, column: number): readonly string[] {
  checkInline(raw, line, column, "depends_on");
  if (!raw.startsWith("["))
    refuseText("frontmatter/non-flat", line, column, "depends_on must be an inline list `[...]`");
  if (!raw.endsWith("]"))
    refuseText(
      "frontmatter/invalid-value",
      line,
      column + raw.length,
      "depends_on list is not closed with `]`",
    );
  const inner = raw.slice(1, -1);
  if (inner.trim() === "") return [];
  const items: string[] = [];
  let cursor = 1;
  for (const piece of inner.split(",")) {
    const item = piece.trim();
    const itemColumn = column + cursor + (piece.length - piece.trimStart().length);
    cursor += piece.length + 1;
    if (item === "")
      refuseText("frontmatter/invalid-value", line, itemColumn, "empty depends_on item");
    if (!TASK_DEPENDENCY_PATTERN.test(item))
      refuseText(
        "frontmatter/invalid-value",
        line,
        itemColumn,
        `dependency ${JSON.stringify(item)} is not a task or epic id`,
      );
    if (items.includes(item))
      refuseText("frontmatter/invalid-value", line, itemColumn, `duplicate dependency ${item}`);
    items.push(item);
  }
  return items;
}

interface HeadingHit {
  readonly name: string;
  readonly index: number;
}

function parseSections(
  lines: readonly string[],
  bodyStart: number,
  lineStartBytes: readonly number[],
): TaskReadmeV1 {
  const headings: HeadingHit[] = [];
  let fence: { char: string; length: number; line: number } | undefined;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.char &&
        fenceMatch[1]!.length >= fence.length &&
        fenceMatch[2]!.trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length, line: index + 1 };
      continue;
    }
    if (H2_PATTERN.test(line)) {
      if (!line.startsWith("## ")) {
        refuseText(
          "sections/unknown",
          index + 1,
          1,
          `H2 heading ${JSON.stringify(line)} is not exactly \`## <Section>\``,
        );
      }
      headings.push({ name: line.slice(3), index });
    }
  }
  if (fence)
    refuseText(
      "sections/unterminated-fence",
      fence.line,
      1,
      "code fence never closed; headings after it are ambiguous",
    );

  for (const hit of headings) {
    if (!(TASK_SECTIONS as readonly string[]).includes(hit.name)) {
      refuseText(
        "sections/unknown",
        hit.index + 1,
        1,
        `unknown section ${JSON.stringify(hit.name)}`,
      );
    }
  }
  const names = headings.map((hit) => hit.name);
  for (
    let position = 0;
    position < TASK_SECTIONS.length || position < names.length;
    position += 1
  ) {
    const expected = TASK_SECTIONS[position];
    const found = names[position];
    if (expected === found) continue;
    if (found === undefined) {
      refuseText("sections/missing", lines.length + 1, 1, `missing section \`## ${expected}\``);
    }
    const hit = headings[position]!;
    if (names.slice(0, position).includes(found)) {
      refuseText("sections/duplicate", hit.index + 1, 1, `duplicate section \`## ${found}\``);
    }
    if (expected !== undefined && names.includes(expected)) {
      refuseText(
        "sections/out-of-order",
        hit.index + 1,
        1,
        `expected \`## ${expected}\` before \`## ${found}\``,
      );
    }
    refuseText(
      "sections/missing",
      hit.index + 1,
      1,
      `missing section \`## ${expected}\` before \`## ${found}\``,
    );
  }

  const span = (startLine: number, endLine: number): ReadmeSpan => ({
    startLine: startLine + 1,
    endLine,
    startByte: lineStartBytes[startLine]!,
    endByte: lineStartBytes[endLine]!,
  });
  const slice = (start: number, end: number): string =>
    start >= end ? "" : `${lines.slice(start, end).join("\n")}\n`;
  const preamble = slice(bodyStart, headings[0]!.index);
  const sections: TaskSectionV1[] = headings.map((hit, position) => {
    const next = headings[position + 1]?.index ?? lines.length;
    return {
      name: hit.name as TaskSectionName,
      heading: span(hit.index, hit.index + 1),
      body: slice(hit.index + 1, next),
      span: span(hit.index, next),
    };
  });
  return { preamble, sections };
}
