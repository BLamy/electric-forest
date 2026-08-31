/**
 * E6-T05 ingest: turn one observed state of a task folder (a `TaskFolderSnapshot` read
 * from the branch tree at a specific offset) into a plan of validated dispatches,
 * refusal artifacts, and journal classifications. Pure: no clock, no filesystem, no
 * network — the sync engine executes the plan through its ports.
 *
 * The rules, in order:
 * 1. A folder that fails the E6-T02 parse is refused whole: a refusal artifact retains
 *    the offending bytes and, when the task already exists, authority is projected back.
 * 2. A folder with no task stream yet is a creation: `issue.opened` (body = canonical
 *    readme) + `task.spec-revised` (base `-1`) + the `capstone` label when flagged.
 * 3. Evidence is diffed against the live attachment list by path: added/changed bytes
 *    become one content upload + one `evidence.attached`; removed paths become
 *    `evidence.detached`. Content streams are addressed by the bytes' SHA-256; removing
 *    a reference never deletes content.
 * 4. New Verification-log entries with a structured heading dispatch their lifecycle
 *    event only when the structured fields validate AND the transition is legal on the
 *    simulated state. A builder heading claiming a critic verdict is refused
 *    (`log/role-kind-mismatch`) and can never produce `verified`.
 * 5. The frontmatter `status` is a request, never authority: when it disagrees with the
 *    simulated post-event status, a `status/illegal-edit` refusal artifact is planned
 *    and the canonical text carries the authoritative status.
 * 6. When the canonical text differs from the accepted spec text, exactly one
 *    `task.spec-revised` is planned, fenced on the previous revision offset.
 */
import { canonicalJson, sha256Hex, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { issueHasBeenOpened } from "@eforest/issues";
import {
  TASK_SPEC_NO_BASE,
  isTaskBranchStreamId,
  taskEvidenceStreamId,
  taskStreamId,
  type TaskActorRef,
  type TaskBranchRef,
  type TaskEvent,
  type TaskFinding,
  type TaskRole,
} from "../events.js";
import { applyTaskEvent, taskReducer } from "../reducer.js";
import { taskInitialStateFor, type TaskState } from "../state.js";
import { TASK_EVENT_VERSION } from "../version.js";
import { parseTaskFolder } from "./parse.js";
import { renderTaskReadme } from "./render.js";
import type { TaskSyncIngestKind } from "./journal.js";
import type {
  TaskFolderRefusal,
  TaskFolderSnapshot,
  TaskFolderV1,
  TaskFolderStatus,
  TaskSectionV1,
} from "./schema.js";

/** Attachment kind for an evidence path, by extension. Frozen mapping. */
export function evidenceKindForPath(path: string): "event-log" | "digest" | "rr-trace" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".digest") || lower.endsWith(".sha256")) return "digest";
  for (const extension of [".jsonl", ".json", ".txt", ".md", ".log"]) {
    if (lower.endsWith(extension)) return "event-log";
  }
  return "rr-trace";
}

export function evidenceMediaTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "application/json";
  for (const extension of [".txt", ".md", ".log", ".digest", ".sha256"]) {
    if (lower.endsWith(extension)) return "text/plain";
  }
  return "application/octet-stream";
}

/** A live content attachment as the ingest sees it: path (name) → id + digest. */
export interface LiveEvidenceRef {
  readonly attachmentId: string;
  readonly name: string;
  readonly sha256: string;
}

export interface PlannedContentUpload {
  readonly contentStreamId: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PlannedDispatch {
  readonly stream: string;
  readonly event: Event;
  /** Content that must exist (sealed, same SHA-256) before the event is dispatched. */
  readonly upload?: PlannedContentUpload;
  /** `claim` / `refutation` payload refs resolved against live state at dispatch time. */
  readonly resolve?: "claim" | "refutation";
  readonly label: string;
}

export interface PlannedRefusal {
  readonly reason: string;
  readonly path: string;
  readonly message: string;
  /** Bytes retained beside the refusal artifact (the rejected readme or evidence file). */
  readonly retain?: Uint8Array;
}

export interface TaskFolderIngestPlan {
  readonly kinds: readonly TaskSyncIngestKind[];
  readonly dispatches: readonly PlannedDispatch[];
  readonly refusals: readonly PlannedRefusal[];
  /** The canonical readme text this ingest accepted (authoritative status inside). */
  readonly canonicalReadme?: string;
  readonly folder?: TaskFolderV1;
}

export interface TaskFolderIngestContext {
  readonly org: string;
  readonly repo: string;
  readonly taskId: string;
  /** `<epic dir>/<folder name>` relative to `.eforest/tasks/`. */
  readonly folderPath: string;
  readonly snapshot: TaskFolderSnapshot;
  /** Replayed `tasks/v1` state of the task stream; undefined when the stream is empty. */
  readonly state?: TaskState;
  /** Live content attachments of the task's evidence list (detached ones excluded). */
  readonly liveEvidence: readonly LiveEvidenceRef[];
  /** Every attachment id ever used on the list, including detached tombstones. */
  readonly usedAttachmentIds: readonly string[];
  /** The engine's authenticated principal: `by.actor` of every lifecycle event. */
  readonly actor: string;
  readonly ts: number;
  /**
   * The revision lineage of the branch's readme bytes this write was made from: the
   * spec offset the branch reflected before this record (never the engine's refreshed
   * state — that is how two clients editing from one base cannot silently overwrite).
   */
  readonly base: Offset | typeof TASK_SPEC_NO_BASE;
  /** Provenance of the ingested record: the branch stream + fs offset. */
  readonly origin: TaskBranchRef;
  /** Folder-relative path of the record that triggered this ingest (`readme.md`, ...). */
  readonly changedPath: string;
}

/** One parsed Verification-log entry: the exact text plus its structured heading. */
export interface VerificationLogEntry {
  readonly text: string;
  readonly role?: TaskRole;
  readonly kind?: "started" | "claimed" | "refuted" | "rework-started" | "verified";
  readonly fields: ReadonlyMap<string, readonly string[]>;
}

const HEADING_PATTERN = /^### (.+?) — (.+?) — (.+)$/;
const KIND_BY_TOKEN = new Map<string, VerificationLogEntry["kind"]>([
  ["started", "started"],
  ["claimed", "claimed"],
  ["implemented", "claimed"],
  ["refuted", "refuted"],
  ["rework", "rework-started"],
  ["rework-started", "rework-started"],
  ["verified", "verified"],
]);
const FIELD_PATTERN = /^- (Run|Branch|Evidence|Summary|Finding): (.*)$/;

/** Split a Verification-log section body into entries at `### ` headings. */
export function parseVerificationLogEntries(body: string): readonly VerificationLogEntry[] {
  const entries: VerificationLogEntry[] = [];
  let current: string[] | undefined;
  for (const line of body.split("\n")) {
    if (line.startsWith("### ")) {
      if (current !== undefined) entries.push(entryOf(current));
      current = [line];
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  if (current !== undefined) entries.push(entryOf(current));
  return entries;
}

function entryOf(lines: readonly string[]): VerificationLogEntry {
  const text = lines.join("\n");
  const heading = HEADING_PATTERN.exec(lines[0]!);
  const fields = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const field = FIELD_PATTERN.exec(line);
    if (field === null) continue;
    const values = fields.get(field[1]!) ?? [];
    values.push(field[2]!.trim());
    fields.set(field[1]!, values);
  }
  if (heading === null) return { text, fields };
  const role = heading[2]!.trim();
  const kindToken = heading[3]!
    .trim()
    .replace(/^VERDICT: /, "")
    .split(/[\s,.;]+/)[0]!
    .toLowerCase();
  const kind = KIND_BY_TOKEN.get(kindToken);
  return {
    text,
    ...(role === "builder" || role === "critic" ? { role: role as TaskRole } : {}),
    ...(kind === undefined ? {} : { kind }),
    fields,
  };
}

function logSection(folder: Pick<TaskFolderV1, "readme">): TaskSectionV1 | undefined {
  return folder.readme.sections.find((section) => section.name === "Verification log");
}

/** The log entries of a readme text; empty when the text does not parse. */
export function logEntriesOfReadme(text: string): readonly VerificationLogEntry[] {
  const parsed = parseTaskFolderText(text);
  if (parsed === undefined) return [];
  const section = parsed.readme.sections.find((entry) => entry.name === "Verification log");
  return section === undefined ? [] : parseVerificationLogEntries(section.body);
}

function parseTaskFolderText(
  text: string,
):
  | { readonly frontmatter: TaskFolderV1["frontmatter"]; readonly readme: TaskFolderV1["readme"] }
  | undefined {
  if (text.length === 0) return undefined;
  const snapshot: TaskFolderSnapshot = {
    folderName: "E0-T00-x",
    entries: [{ path: "readme.md", kind: "file", bytes: new TextEncoder().encode(text) }],
  };
  const parsed = parseTaskFolder({ ...snapshot, folderName: folderNameOfText(text) ?? "E0-T00-x" });
  if (!parsed.ok) return undefined;
  return { frontmatter: parsed.folder.frontmatter, readme: parsed.folder.readme };
}

function folderNameOfText(text: string): string | undefined {
  const id = /^id: (E[0-9]+-T[0-9]{2}[a-z]?)$/m.exec(text)?.[1];
  return id === undefined ? undefined : `${id}-x`;
}

interface StructuredEventResult {
  readonly event?: TaskEvent;
  readonly resolve?: "claim" | "refutation";
  readonly refusal?: PlannedRefusal;
}

function refusal(reason: string, path: string, message: string): StructuredEventResult {
  return { refusal: { reason, path, message } };
}

function buildLifecycleEvent(
  entry: VerificationLogEntry,
  context: TaskFolderIngestContext,
  nameToId: ReadonlyMap<string, string>,
  ts: number,
): StructuredEventResult {
  const path = `${context.folderPath}/readme.md`;
  if (entry.role === undefined || entry.kind === undefined) {
    return refusal(
      "log/role-kind-mismatch",
      path,
      `unrecognized heading: ${entry.text.split("\n")[0]!}`,
    );
  }
  const requiredRole: TaskRole =
    entry.kind === "refuted" || entry.kind === "verified" ? "critic" : "builder";
  if (entry.role !== requiredRole) {
    return refusal(
      "log/role-kind-mismatch",
      path,
      `a ${entry.role} entry cannot record ${entry.kind}; only a ${requiredRole} can`,
    );
  }
  const one = (key: string): string | undefined => entry.fields.get(key)?.[0];
  const run = one("Run");
  if (run === undefined)
    return refusal("log/missing-field", path, `missing "- Run:" in ${entry.kind} entry`);
  const by: TaskActorRef = { actor: context.actor, role: entry.role, run };
  const stream = taskStreamId(context.org, context.repo, context.taskId);
  const evidenceStream = taskEvidenceStreamId(stream)!;
  if (entry.kind === "started") {
    return { event: { type: "task.started", payload: { v: TASK_EVENT_VERSION, by }, ts } };
  }
  if (entry.kind === "rework-started") {
    return {
      event: {
        type: "task.rework-started",
        payload: {
          v: TASK_EVENT_VERSION,
          by,
          refutation: { stream, offset: "0000000000000000_0000000000000000" as Offset },
        },
        ts,
      },
      resolve: "refutation",
    };
  }
  const branchText = one("Branch");
  const branchMatch = branchText === undefined ? null : /^(.+)@([0-9a-z_]+)$/.exec(branchText);
  if (
    branchMatch === null ||
    !isTaskBranchStreamId(branchMatch[1]!) ||
    !isWellFormedOffset(branchMatch[2]!)
  ) {
    return refusal(
      "log/invalid-branch",
      path,
      `missing or malformed "- Branch: <stream>@<offset>"`,
    );
  }
  const branch = { stream: branchMatch[1]!, head: branchMatch[2] as Offset };
  const evidenceText = one("Evidence");
  const names = (evidenceText ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    return refusal("log/missing-field", path, `missing "- Evidence:" in ${entry.kind} entry`);
  }
  const attachmentIds: string[] = [];
  for (const name of names) {
    const id = nameToId.get(name);
    if (id === undefined) {
      return refusal("log/unknown-evidence", path, `evidence path not attached: ${name}`);
    }
    if (!attachmentIds.includes(id)) attachmentIds.push(id);
  }
  const evidence = { stream: evidenceStream, attachmentIds };
  const claim = { stream, offset: "0000000000000000_0000000000000000" as Offset };
  if (entry.kind === "refuted") {
    const findings: TaskFinding[] = [];
    for (const value of entry.fields.get("Finding") ?? []) {
      const parts = value.split(" | ").map((part) => part.trim());
      if (parts.length !== 3) {
        return refusal(
          "log/invalid-finding",
          path,
          `finding is not "<fingerprint> | <citation> | <summary>"`,
        );
      }
      const [fingerprint, citationText, summary] = parts as [string, string, string];
      const at = /^(.+)@([0-9a-z_]+)$/.exec(citationText);
      const citation =
        at !== null && isWellFormedOffset(at[2]!)
          ? { stream: at[1]!, offset: at[2] as Offset }
          : nameToId.has(citationText)
            ? { stream: evidenceStream, attachmentId: nameToId.get(citationText)! }
            : undefined;
      if (citation === undefined) {
        return refusal(
          "log/invalid-finding",
          path,
          `finding citation unresolvable: ${citationText}`,
        );
      }
      findings.push({ fingerprint, summary, citation });
    }
    if (findings.length === 0) {
      return refusal("log/missing-field", path, `missing "- Finding:" in refuted entry`);
    }
    return {
      event: {
        type: "task.refuted",
        payload: { v: TASK_EVENT_VERSION, by, claim, branch, evidence, findings },
        ts,
      },
      resolve: "claim",
    };
  }
  const summary = one("Summary");
  if (summary === undefined) {
    return refusal("log/missing-field", path, `missing "- Summary:" in ${entry.kind} entry`);
  }
  if (entry.kind === "claimed") {
    return {
      event: {
        type: "task.claimed",
        payload: { v: TASK_EVENT_VERSION, by, branch, evidence, summary },
        ts,
      },
    };
  }
  return {
    event: {
      type: "task.verified",
      payload: { v: TASK_EVENT_VERSION, by, claim, branch, evidence, summary },
      ts,
    },
    resolve: "claim",
  };
}

/** Resolve a `claim`/`refutation` placeholder against the live state at dispatch time. */
export function resolveLifecycleReferences(event: TaskEvent, state: TaskState): TaskEvent {
  if (event.type === "task.refuted" || event.type === "task.verified") {
    const offset = state.currentClaim?.offset;
    if (offset === undefined) return event;
    return {
      ...event,
      payload: { ...event.payload, claim: { stream: state.stream, offset } },
    } as TaskEvent;
  }
  if (event.type === "task.rework-started") {
    const offset = state.attempts.at(-1)?.verdict?.offset;
    if (offset === undefined) return event;
    return {
      ...event,
      payload: { ...event.payload, refutation: { stream: state.stream, offset } },
    } as TaskEvent;
  }
  return event;
}

function refusalOfParse(
  parseRefusal: TaskFolderRefusal,
  snapshot: TaskFolderSnapshot,
): PlannedRefusal {
  const retained = snapshot.entries.find(
    (entry) =>
      entry.kind === "file" && (entry.path === parseRefusal.path || parseRefusal.path === "."),
  );
  return {
    reason: parseRefusal.reason,
    path: parseRefusal.path,
    message: parseRefusal.message,
    ...(retained?.bytes === undefined ? {} : { retain: retained.bytes }),
  };
}

const SIM_OFFSET = "0000000000000000_0000009999999999" as Offset;

/** The plan for one observed folder state. See the module doc for the rules. */
export function planTaskFolderIngest(context: TaskFolderIngestContext): TaskFolderIngestPlan {
  const kinds = new Set<TaskSyncIngestKind>();
  const dispatches: PlannedDispatch[] = [];
  const refusals: PlannedRefusal[] = [];
  const stream = taskStreamId(context.org, context.repo, context.taskId);
  const evidenceStream = taskEvidenceStreamId(stream)!;
  const opened = context.state !== undefined && issueHasBeenOpened(context.state.issue);

  const parsed = parseTaskFolder(context.snapshot);
  if (!parsed.ok) {
    kinds.add("refused");
    if (opened) kinds.add("restored");
    refusals.push(refusalOfParse(parsed.refusal, context.snapshot));
    return { kinds: [...kinds], dispatches, refusals };
  }
  const folder = parsed.folder;
  if (folder.id !== context.taskId) {
    kinds.add("refused");
    refusals.push({
      reason: "folder/name-invalid",
      path: ".",
      message: `folder id ${folder.id} does not match task ${context.taskId}`,
    });
    return { kinds: [...kinds], dispatches, refusals };
  }

  let sim: TaskState = context.state ?? taskInitialStateFor(stream, context.taskId);

  // Creation prelude: the issue is the task's identity; its body is the canonical text.
  // The simulation opens it through the real reducer so `issueHasBeenOpened` holds.
  if (!opened) {
    kinds.add("created");
    sim = taskReducer(sim, {
      type: "issue.opened",
      payload: { v: 1, title: folder.frontmatter.title, body: "" },
      ts: context.ts,
    });
  }

  // Evidence diff against the live attachment list, by path.
  const liveByName = new Map(context.liveEvidence.map((entry) => [entry.name, entry]));
  const usedIds = new Set(context.usedAttachmentIds);
  const nameToId = new Map(context.liveEvidence.map((entry) => [entry.name, entry.attachmentId]));
  const folderEvidence = new Map(folder.evidence.map((file) => [file.path, file]));
  for (const [name, live] of liveByName) {
    const present = folderEvidence.get(name);
    if (present !== undefined && present.sha256 === live.sha256) continue;
    kinds.add("evidence-removed");
    nameToId.delete(name);
    dispatches.push({
      stream: evidenceStream,
      event: {
        type: "evidence.detached",
        payload: { v: 1, attachmentId: live.attachmentId },
        ts: context.ts,
      },
      label: `evidence-removed:${name}`,
    });
  }
  for (const [name, file] of folderEvidence) {
    const live = liveByName.get(name);
    if (live !== undefined && live.sha256 === file.sha256) continue;
    kinds.add("evidence-added");
    let attachmentId = file.sha256;
    for (let ordinal = 2; usedIds.has(attachmentId); ordinal += 1) {
      attachmentId = `${file.sha256}-${ordinal}`;
    }
    usedIds.add(attachmentId);
    nameToId.set(name, attachmentId);
    const contentStreamId = `evidence-content:${context.org}/${context.repo}/${attachmentId}`;
    dispatches.push({
      stream: evidenceStream,
      event: {
        type: "evidence.attached",
        payload: {
          v: 1,
          attachmentId,
          kind: evidenceKindForPath(name),
          name,
          mediaType: evidenceMediaTypeForPath(name),
          size: file.size,
          sha256: file.sha256,
          contentStream: contentStreamId,
        },
        ts: context.ts,
      },
      upload: { contentStreamId, bytes: file.bytes, sha256: file.sha256 },
      label: `evidence-added:${name}`,
    });
  }

  // New Verification-log entries → lifecycle events, validated on the simulated state.
  const specText = opened ? (context.state!.spec?.readme ?? context.state!.issue.body) : "";
  // Entry identity ignores trailing blank lines: appending a new entry after an existing
  // one must not make the existing entry look new (it would be re-simulated and refused).
  const entryKey = (text: string): string => text.replace(/\s+$/, "");
  const previousEntries = new Set(
    logEntriesOfReadme(specText).map((entry) => entryKey(entry.text)),
  );
  const lifecycle: PlannedDispatch[] = [];
  const section = logSection(folder);
  const entries = section === undefined ? [] : parseVerificationLogEntries(section.body);
  for (const entry of entries) {
    if (previousEntries.has(entryKey(entry.text))) continue;
    if (
      entry.role === undefined &&
      entry.kind === undefined &&
      !HEADING_PATTERN.test(entry.text.split("\n")[0]!)
    ) {
      continue; // plain prose entry: text only, no lifecycle claim
    }
    const built = buildLifecycleEvent(entry, context, nameToId, context.ts);
    if (built.refusal !== undefined) {
      kinds.add("refused");
      refusals.push(built.refusal);
      continue;
    }
    const simulated = resolveLifecycleReferences(built.event!, sim);
    const transition = applyTaskEvent(sim, simulated, SIM_OFFSET);
    if (!transition.ok) {
      kinds.add("refused");
      refusals.push({
        reason: transition.reason,
        path: `${context.folderPath}/readme.md`,
        message: `log entry "${entry.text.split("\n")[0]!}" is not a legal transition`,
      });
      continue;
    }
    sim = transition.next;
    kinds.add("log-entry");
    lifecycle.push({
      stream,
      event: built.event!,
      ...(built.resolve === undefined ? {} : { resolve: built.resolve }),
      label: `lifecycle:${built.event!.type}`,
    });
  }

  // Status is a request: authority is the simulated post-event status. A stale status
  // (unchanged from the previous accepted text) is silently normalized; only an actual
  // edit that authority does not back is refused.
  const authoritative = sim.status as TaskFolderStatus;
  const previousStatusText = opened
    ? (parseTaskFolderText(specText)?.frontmatter.status ?? context.state!.status)
    : "pending";
  const statusRefused =
    folder.frontmatter.status !== authoritative && folder.frontmatter.status !== previousStatusText;
  if (statusRefused) {
    kinds.add("refused");
    kinds.add("restored");
    const readmeBytes = context.snapshot.entries.find((entry) => entry.path === "readme.md")?.bytes;
    refusals.push({
      reason: "status/illegal-edit",
      path: `${context.folderPath}/readme.md`,
      message: `frontmatter status ${JSON.stringify(folder.frontmatter.status)} is not backed by a legal event; authoritative status is ${JSON.stringify(authoritative)}`,
      ...(readmeBytes === undefined ? {} : { retain: readmeBytes }),
    });
  }
  const canonicalReadme = renderTaskReadme({
    frontmatter: { ...folder.frontmatter, status: authoritative },
    readme: folder.readme,
  });

  // Creation dispatches first, then the fenced revision, then lifecycle events.
  if (!opened) {
    dispatches.unshift({
      stream,
      event: {
        type: "issue.opened",
        payload: { v: 1, title: folder.frontmatter.title, body: canonicalReadme },
        ts: context.ts,
      },
      label: "issue-opened",
    });
    if (folder.frontmatter.capstone) {
      dispatches.push({
        stream,
        event: { type: "issue.labeled", payload: { v: 1, label: "capstone" }, ts: context.ts },
        label: "capstone-label",
      });
    }
  } else {
    const labeled = context.state!.issue.labels.includes("capstone");
    if (folder.frontmatter.capstone !== labeled) {
      dispatches.push({
        stream,
        event: {
          type: folder.frontmatter.capstone ? "issue.labeled" : "issue.unlabeled",
          payload: { v: 1, label: "capstone" },
          ts: context.ts,
        },
        label: "capstone-label",
      });
    }
  }
  // Every foreign readme write is one revision (recording its branch origin), except a
  // pure status edit, which is a refused request and never a revision. Ingests triggered
  // by evidence records revise only when the readme text actually drifted.
  const statusOnlyEdit = statusRefused && canonicalReadme === specText;
  const readmeWrite = !opened || context.changedPath === "readme.md";
  if ((readmeWrite && !statusOnlyEdit) || (!readmeWrite && canonicalReadme !== specText)) {
    if (opened) kinds.add("revised");
    dispatches.push({
      stream,
      event: {
        type: "task.spec-revised",
        payload: {
          v: TASK_EVENT_VERSION,
          base: context.base,
          folder: context.folderPath,
          origin: context.origin,
          readme: canonicalReadme,
          sha256: sha256Hex(new TextEncoder().encode(canonicalReadme)),
        },
        ts: context.ts,
      },
      label: "spec-revised",
    });
  }
  dispatches.push(...lifecycle);
  if (kinds.size === 0) kinds.add("unchanged");
  return { kinds: [...kinds], dispatches, refusals, canonicalReadme, folder };
}

/** Canonical bytes of one refusal artifact (`work/.sync/...json`). */
export function refusalArtifactJson(input: {
  readonly offset: Offset;
  readonly reason: string;
  readonly path: string;
  readonly message: string;
  readonly retainedSha256?: string;
}): string {
  return `${canonicalJson({
    v: 1,
    offset: input.offset,
    reason: input.reason,
    path: input.path,
    message: input.message,
    ...(input.retainedSha256 === undefined ? {} : { retainedSha256: input.retainedSha256 }),
  })}\n`;
}
