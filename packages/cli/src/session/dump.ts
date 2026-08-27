import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { readDurableJson } from "@eforest/client";
import { canonicalJson, isEvent } from "@eforest/protocol";
import { requireReducer } from "@eforest/reducers";
import { readDump } from "../replay-command.js";
import {
  parseSessionManifest,
  sessionDumpFileName,
  validateSession,
  type SessionDump,
  type SessionManifest,
  type SessionManifestEntry,
  type SessionRecord,
  type SessionRole,
  type ValidatedSession,
} from "./manifest.js";
import { replaySession, type SessionReplayResult } from "./replay.js";

export type SessionDumpFailureCode =
  | "session/bad-directory"
  | "session/bad-stream-file"
  | "session/out-exists"
  | "session/read-failed"
  | "session/invalid-server-record"
  | "session/namespace-escape"
  | "session/closure-limit"
  | "session/digest-mismatch"
  | "session/write-failed";

export class SessionDumpError extends Error {
  constructor(
    readonly code: SessionDumpFailureCode,
    message: string,
    readonly stream?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SessionDumpError";
  }
}

export interface SessionReplayIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CaptureSessionOptions {
  readonly server: string;
  readonly root: string;
  readonly out: string;
  readonly fetch?: typeof fetch;
  readonly maxStreams?: number;
}

export interface CaptureSessionResult {
  readonly directory: string;
  readonly manifest: SessionManifest;
  readonly replay: SessionReplayResult;
}

function fail(code: SessionDumpFailureCode, message: string, stream?: string): never {
  throw new SessionDumpError(code, message, stream);
}

function normalizeServer(server: string): string {
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    fail("session/read-failed", `invalid server URL ${JSON.stringify(server)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("session/read-failed", "server URL must use http or https");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function streamUrl(server: string, stream: string): string {
  return `${server}/streams/${encodeURIComponent(stream)}`;
}

function recordFromServer(value: unknown, stream: string, index: number): SessionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("session/invalid-server-record", `record ${index} is not an object`, stream);
  }
  const candidate = value as Record<string, unknown>;
  const event = { type: candidate.type, payload: candidate.payload, ts: candidate.ts };
  if (typeof candidate.offset !== "string" || !isEvent(event)) {
    fail(
      "session/invalid-server-record",
      `record ${index} has no opaque offset or valid event envelope`,
      stream,
    );
  }
  return { offset: candidate.offset, ...event };
}

async function readServerDump(
  server: string,
  stream: string,
  fetcher?: typeof fetch,
): Promise<SessionDump> {
  let values: readonly unknown[];
  try {
    values = await readDurableJson<unknown>({
      url: streamUrl(server, stream),
      ...(fetcher === undefined ? {} : { fetch: fetcher }),
    });
  } catch (error) {
    fail(
      "session/read-failed",
      `cannot read ${stream}: ${error instanceof Error ? error.message : String(error)}`,
      stream,
    );
  }
  if (values.length === 0) fail("session/read-failed", `stream ${stream} is empty`, stream);
  return values.map((value, index) => recordFromServer(value, stream, index));
}

function namespaceForEntityStream(stream: string): string | undefined {
  const match = /^(?:pr|issue):([^/]+\/[^/]+)\/.+$/.exec(stream);
  return match?.[1];
}

function streamNamespace(stream: string): string | undefined {
  const entity = /^(?:pr|issue|evidence|evidence-content):([^/]+\/[^/]+)\/.+$/.exec(stream);
  if (entity !== null) return entity[1];
  return /^fs:([^/]+\/[^:]+):[^:]+:meta$/.exec(stream)?.[1];
}

function memberShape(stream: string): { readonly role: SessionRole; readonly reducer: string } {
  if (/^pr:[^/]+\/[^/]+\/.+$/.test(stream)) return { role: "pr", reducer: "pr" };
  if (/^issue:[^/]+\/[^/]+\/.+$/.test(stream)) return { role: "issue", reducer: "issue" };
  if (/^evidence-content:[^/]+\/[^/]+\/.+$/.test(stream)) {
    return { role: "attachment", reducer: "evidence-content" };
  }
  if (/^evidence:[^/]+\/[^/]+\/(?:issue|pr)\/.+$/.test(stream)) {
    return { role: "attachment", reducer: "evidence" };
  }
  if (/^fs:[^/]+\/[^:]+:wiki:meta$/.test(stream)) {
    return { role: "wiki", reducer: "streamfs" };
  }
  if (/^fs:[^/]+\/[^:]+:[^:]+:meta$/.test(stream)) {
    return { role: "branch", reducer: "streamfs" };
  }
  fail("session/read-failed", `no registered session role for ${stream}`, stream);
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function entityStreams(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    return candidate.entity === "issue" && typeof candidate.stream === "string"
      ? [candidate.stream]
      : [];
  });
}

function referencedStreams(records: SessionDump): readonly string[] {
  const result = new Set<string>();
  for (const record of records) {
    const payload =
      record.payload !== null &&
      typeof record.payload === "object" &&
      !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : undefined;
    if (payload === undefined) continue;
    if (record.type === "pr.opened") {
      const source = stringField(payload, "sourceBranch");
      const target = stringField(payload, "targetBranch");
      if (source !== undefined) result.add(source);
      if (target !== undefined) result.add(target);
      for (const stream of entityStreams(payload.closes)) result.add(stream);
    } else if (record.type === "pr.link-closed" || record.type === "pr.link-noop") {
      for (const stream of entityStreams([payload.ref])) result.add(stream);
    } else if (record.type === "issue.linked") {
      const stream = stringField(payload.by, "stream");
      if (stream !== undefined) result.add(stream);
    } else if (record.type === "issue.state-changed") {
      const stream = stringField(payload.via, "prStream");
      if (stream !== undefined) result.add(stream);
    } else if (record.type === "evidence.attached") {
      const stream = stringField(payload, "contentStream");
      if (stream !== undefined) result.add(stream);
    } else if (record.type === "fs.branch.fork") {
      const stream = stringField(payload, "parentStreamId");
      if (stream !== undefined) result.add(stream);
    }
  }
  return [...result].sort();
}

function derivedRootMembers(root: string, namespace: string): readonly string[] {
  const entity = /^(pr|issue):[^/]+\/[^/]+\/(.+)$/.exec(root);
  if (entity === null) return [];
  return [`evidence:${namespace}/${entity[1]}/${entity[2]}`, `fs:${namespace}:wiki:meta`];
}

function ensureNamespace(stream: string, namespace: string): void {
  const actual = streamNamespace(stream);
  if (actual !== namespace) {
    fail(
      "session/namespace-escape",
      `reference ${stream} leaves root namespace ${namespace}`,
      stream,
    );
  }
}

function outputLines(result: SessionReplayResult): string {
  const streams = result.streams.map(
    ({ stream, role, head, digest }) =>
      `SESSION stream=${stream} role=${role} head=${head} digest=${digest} OK`,
  );
  return [
    ...streams,
    `LINKS resolved=${result.links.resolved} unresolved=0 OK`,
    `COMPOSITE digest=${result.digest}`,
  ].join("\n");
}

function failureLine(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const context = error as Error & {
    readonly stream?: unknown;
    readonly offset?: unknown;
    readonly rule?: unknown;
  };
  return [
    error.message,
    ...(typeof context.stream === "string" ? [`stream=${context.stream}`] : []),
    ...(typeof context.offset === "string" ? [`offset=${context.offset}`] : []),
    ...(typeof context.rule === "number" ? [`rule=${context.rule}`] : []),
  ].join(" ");
}

/** Load, inventory-check, and head-check one committed session directory. */
export async function loadSessionDirectory(directory: string): Promise<ValidatedSession> {
  const root = resolve(directory);
  let names: readonly string[];
  let manifestText: string;
  try {
    [names, manifestText] = await Promise.all([
      readdir(root),
      readFile(join(root, "session.json"), "utf8"),
    ]);
  } catch (error) {
    fail(
      "session/bad-directory",
      `cannot read session directory ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parseSessionManifest(manifestText);
  const dumpNames = names.filter((name) => name.endsWith(".events.jsonl")).sort();
  const dumps = new Map<string, SessionDump>();
  for (const name of dumpNames) {
    const encoded = name.slice(0, -".events.jsonl".length);
    let stream: string;
    try {
      stream = decodeURIComponent(encoded);
    } catch {
      fail("session/bad-stream-file", `dump filename ${name} has invalid percent-encoding`);
    }
    if (sessionDumpFileName(stream) !== name || dumps.has(stream)) {
      fail("session/bad-stream-file", `dump filename ${name} is not canonically derived`, stream);
    }
    let records;
    try {
      records = await readDump(join(root, name));
    } catch (error) {
      fail(
        "session/bad-stream-file",
        `stream ${stream}: ${error instanceof Error ? error.message : String(error)}`,
        stream,
      );
    }
    dumps.set(
      stream,
      records.map(({ line: _line, ...record }) => record),
    );
  }
  return validateSession(manifest, dumps);
}

/** Pure replay wrapped with directory I/O; output is emitted only after all links resolve. */
export async function replaySessionDirectory(directory: string): Promise<SessionReplayResult> {
  const result = replaySession(await loadSessionDirectory(directory), requireReducer);
  let expectedText: string;
  try {
    expectedText = await readFile(join(resolve(directory), "expected.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  let expected: unknown;
  try {
    expected = JSON.parse(expectedText);
  } catch (error) {
    fail(
      "session/digest-mismatch",
      `expected.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    fail("session/digest-mismatch", "expected.json must be an object");
  }
  const golden = expected as {
    readonly composite?: unknown;
    readonly links?: { readonly resolved?: unknown };
    readonly streams?: readonly { readonly stream?: unknown; readonly digest?: unknown }[];
  };
  const expectedStreams = new Map(
    Array.isArray(golden.streams)
      ? golden.streams.flatMap((entry) =>
          typeof entry.stream === "string" && typeof entry.digest === "string"
            ? [[entry.stream, entry.digest] as const]
            : [],
        )
      : [],
  );
  for (const stream of result.streams) {
    const expectedDigest = expectedStreams.get(stream.stream);
    if (expectedDigest !== stream.digest) {
      fail(
        "session/digest-mismatch",
        `stream ${stream.stream} expected digest ${expectedDigest ?? "<missing>"}, received ${stream.digest}`,
        stream.stream,
      );
    }
  }
  if (golden.links?.resolved !== result.links.resolved) {
    fail(
      "session/digest-mismatch",
      `expected ${String(golden.links?.resolved)} resolved links, received ${result.links.resolved}`,
    );
  }
  if (golden.composite !== result.digest) {
    fail(
      "session/digest-mismatch",
      `expected composite ${String(golden.composite)}, received ${result.digest}`,
    );
  }
  return result;
}

export async function runSessionReplay(directory: string, io: SessionReplayIo): Promise<number> {
  try {
    const result = await replaySessionDirectory(directory);
    io.stdout(`${outputLines(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${failureLine(error)}\n`);
    return 1;
  }
}

/**
 * Walk one entity's bounded reference closure through official read-only stream
 * GETs, persist canonical files transactionally, and replay the result before
 * exposing the destination directory.
 */
export async function captureSession(
  options: CaptureSessionOptions,
): Promise<CaptureSessionResult> {
  const server = normalizeServer(options.server);
  const namespace = namespaceForEntityStream(options.root);
  if (namespace === undefined) {
    fail("session/read-failed", "session root must be a PR or issue stream", options.root);
  }
  const maxStreams = options.maxStreams ?? 128;
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 1) {
    fail("session/closure-limit", "maxStreams must be a positive integer");
  }

  const pending = [options.root, ...derivedRootMembers(options.root, namespace)];
  const queued = new Set(pending);
  const dumps = new Map<string, SessionDump>();
  while (pending.length > 0) {
    if (dumps.size >= maxStreams) {
      fail("session/closure-limit", `reference closure exceeds ${maxStreams} streams`);
    }
    const stream = pending.shift()!;
    ensureNamespace(stream, namespace);
    memberShape(stream);
    const records = await readServerDump(server, stream, options.fetch);
    dumps.set(stream, records);
    for (const referenced of referencedStreams(records)) {
      ensureNamespace(referenced, namespace);
      if (!queued.has(referenced)) {
        queued.add(referenced);
        pending.push(referenced);
      }
    }
    pending.sort();
  }

  const streams: SessionManifestEntry[] = [...dumps]
    .map(([stream, records]) => {
      const shape = memberShape(stream);
      return { stream, ...shape, head: records.at(-1)!.offset };
    })
    .sort((left, right) => (left.stream < right.stream ? -1 : left.stream > right.stream ? 1 : 0));
  const destination = resolve(options.out);
  try {
    await access(destination);
    fail("session/out-exists", `destination already exists: ${destination}`);
  } catch (error) {
    if (error instanceof SessionDumpError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(destination)}.tmp-`));
  const manifest: SessionManifest = {
    session: basename(destination),
    version: 1,
    root: options.root,
    streams,
  };
  try {
    await Promise.all([
      writeFile(join(staging, "session.json"), `${canonicalJson(manifest)}\n`, "utf8"),
      ...streams.map((entry) =>
        writeFile(
          join(staging, sessionDumpFileName(entry.stream)),
          `${dumps
            .get(entry.stream)!
            .map((record) => canonicalJson(record))
            .join("\n")}\n`,
          "utf8",
        ),
      ),
    ]);
    const replay = await replaySessionDirectory(staging);
    await rename(staging, destination);
    return { directory: destination, manifest, replay };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof Error) throw error;
    fail("session/write-failed", String(error));
  }
}

export async function runSessionCapture(
  options: CaptureSessionOptions,
  io: SessionReplayIo,
): Promise<number> {
  try {
    const result = await captureSession(options);
    io.stdout(`${outputLines(result.replay)}\nSESSION-DUMP out=${result.directory} OK\n`);
    return 0;
  } catch (error) {
    io.stderr(`${failureLine(error)}\n`);
    return 1;
  }
}
