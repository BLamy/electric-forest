import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, compareOffsets, type Event, type Offset } from "@eforest/protocol";
import { startServer, type StoreVariant } from "./harness.js";
import { serializeTranscript, type NormalizedExchange } from "./normalize.js";
import { repoRoot } from "./paths.js";
import { exchange, parseSseFrames, sseExchange } from "./transcript.js";

export interface CorpusOutcome {
  readonly id: string;
  readonly variant: StoreVariant;
  readonly status: number | readonly number[];
  readonly responses: readonly CorpusResponse[];
  readonly digestBefore: string;
  readonly digestAfter: string;
}

export interface VariantRun {
  readonly variant: StoreVariant;
  readonly baseUrl: string;
  readonly transcripts: Readonly<Record<string, string>>;
  readonly corpus: readonly CorpusOutcome[];
  readonly caseCount: number;
}

export interface ConformanceRun {
  readonly variants: readonly VariantRun[];
}

interface ResponseView {
  readonly exchange: NormalizedExchange;
  readonly status: number;
  readonly body: string;
}

export interface CorpusResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface RecordValue extends Event {
  readonly offset: Offset;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`invalid JSON response: ${body}`);
  }
}

function records(body: string): readonly RecordValue[] {
  const value = parseJson(body);
  assertCondition(Array.isArray(value), "expected a record array");
  return value as RecordValue[];
}

function event(type: string, payload: unknown, ts: number): Event {
  return { type, payload, ts };
}

function digest(capturedBody: string): string {
  const cli = resolve(repoRoot, "packages/cli/dist/src/bin.js");
  assertCondition(existsSync(cli), "ef replay build is missing; run the root build first");
  const directory = mkdtempSync(join(tmpdir(), "eforest-conformance-"));
  const captured = join(directory, "catch-up-response.json");
  const dump = join(directory, "dump.jsonl");
  try {
    writeFileSync(captured, capturedBody);
    const capturedRecords = records(readFileSync(captured, "utf8"));
    writeFileSync(dump, capturedRecords.map((record) => `${canonicalJson(record)}\n`).join(""));
    return execFileSync(process.execPath, [cli, "replay", dump, "--digest"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function call(
  baseUrl: string,
  name: string,
  path: string,
  init: RequestInit = {},
): Promise<ResponseView> {
  const result = await exchange(baseUrl, name, path, init);
  return { exchange: result, status: result.response.status, body: result.response.body };
}

function jsonInit(method: string, body: unknown, sequence?: number): RequestInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sequence !== undefined) headers["stream-seq"] = String(sequence);
  return { method, headers, body: typeof body === "string" ? body : JSON.stringify(body) };
}

async function createStream(baseUrl: string, streamId: string): Promise<void> {
  const result = await call(
    baseUrl,
    `setup-create-${streamId}`,
    `/streams/${streamId}`,
    jsonInit("PUT", { streamId }),
  );
  assertCondition(result.status === 201, `setup create failed: ${result.status}`);
}

async function appendStream(
  baseUrl: string,
  streamId: string,
  sequence: number,
  events: readonly Event[],
): Promise<ResponseView> {
  return call(
    baseUrl,
    `setup-append-${streamId}-${sequence}`,
    `/streams/${streamId}`,
    jsonInit("POST", { events }, sequence),
  );
}

interface DumpResult {
  readonly records: readonly RecordValue[];
  readonly rawBody: string;
}

async function dumpStream(baseUrl: string, streamId: string): Promise<DumpResult> {
  const result = await call(baseUrl, `dump-${streamId}`, `/streams/${streamId}?offset=-1`);
  assertCondition(result.status === 200, `dump failed: ${result.status}`);
  return { records: records(result.body), rawBody: result.body };
}

function stablePath(streamId: string, suffix = ""): string {
  return `/streams/${encodeURIComponent(streamId)}${suffix}`;
}

async function protocolTranscripts(baseUrl: string): Promise<Readonly<Record<string, string>>> {
  const transcriptMap = new Map<string, readonly NormalizedExchange[]>();
  const createCases: NormalizedExchange[] = [];
  const stream = "protocol-shape";
  const fresh = await call(
    baseUrl,
    "create-fresh",
    stablePath(stream),
    jsonInit("PUT", { name: "alpha", version: 1 }),
  );
  assertCondition(fresh.status === 201, "fresh create must be 201");
  createCases.push(fresh.exchange);
  const idempotent = await call(
    baseUrl,
    "create-idempotent",
    stablePath(stream),
    jsonInit("PUT", { name: "alpha", version: 1 }),
  );
  assertCondition(idempotent.status === 200, "idempotent create must be 200");
  createCases.push(idempotent.exchange);
  const conflict = await call(
    baseUrl,
    "create-conflict",
    stablePath(stream),
    jsonInit("PUT", { name: "alpha", version: 2 }),
  );
  assertCondition(
    conflict.status === 409,
    "create-and-append.http: conflicting create must be 409",
  );
  createCases.push(conflict.exchange);
  const firstAppend = await appendStream(baseUrl, stream, 0, [
    event("set", 1, 1),
    event("push", "a", 2),
  ]);
  assertCondition(firstAppend.status === 201, "first append must be 201");
  createCases.push(firstAppend.exchange);
  const stale = await appendStream(baseUrl, stream, 0, [event("push", "stale", 3)]);
  assertCondition(
    stale.status === 409 && stale.exchange.response.headers["stream-seq"] === "0",
    "stale append must expose sequence 0",
  );
  createCases.push(stale.exchange);
  const secondAppend = await appendStream(baseUrl, stream, 1, [event("increment", 2, 4)]);
  assertCondition(secondAppend.status === 201, "second append must be 201");
  createCases.push(secondAppend.exchange);
  transcriptMap.set("create-and-append.http", createCases);

  const readCases: NormalizedExchange[] = [];
  const all = await call(baseUrl, "read-all", stablePath(stream, "?offset=-1"));
  const allRecords = records(all.body);
  assertCondition(all.status === 200 && allRecords.length === 3, "read-all shape changed");
  readCases.push(all.exchange);
  const midOffset = allRecords[0]!.offset;
  const mid = await call(
    baseUrl,
    "read-mid",
    stablePath(stream, `?offset=${encodeURIComponent(midOffset)}`),
  );
  assertCondition(records(mid.body).length === 2, "mid-stream read must return a suffix");
  assertCondition(
    compareOffsets(records(mid.body)[0]!.offset, midOffset) > 0,
    "read must be strict-after",
  );
  readCases.push(mid.exchange);
  const headOffset = allRecords.at(-1)!.offset;
  const head = await call(
    baseUrl,
    "read-head",
    stablePath(stream, `?offset=${encodeURIComponent(headOffset)}`),
  );
  assertCondition(records(head.body).length === 0, "head read must be empty");
  readCases.push(head.exchange);
  const past = await call(
    baseUrl,
    "read-past-head",
    stablePath(stream, "?offset=9999999999999999_9999999999999999"),
  );
  assertCondition(
    past.status === 200 && records(past.body).length === 0,
    "past-head read must be empty",
  );
  readCases.push(past.exchange);
  for (const [name, path] of [
    ["read-bad-offset", stablePath(stream, "?offset=-2")],
    ["read-unsupported-live", stablePath(stream, "?offset=-1&live=bogus")],
    ["read-missing-stream", stablePath("missing", "?offset=-1")],
  ] as const) {
    const result = await call(baseUrl, name, path);
    assertCondition(
      result.status === (name === "read-missing-stream" ? 404 : 400),
      `${name} status drifted`,
    );
    readCases.push(result.exchange);
  }
  const malformedJson = await call(baseUrl, "append-malformed-json", stablePath(stream), {
    method: "POST",
    headers: { "content-type": "application/json", "stream-seq": "2" },
    body: "{",
  });
  assertCondition(malformedJson.status === 400, "malformed JSON must be 400");
  readCases.push(malformedJson.exchange);
  const malformedEvent = await call(
    baseUrl,
    "append-malformed-event",
    stablePath(stream),
    jsonInit("POST", { events: [{ type: "broken" }] }, 2),
  );
  assertCondition(malformedEvent.status === 400, "malformed event must be 400");
  readCases.push(malformedEvent.exchange);
  transcriptMap.set("read-and-errors.http", readCases);

  const timeoutCases: NormalizedExchange[] = [];
  const timeoutStream = "long-poll-timeout";
  await createStream(baseUrl, timeoutStream);
  const timeout = await call(
    baseUrl,
    "long-poll-timeout",
    stablePath(timeoutStream, "?offset=-1&live=long-poll"),
  );
  assertCondition(
    timeout.status === 204 &&
      timeout.body === "" &&
      timeout.exchange.response.headers["stream-next-offset"] === "-1",
    "long-poll timeout shape drifted",
  );
  timeoutCases.push(timeout.exchange);
  const wakeStream = "long-poll-wake";
  await createStream(baseUrl, wakeStream);
  const pendingWake = call(
    baseUrl,
    "long-poll-wake",
    stablePath(wakeStream, "?offset=-1&live=long-poll"),
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  const wakeAppend = await appendStream(baseUrl, wakeStream, 0, [event("push", "wake", 5)]);
  const wake = await pendingWake;
  assertCondition(wake.status === 200 && records(wake.body).length === 1, "long-poll wake failed");
  const returnedOffset = wake.exchange.response.headers["stream-next-offset"];
  assertCondition(returnedOffset !== undefined, "long-poll wake omitted its returned offset");
  const rearm = await call(
    baseUrl,
    "long-poll-rearm",
    stablePath(wakeStream, `?offset=${encodeURIComponent(returnedOffset)}&live=long-poll`),
  );
  assertCondition(
    rearm.status === 204 &&
      rearm.body === "" &&
      rearm.exchange.response.headers["stream-next-offset"] === returnedOffset,
    "long-poll re-arm did not park at the returned offset",
  );
  timeoutCases.push(wakeAppend.exchange, wake.exchange, rearm.exchange);
  transcriptMap.set("long-poll.http", timeoutCases);

  const sseCases: NormalizedExchange[] = [];
  const sseStream = "sse-resume";
  await createStream(baseUrl, sseStream);
  const sseFirstAppend = await appendStream(baseUrl, sseStream, 0, [event("push", "one", 6)]);
  const firstRecord = records(JSON.stringify(JSON.parse(sseFirstAppend.body).events))[0]!;
  const sseInitial = await sseExchange(
    baseUrl,
    "sse-initial",
    stablePath(sseStream, "?offset=-1&live=sse"),
    1,
  );
  const initialFrames = parseSseFrames(sseInitial.response.body);
  assertCondition(
    sseInitial.response.headers["content-type"]?.includes("text/event-stream"),
    "SSE content type drifted",
  );
  assertCondition(
    initialFrames.length === 1 && initialFrames[0]!.id === firstRecord.offset,
    "SSE initial frame drifted",
  );
  sseCases.push(sseInitial);
  const sseResume = await sseExchange(
    baseUrl,
    "sse-resume",
    stablePath(sseStream, `?offset=${encodeURIComponent(firstRecord.offset)}&live=sse`),
    2,
    async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      await appendStream(baseUrl, sseStream, 1, [event("push", "two", 7)]);
      await appendStream(baseUrl, sseStream, 2, [event("push", "three", 8)]);
    },
  );
  const resumeFrames = parseSseFrames(sseResume.response.body);
  let previousResumeOffset = firstRecord.offset;
  for (const frame of resumeFrames) {
    const frameRecords = records(frame.data);
    for (const record of frameRecords) {
      assertCondition(
        compareOffsets(record.offset, previousResumeOffset) > 0,
        "SSE records were not strictly increasing",
      );
      previousResumeOffset = record.offset;
    }
    assertCondition(
      frame.id === previousResumeOffset,
      "SSE frame id did not checkpoint its records",
    );
  }
  assertCondition(
    resumeFrames.length === 2 && compareOffsets(previousResumeOffset, firstRecord.offset) > 0,
    `SSE resume offset drifted: frames=${resumeFrames.length} ids=${resumeFrames.map((frame) => frame.id).join(",")} previous=${previousResumeOffset}`,
  );
  sseCases.push(sseResume);
  transcriptMap.set("sse-resume.http", sseCases);

  return Object.fromEntries(
    [...transcriptMap.entries()].map(([name, exchanges]) => [name, serializeTranscript(exchanges)]),
  );
}

interface CorpusSeed {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly rawBodyBase64?: string;
  readonly declaredContentLength?: number;
  readonly payloadBytes?: number;
  readonly setup?: "append" | "other-offset" | "concurrent";
}

interface LedgerEntry {
  readonly expectedStatus: number | readonly number[];
  readonly refused: boolean;
}

async function rawRequest(
  baseUrl: string,
  path: string,
  seed: CorpusSeed,
): Promise<CorpusResponse> {
  const url = new URL(path, baseUrl);
  const body =
    seed.rawBodyBase64 === undefined
      ? Buffer.from(seed.body ?? "", "utf8")
      : Buffer.from(seed.rawBodyBase64, "base64");
  const headers = {
    ...(seed.headers ?? {}),
    host: url.host,
    connection: "close",
    "content-length": String(seed.declaredContentLength ?? body.length),
  };
  return new Promise((resolveResponse, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let bytes = Buffer.alloc(0);
    socket.on("connect", () => {
      let request = `${seed.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) request += `${key}: ${value}\r\n`;
      socket.write(`${request}\r\n`);
      socket.end(body);
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const separator = bytes.indexOf("\r\n\r\n");
      if (separator < 0) return reject(new Error("raw response had no header separator"));
      const headerText = bytes.subarray(0, separator).toString("utf8");
      const firstLineEnd = headerText.indexOf("\r\n");
      const status = Number(headerText.slice(0, firstLineEnd).split(" ", 3)[1]);
      const responseHeaders: Record<string, string> = {};
      for (const line of headerText.slice(firstLineEnd + 2).split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0)
          responseHeaders[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolveResponse({
        status,
        headers: stableHeaders(responseHeaders),
        body: bytes.subarray(separator + 4).toString("utf8"),
      });
    });
  });
}

const CORPUS_VOLATILE_HEADERS = new Set(["connection", "date", "keep-alive", "transfer-encoding"]);

function stableHeaders(headers: HeadersInit | Headers): Readonly<Record<string, string>> {
  const source = new Headers(headers);
  const result: Record<string, string> = {};
  for (const [name, value] of source) {
    if (!CORPUS_VOLATILE_HEADERS.has(name)) result[name] = value;
  }
  return result;
}

function corpusResponse(exchange: NormalizedExchange): CorpusResponse {
  return {
    status: exchange.response.status,
    headers: exchange.response.headers,
    body: exchange.response.body,
  };
}

async function corpusRun(
  baseUrl: string,
  variant: StoreVariant,
): Promise<readonly CorpusOutcome[]> {
  const root = resolve(repoRoot, "packages/conformance/corpus");
  const ledger = JSON.parse(readFileSync(join(root, "ledger.json"), "utf8")) as Readonly<
    Record<string, LedgerEntry>
  >;
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".json") && name !== "ledger.json")
    .sort();
  const outcomes: CorpusOutcome[] = [];
  for (const file of files) {
    const seed = JSON.parse(readFileSync(join(root, file), "utf8")) as CorpusSeed;
    const expected = ledger[seed.id];
    assertCondition(expected !== undefined, `missing ledger entry for ${seed.id}`);
    const stream = `corpus-${seed.id}`;
    await createStream(baseUrl, stream);
    if (["append", "concurrent", "other-offset"].includes(seed.setup ?? ""))
      await appendStream(baseUrl, stream, 0, [event("push", seed.id, 100)]);
    let path = seed.path.replace("__STREAM__", stream);
    if (seed.setup === "other-offset") {
      const other = `other-${seed.id}`;
      await createStream(baseUrl, other);
      const appended = await appendStream(baseUrl, other, 0, [event("push", other, 101)]);
      const offset = records(JSON.stringify(JSON.parse(appended.body).events))[0]!.offset;
      path = path.replace("__OTHER_OFFSET__", offset);
    }
    const before = await dumpStream(baseUrl, stream);
    const beforeDigest = digest(before.rawBody);
    if (seed.setup === "concurrent") {
      const [left, right] = await Promise.all([
        appendStream(baseUrl, stream, 1, [event("push", "left", 102)]),
        appendStream(baseUrl, stream, 1, [event("push", "right", 103)]),
      ]);
      const statuses = [left.status, right.status].sort((a, b) => a - b);
      assertCondition(
        JSON.stringify(statuses) === JSON.stringify(expected.expectedStatus),
        `corpus ${seed.id} status drifted`,
      );
      const after = await dumpStream(baseUrl, stream);
      const raceResponses = [corpusResponse(left.exchange), corpusResponse(right.exchange)].sort(
        (a, b) => a.status - b.status || a.body.localeCompare(b.body),
      );
      const winner = left.status === 201 ? left : right;
      const loserPayload = left.status === 409 ? "left" : "right";
      assertCondition(winner.status === 201, `corpus ${seed.id} had no accepted race append`);
      const winnerRecords = records(JSON.stringify(JSON.parse(winner.body).events));
      const expectedRecords = [...before.records, ...winnerRecords];
      assertCondition(
        canonicalJson(after.records) === canonicalJson(expectedRecords) &&
          !after.records.some((record) => record.payload === loserPayload),
        `refused concurrent corpus ${seed.id} mutated the log`,
      );
      const afterDigest = digest(after.rawBody);
      assertCondition(
        afterDigest !== beforeDigest,
        `corpus ${seed.id} accepted race append did not land`,
      );
      outcomes.push({
        id: seed.id,
        variant,
        status: statuses,
        responses: raceResponses,
        digestBefore: beforeDigest,
        digestAfter: afterDigest,
      });
      continue;
    }
    const request =
      seed.rawBodyBase64 !== undefined || seed.declaredContentLength !== undefined
        ? await rawRequest(baseUrl, path, seed)
        : await (async () => {
            const init: RequestInit = { method: seed.method };
            if (seed.headers !== undefined) init.headers = seed.headers;
            if (seed.payloadBytes !== undefined) {
              init.body = JSON.stringify({
                events: [{ type: "push", payload: "x".repeat(seed.payloadBytes), ts: 104 }],
              });
            } else if (seed.body !== undefined) {
              init.body = seed.body;
            }
            const response = await fetch(`${baseUrl}${path}`, init);
            return {
              status: response.status,
              headers: stableHeaders(response.headers),
              body: Buffer.from(await response.arrayBuffer()).toString("utf8"),
            };
          })();
    assertCondition(
      request.status === expected.expectedStatus,
      `corpus ${seed.id} expected ${expected.expectedStatus} got ${request.status}`,
    );
    const after = await dumpStream(baseUrl, stream);
    const afterDigest = digest(after.rawBody);
    if (expected.refused)
      assertCondition(afterDigest === beforeDigest, `refused corpus ${seed.id} mutated the log`);
    outcomes.push({
      id: seed.id,
      variant,
      status: request.status,
      responses: [request],
      digestBefore: beforeDigest,
      digestAfter: afterDigest,
    });
  }
  return outcomes;
}

export async function collectBoth(): Promise<ConformanceRun> {
  const variants: VariantRun[] = [];
  for (const variant of ["memory", "file"] as const) {
    const server = await startServer(variant);
    try {
      const transcriptValues = await protocolTranscripts(server.baseUrl);
      const corpus = await corpusRun(server.baseUrl, variant);
      variants.push({
        variant,
        baseUrl: server.baseUrl,
        transcripts: transcriptValues,
        corpus,
        caseCount: Object.values(transcriptValues).reduce(
          (count, transcript) => count + transcript.split("\n").filter(Boolean).length,
          0,
        ),
      });
    } finally {
      await server.stop();
    }
  }
  return { variants };
}

export function assertOffsetOpacity(): void {
  const srcRoot = resolve(repoRoot, "packages/conformance/src");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
  };
  visit(srcRoot);
  const forbidden = [
    /\boffset\s*\.\s*(?:split|slice|substring|charAt|match|replace|exec)\b/,
    /\boffset\s*\[[^\]]+\]/,
    /\b(?:Number|parseInt|parseFloat)\s*\(\s*offset\b/,
    /\+\s*offset\b/,
    /\boffset\b\s*[+*/-]\s*(?:\d|offset\b)/,
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assertCondition(
      !forbidden.some((pattern) => pattern.test(source)),
      `offset opacity guard matched ${file.replace(`${srcRoot}/`, "")}`,
    );
  }
}

export function writeEvidence(run: ConformanceRun): void {
  const evidence = resolve(
    repoRoot,
    ".eforest/tasks/epic-0-the-seed/E0-T09-protocol-conformance-freeze/evidence",
  );
  mkdirSync(evidence, { recursive: true });
  const summary = {
    variants: run.variants.map((variant) => ({
      variant: variant.variant,
      caseCount: variant.caseCount,
      corpusCount: variant.corpus.length,
    })),
  };
  writeFileSync(join(evidence, "e0-t09-run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = run.variants.flatMap((variant) =>
    variant.corpus.map(
      (outcome) =>
        `${variant.variant}\t${outcome.id}\t${outcome.status}\t${outcome.digestBefore}\t${outcome.digestAfter}`,
    ),
  );
  writeFileSync(join(evidence, "e0-t09-corpus-digests.txt"), `${lines.join("\n")}\n`);
}
