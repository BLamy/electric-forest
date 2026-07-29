import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  compareOffsets,
  isEvent,
  replay,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { describe, expect, test } from "vitest";
import {
  assertIdentityEvent,
  emptyView,
  findActiveGrantByTokenHash,
  IDENTITY_EVENT_VERSION,
  IdentityEventValidationError,
  identityInitialState,
  identityReducer,
  isIdentityEvent,
  isSessionActive,
  roleOf,
  userForSub,
  viewDigest,
  type AuthorizationView,
} from "../src/index.js";
import { grant, grantRevoke, oracleFold, user } from "./helpers.js";

const root = resolve(import.meta.dirname, "../../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/evidence",
);
const goldenPath = join(evidence, "golden-identity.jsonl");
const digestPath = join(evidence, "golden-identity.digest");
const prototypePath = join(evidence, "prototype-keys.jsonl");
const prototypeDigestPath = join(evidence, "prototype-keys.digest");
const membershipRevokedDigestPath = join(evidence, "membership-revoked-prefix.digest");
const reducerPath = resolve(root, "packages/identity/reducer.mjs");
const cliPath = resolve(root, "packages/cli/dist/src/bin.js");
const inheritedEventTypeFixtures = [
  {
    file: "corrupt/unknown-type-to-string.jsonl",
    name: "unknown-type-to-string",
    type: "toString",
  },
  {
    file: "corrupt/unknown-type-constructor.jsonl",
    name: "unknown-type-constructor",
    type: "constructor",
  },
  {
    file: "corrupt/unknown-type-proto.jsonl",
    name: "unknown-type-proto",
    type: "__proto__",
  },
  {
    file: "corrupt/unknown-type-value-of.jsonl",
    name: "unknown-type-value-of",
    type: "valueOf",
  },
  {
    file: "corrupt/unknown-type-has-own-property.jsonl",
    name: "unknown-type-has-own-property",
    type: "hasOwnProperty",
  },
] as const;
const inheritedEventTypes = inheritedEventTypeFixtures.map(({ type }) => type);
const inheritedEventTypeCaseNames = inheritedEventTypeFixtures.map(({ name }) => name);

interface DumpRecord extends Event {
  readonly offset: Offset;
}

function goldenRecords(): readonly DumpRecord[] {
  return recordsAt(goldenPath);
}

function recordsAt(path: string): readonly DumpRecord[] {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as DumpRecord);
}

function eventsOf(records: readonly DumpRecord[]): readonly Event[] {
  return records.map(({ offset: _offset, ...event }) => event);
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function decodeCanonicalLine(bytes: Uint8Array): DumpRecord {
  const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(line) as unknown;
  if (canonicalJson(value) !== line || value === null || typeof value !== "object") {
    throw new Error("non-canonical line");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "offset,payload,ts,type") {
    throw new Error("invalid fields");
  }
  if (typeof record.offset !== "string" || !/^[0-9]+(?:_[0-9]+)?$/.test(record.offset)) {
    throw new Error("invalid offset");
  }
  const event = { payload: record.payload, ts: record.ts, type: record.type };
  if (!isEvent(event)) throw new Error("invalid envelope");
  return { ...event, offset: record.offset as Offset };
}

function evaluateLines(lines: readonly Uint8Array[]): {
  readonly digest: string;
  readonly events: readonly Event[];
  readonly view: AuthorizationView;
} {
  const records = lines.map(decodeCanonicalLine);
  for (let index = 1; index < records.length; index += 1) {
    if (compareOffsets(records[index - 1]!.offset, records[index]!.offset) >= 0) {
      throw new Error("offset order");
    }
  }
  const events = eventsOf(records);
  const view = replay(events, identityReducer, emptyView());
  return { digest: viewDigest(view), events, view };
}

function mutatedByte(value: number): number {
  if (value >= 0x30 && value <= 0x38) return value + 1;
  if (value === 0x39) return 0x38;
  if (value >= 0x61 && value <= 0x79) return value + 1;
  if (value === 0x7a) return 0x79;
  if (value >= 0x41 && value <= 0x59) return value + 1;
  if (value === 0x5a) return 0x59;
  return value ^ 1;
}

describe("frozen identity event model", () => {
  test("exports v1 and rejects the committed guard corpus without mutation", () => {
    expect(IDENTITY_EVENT_VERSION).toBe(1);
    const manifest = JSON.parse(
      readFileSync(join(evidence, "fuzz/guard-refusals.json"), "utf8"),
    ) as { cases: Array<{ expected: string; input: Event; name: string }> };
    expect(
      manifest.cases
        .filter(({ input }) => (inheritedEventTypes as readonly string[]).includes(input.type))
        .map(({ input, name }) => ({ name, type: input.type })),
    ).toEqual(inheritedEventTypeFixtures.map(({ name, type }) => ({ name, type })));
    for (const { expected, input, name } of manifest.cases) {
      const before = structuredClone(input);
      expect(isIdentityEvent(input), name).toBe(false);
      expect(() => assertIdentityEvent(input), name).toThrowError(IdentityEventValidationError);
      try {
        assertIdentityEvent(input);
      } catch (error) {
        expect((error as IdentityEventValidationError).code, name).toBe(expected);
      }
      const state = emptyView();
      const stateBefore = structuredClone(state);
      let reducerError: unknown;
      try {
        identityReducer(state, input);
      } catch (error) {
        reducerError = error;
      }
      expect(reducerError, name).toBeInstanceOf(IdentityEventValidationError);
      expect((reducerError as IdentityEventValidationError).code, name).toBe(expected);
      expect(state, name).toEqual(stateBefore);
      expect(input, name).toEqual(before);
    }
  });

  test("retains auditable status and answers every frozen query", () => {
    const records = goldenRecords();
    const events = eventsOf(records);
    const view = replay(events, identityReducer, identityInitialState);
    expect(userForSub(view, "auth0|alice")).toEqual({ email: "alice@example.com" });
    expect(userForSub(view, "auth0|björn")).toEqual({ email: "björn@example.com" });
    expect(userForSub(view, "auth0|unknown")).toBeNull();
    expect(roleOf(view, "electric-forest", "auth0|alice")).toBe("owner");
    expect(roleOf(view, "electric-forest", "auth0|björn")).toBe("admin");
    const afterRevoke = replay(events.slice(0, 5), identityReducer, emptyView());
    expect(roleOf(afterRevoke, "electric-forest", "auth0|björn")).toBeNull();
    expect(afterRevoke.memberships["electric-forest"]?.["auth0|björn"]).toEqual({
      role: "member",
      status: "revoked",
    });
    expect(viewDigest(afterRevoke)).toBe(readFileSync(membershipRevokedDigestPath, "utf8").trim());
    expect(findActiveGrantByTokenHash(view, "a".repeat(64))).toMatchObject({
      grantId: "grant-alpha-01",
      status: "active",
    });
    expect(findActiveGrantByTokenHash(view, "b".repeat(64))).toBeNull();
    expect(findActiveGrantByTokenHash(view, `A${"a".repeat(63)}`)).toBeNull();
    expect(isSessionActive(view, "session-bjorn-01")).toBe(false);
    expect(view.memberships["electric-forest"]?.["auth0|björn"]).toEqual({
      role: "admin",
      status: "active",
    });
    expect(view.grants["grant-beta-02"]?.status).toBe("revoked");
    expect(view.sessions["session-bjorn-01"]?.status).toBe("ended");
  });

  test("stores and queries every schema-valid prototype-named identity as own state", () => {
    const empty = emptyView();
    for (const name of ["__proto__", "constructor", "toString"] as const) {
      expect(userForSub(empty, name), name).toBeNull();
      expect(isSessionActive(empty, name), name).toBe(false);
    }
    expect(roleOf(empty, "constructor", "toString")).toBeNull();

    const records = recordsAt(prototypePath);
    const events = eventsOf(records);
    const view = replay(events, identityReducer, emptyView());
    const expected = readFileSync(prototypeDigestPath, "utf8").trim();
    expect(viewDigest(view)).toBe(expected);
    for (const name of ["__proto__", "constructor", "toString"] as const) {
      expect(Object.hasOwn(view.users, name), name).toBe(true);
      expect(Object.hasOwn(view.grants, name), name).toBe(true);
      expect(Object.hasOwn(view.sessions, name), name).toBe(true);
      expect(userForSub(view, name), name).not.toBeNull();
      expect(isSessionActive(view, name), name).toBe(true);
    }
    expect(Object.hasOwn(view.orgs, "constructor")).toBe(true);
    expect(Object.hasOwn(view.memberships, "constructor")).toBe(true);
    expect(Object.hasOwn(view.memberships["constructor"]!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(view.users)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(view.memberships["constructor"]!)).toBe(Object.prototype);
    expect(roleOf(view, "constructor", "__proto__")).toBe("owner");
    expect(roleOf(view, "constructor", "toString")).toBe("admin");
    expect(findActiveGrantByTokenHash(view, "c".repeat(64))?.grantId).toBe("__proto__");
    expect(findActiveGrantByTokenHash(view, "d".repeat(64))?.grantId).toBe("constructor");
    expect(findActiveGrantByTokenHash(view, "e".repeat(64))?.grantId).toBe("toString");

    const reordered = [
      events[2]!,
      events[1]!,
      events[0]!,
      events[3]!,
      events[4]!,
      events[7]!,
      events[6]!,
      events[5]!,
      events[10]!,
      events[9]!,
      events[8]!,
    ];
    expect(viewDigest(replay(reordered, identityReducer, emptyView()))).toBe(expected);
    expect(viewDigest(oracleFold(events))).toBe(expected);

    const cli = runCli(["replay", prototypePath, "--digest", "--reducer", reducerPath]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toBe(`${expected}\n`);
  });

  test("allows a revoked grant hash to identify exactly one newly active grant", () => {
    const hash = "f".repeat(64);
    const events = [
      user("auth0|reuse"),
      grant("grant-old", "auth0|reuse", hash),
      grantRevoke("grant-old"),
      grant("grant-new", "auth0|reuse", hash, "web-session-mint", ["session:mint"]),
    ];
    const view = replay(events, identityReducer, emptyView());
    expect(view.grants["grant-old"]?.status).toBe("revoked");
    expect(findActiveGrantByTokenHash(view, hash)).toEqual({
      grantId: "grant-new",
      kind: "web-session-mint",
      scopes: ["session:mint"],
      status: "active",
      sub: "auth0|reuse",
      tokenHash: hash,
    });
  });

  test("CLI reports every corrupt-log invariant at its exact line", () => {
    const manifest = JSON.parse(readFileSync(join(evidence, "fuzz/corrupt-logs.json"), "utf8")) as {
      cases: Array<{ expected: string; file: string; line: number; name: string }>;
    };
    expect(
      manifest.cases
        .filter(({ name }) => (inheritedEventTypeCaseNames as readonly string[]).includes(name))
        .map(({ expected, file, line, name }) => ({ expected, file, line, name })),
    ).toEqual(
      inheritedEventTypeFixtures.map(({ file, name }) => ({
        expected: "identity/unknown-type",
        file,
        line: 1,
        name,
      })),
    );
    for (const { expected, file, line, name } of manifest.cases) {
      const path = join(evidence, "fuzz", file);
      const fixture = inheritedEventTypeFixtures.find((candidate) => candidate.name === name);
      if (fixture !== undefined) {
        const bytes = readFileSync(path);
        expect(bytes.at(-1), `${name}: newline terminator`).toBe(0x0a);
        const canonicalLine = bytes.subarray(0, -1);
        expect(canonicalLine.includes(0x0a), `${name}: exactly one line`).toBe(false);
        const record = decodeCanonicalLine(canonicalLine);
        expect(record.type, `${name}: exact inherited event type`).toBe(fixture.type);
        expect(record.payload, `${name}: refusal payload`).toEqual({});
      } else {
        expect(readFileSync(path, "utf8").trimEnd().split("\n").length).toBeGreaterThanOrEqual(
          line,
        );
      }
      const result = runCli(["replay", path, "--digest", "--reducer", reducerPath]);
      expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stdout, name).toBe("");
      expect(result.stderr, name).toContain(`line ${line}:`);
      expect(result.stderr, name).toContain(expected);
      if (fixture !== undefined) {
        expect(result.stderr, name).toContain(`unsupported event type "${fixture.type}"`);
      }
    }
  }, 30_000);

  test("golden CLI, protocol replay, direct fold, and independent fold agree", () => {
    const records = goldenRecords();
    const events = eventsOf(records);
    const expected = readFileSync(digestPath, "utf8").trim();
    const protocol = viewDigest(replay(events, identityReducer, emptyView()));
    let direct = emptyView();
    for (const event of events) direct = identityReducer(direct, event);
    const independent = stateDigest(oracleFold(events));
    const cli = runCli(["replay", goldenPath, "--digest", "--reducer", reducerPath]);
    expect(cli.status, cli.stderr).toBe(0);
    expect([cli.stdout.trim(), protocol, viewDigest(direct), independent]).toEqual([
      expected,
      expected,
      expected,
      expected,
    ]);
  });

  test("contains only frozen fields and hashed bearer material", () => {
    for (const event of eventsOf(goldenRecords())) {
      assertIdentityEvent(event);
      const keys = Object.keys(event.payload as unknown as Record<string, unknown>);
      expect(keys.some((key) => /token$|secret/i.test(key))).toBe(false);
      if (event.type === "identity.grant.issued") {
        expect(event.payload.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test("every golden byte is rejected, state-reaching, or independently state-neutral", () => {
    const originalText = readFileSync(goldenPath, "utf8").trimEnd();
    const lines = originalText.split("\n").map((line) => Buffer.from(line));
    const original = evaluateLines(lines);
    const independentOriginal = oracleFold(original.events);
    let grantPayloadBytes = 0;
    let expectedGreen = 0;
    for (const [lineIndex, line] of lines.entries()) {
      const text = line.toString("utf8");
      const isGrant = text.includes('"type":"identity.grant.');
      const payloadStart = text.indexOf('"payload":') + '"payload":'.length;
      const payloadEnd = text.indexOf(',"ts":');
      for (let byteIndex = 0; byteIndex < line.length; byteIndex += 1) {
        const isGrantPayload = isGrant && byteIndex >= payloadStart && byteIndex < payloadEnd;
        if (isGrantPayload) grantPayloadBytes += 1;
        const mutatedLine = Buffer.from(line);
        mutatedLine[byteIndex] = mutatedByte(mutatedLine[byteIndex]!);
        const mutatedLines = [...lines];
        mutatedLines[lineIndex] = mutatedLine;
        let evaluated;
        try {
          evaluated = evaluateLines(mutatedLines);
        } catch {
          continue;
        }
        const independent = oracleFold(evaluated.events);
        expect(evaluated.view, `line=${lineIndex + 1} byte=${byteIndex}`).toEqual(independent);
        if (evaluated.digest === original.digest) {
          expect(independent, `line=${lineIndex + 1} byte=${byteIndex}`).toEqual(
            independentOriginal,
          );
          expectedGreen += 1;
        }
        if (isGrantPayload) {
          expect(evaluated.digest, `grant line=${lineIndex + 1} byte=${byteIndex}`).not.toBe(
            original.digest,
          );
        }
      }
    }
    expect(grantPayloadBytes).toBeGreaterThan(0);
    expect(expectedGreen).toBeGreaterThan(0);
  });

  test("bisects a digest-changing byte in every issued grant to that offset", () => {
    const records = goldenRecords();
    const scratch = mkdtempSync(join(tmpdir(), "eforest-identity-bisect-"));
    try {
      for (const [index, record] of records.entries()) {
        if (record.type !== "identity.grant.issued") continue;
        const mutated = structuredClone(records) as DumpRecord[];
        const payload = mutated[index]!.payload as Record<string, unknown>;
        const tokenHash = payload.tokenHash as string;
        payload.tokenHash = `${tokenHash[0] === "a" ? "c" : "d"}${tokenHash.slice(1)}`;
        const path = join(scratch, `grant-${index}.jsonl`);
        writeFileSync(path, `${mutated.map((value) => canonicalJson(value)).join("\n")}\n`);
        const replayResult = runCli(["replay", path, "--digest", "--reducer", reducerPath]);
        expect(replayResult.status, replayResult.stderr).toBe(0);
        expect(replayResult.stdout.trim()).not.toBe(readFileSync(digestPath, "utf8").trim());
        const bisect = runCli(["bisect", goldenPath, path, "--reducer", reducerPath]);
        expect(bisect.status, bisect.stderr).toBe(1);
        const result = JSON.parse(bisect.stdout) as { bOffset: string; kind: string };
        expect(result.kind).toBe("divergence");
        expect(result.bOffset).toBe(record.offset);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
