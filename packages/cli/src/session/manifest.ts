import { canonicalJson, type Event } from "@eforest/protocol";

export const SESSION_MANIFEST_VERSION = 1 as const;
export const SESSION_ROLES = ["issue", "branch", "wiki", "pr", "attachment"] as const;

export type SessionRole = (typeof SESSION_ROLES)[number];

export interface SessionManifestEntry {
  readonly stream: string;
  readonly role: SessionRole;
  readonly reducer: string;
  readonly head: string;
}

export interface SessionManifest {
  readonly session: string;
  readonly version: typeof SESSION_MANIFEST_VERSION;
  readonly root: string;
  readonly streams: readonly SessionManifestEntry[];
}

export interface SessionRecord extends Event {
  readonly offset: string;
}

export type SessionDump = readonly SessionRecord[];

export interface ValidatedSession {
  readonly manifest: SessionManifest;
  readonly dumps: ReadonlyMap<string, SessionDump>;
}

export type SessionManifestFailureCode =
  | "session/head-mismatch"
  | "session/unknown-role"
  | "session/orphan-dump"
  | "session/missing-dump"
  | "session/duplicate-stream"
  | "session/bad-root"
  | "session/invalid-manifest";

export interface SessionManifestFailureContext {
  readonly stream?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export class SessionManifestError extends TypeError {
  readonly stream: string | undefined;
  readonly expected: string | undefined;
  readonly actual: string | undefined;

  constructor(
    readonly code: SessionManifestFailureCode,
    message: string,
    context: SessionManifestFailureContext = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "SessionManifestError";
    this.stream = context.stream;
    this.expected = context.expected;
    this.actual = context.actual;
  }
}

function fail(
  code: SessionManifestFailureCode,
  message: string,
  context: SessionManifestFailureContext = {},
): never {
  throw new SessionManifestError(code, message, context);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJson(input: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    fail(
      "session/invalid-manifest",
      `session.json is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const encoded = canonicalJson(value);
    if (input !== encoded && input !== `${encoded}\n`) {
      fail("session/invalid-manifest", "session.json is not canonical JSON");
    }
  } catch (error) {
    if (error instanceof SessionManifestError) throw error;
    fail(
      "session/invalid-manifest",
      `session.json cannot be canonically encoded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return value;
}

function parseEntry(value: unknown, index: number): SessionManifestEntry {
  if (!isObject(value) || !hasExactKeys(value, ["stream", "role", "reducer", "head"])) {
    fail("session/invalid-manifest", `streams[${index}] has an invalid shape`);
  }
  if (
    typeof value.role === "string" &&
    !(SESSION_ROLES as readonly string[]).includes(value.role)
  ) {
    const context: SessionManifestFailureContext =
      typeof value.stream === "string"
        ? { stream: value.stream, actual: value.role }
        : { actual: value.role };
    fail("session/unknown-role", `streams[${index}] has unknown role ${value.role}`, context);
  }
  if (
    !nonEmptyString(value.stream) ||
    !(SESSION_ROLES as readonly unknown[]).includes(value.role) ||
    !nonEmptyString(value.reducer) ||
    !nonEmptyString(value.head)
  ) {
    fail("session/invalid-manifest", `streams[${index}] contains an invalid value`);
  }
  return {
    stream: value.stream,
    role: value.role as SessionRole,
    reducer: value.reducer,
    head: value.head,
  };
}

/**
 * Parse and normalize the frozen session manifest. String input must already be
 * canonical JSON; object input is useful to pure callers that decoded it earlier.
 */
export function parseSessionManifest(input: string | unknown): SessionManifest {
  const value = typeof input === "string" ? parseJson(input) : input;
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["session", "version", "root", "streams"]) ||
    !nonEmptyString(value.session) ||
    value.version !== SESSION_MANIFEST_VERSION ||
    !nonEmptyString(value.root) ||
    !Array.isArray(value.streams)
  ) {
    fail("session/invalid-manifest", "session.json has an invalid shape");
  }

  const streams = value.streams.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of streams) {
    if (seen.has(entry.stream)) {
      fail("session/duplicate-stream", `stream ${entry.stream} appears more than once`, {
        stream: entry.stream,
      });
    }
    seen.add(entry.stream);
  }
  if (!seen.has(value.root)) {
    fail("session/bad-root", `root ${value.root} is not a manifest member`, {
      stream: value.root,
    });
  }

  return {
    session: value.session,
    version: SESSION_MANIFEST_VERSION,
    root: value.root,
    streams: streams.sort((left, right) => compareCodeUnits(left.stream, right.stream)),
  };
}

/** Deterministic portable filename for one opaque stream id. */
export function sessionDumpFileName(streamId: string): string {
  return `${encodeURIComponent(streamId)}.events.jsonl`;
}

/**
 * Match a parsed dump inventory to the manifest and pin every manifest head to
 * the last record offset. Stream ids and offsets remain opaque strings.
 */
export function validateSession(
  manifestInput: string | unknown,
  dumps: ReadonlyMap<string, SessionDump>,
): ValidatedSession {
  const manifest = parseSessionManifest(manifestInput);
  const entries = new Map(manifest.streams.map((entry) => [entry.stream, entry]));

  for (const stream of [...dumps.keys()].sort(compareCodeUnits)) {
    if (!entries.has(stream)) {
      fail("session/orphan-dump", `dump ${sessionDumpFileName(stream)} has no manifest member`, {
        stream,
      });
    }
  }

  const normalized = new Map<string, SessionDump>();
  for (const entry of manifest.streams) {
    const records = dumps.get(entry.stream);
    if (records === undefined) {
      fail("session/missing-dump", `manifest member ${entry.stream} has no dump`, {
        stream: entry.stream,
      });
    }
    const last = records.at(-1);
    const actual = last === undefined || typeof last.offset !== "string" ? "<empty>" : last.offset;
    if (actual !== entry.head) {
      fail(
        "session/head-mismatch",
        `stream ${entry.stream} expected head ${entry.head}, received ${actual}`,
        { stream: entry.stream, expected: entry.head, actual },
      );
    }
    normalized.set(entry.stream, records);
  }

  return { manifest, dumps: normalized };
}
