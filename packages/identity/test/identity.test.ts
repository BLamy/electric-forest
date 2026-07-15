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
import {
  grant,
  grantRevoke,
  identityEvent,
  membership,
  membershipRevoke,
  oracleFold,
  org,
  session,
  sessionEnd,
  user,
} from "./helpers.js";

const root = resolve(import.meta.dirname, "../../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/evidence",
);
const goldenPath = join(evidence, "golden-identity.jsonl");
const digestPath = join(evidence, "golden-identity.digest");
const reducerPath = resolve(root, "packages/identity/reducer.mjs");
const cliPath = resolve(root, "packages/cli/dist/src/bin.js");

interface DumpRecord extends Event {
  readonly offset: Offset;
}

function goldenRecords(): readonly DumpRecord[] {
  return readFileSync(goldenPath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as DumpRecord);
}

function eventsOf(records: readonly DumpRecord[]): readonly Event[] {
  return records.map(({ offset: _offset, ...event }) => event);
}

function offset(index: number): string {
  return `0000000000000000_${String(index).padStart(16, "0")}`;
}

function dump(events: readonly Event[]): string {
  return `${events
    .map((event, index) => canonicalJson({ offset: offset(index), ...event }))
    .join("\n")}\n`;
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function guardInputs(): Readonly<Record<string, Event>> {
  const baseGrant = grant("grant-guard-01", "auth0|alice", "a".repeat(64));
  const payload = baseGrant.payload as Record<string, unknown>;
  return {
    "unknown-type": identityEvent("identity.unknown", { v: 1 }),
    "missing-field": identityEvent("identity.user.created", { sub: "auth0|alice", v: 1 }),
    "extra-field": identityEvent("identity.user.created", {
      email: "alice@example.com",
      extra: true,
      sub: "auth0|alice",
      v: 1,
    }),
    "wrong-type": identityEvent("identity.user.created", {
      email: 42,
      sub: "auth0|alice",
      v: 1,
    }),
    "version-two": identityEvent("identity.user.created", {
      email: "alice@example.com",
      sub: "auth0|alice",
      v: 2,
    }),
    "sub-empty": user(""),
    "sub-control": user("auth0|\u0001alice"),
    "sub-too-long": user("x".repeat(257)),
    "sub-nfd": user("auth0|bjo\u0308rn"),
    "org-id": org("Bad_org", "auth0|alice"),
    "token-hash-uppercase": identityEvent(baseGrant.type, {
      ...payload,
      tokenHash: `${"a".repeat(63)}A`,
    }),
    "token-hash-short": identityEvent(baseGrant.type, { ...payload, tokenHash: "a".repeat(63) }),
    "token-hash-nonhex": identityEvent(baseGrant.type, { ...payload, tokenHash: "g".repeat(64) }),
    "raw-token-field": identityEvent(baseGrant.type, { ...payload, token: "raw-secret" }),
    "scopes-unsorted": identityEvent(baseGrant.type, {
      ...payload,
      scopes: ["repo:write", "repo:read"],
    }),
    "scopes-duplicated": identityEvent(baseGrant.type, {
      ...payload,
      scopes: ["repo:read", "repo:read"],
    }),
    "scope-jwt": identityEvent(baseGrant.type, { ...payload, scopes: ["eyJhbGciOiJI.abc.sig"] }),
  };
}

function corruptLogs(): Readonly<Record<string, readonly Event[]>> {
  const alice = user("auth0|alice");
  const bob = user("auth0|bob");
  const forest = org("forest", "auth0|alice");
  const issued = grant("grant-one", "auth0|alice", "a".repeat(64));
  return {
    "duplicate-user": [alice, user("auth0|alice", "different@example.com")],
    "duplicate-org": [alice, forest, org("forest", "auth0|alice", "different")],
    "org-before-owner": [forest, alice],
    "membership-unknown-org": [alice, membership("missing", "auth0|alice")],
    "membership-unknown-user": [alice, forest, membership("forest", "auth0|ghost")],
    "membership-already-active": [
      alice,
      bob,
      forest,
      membership("forest", "auth0|bob"),
      membership("forest", "auth0|bob"),
    ],
    "membership-inactive": [alice, bob, forest, membershipRevoke("forest", "auth0|bob")],
    "owner-revoke": [alice, forest, membershipRevoke("forest", "auth0|alice")],
    "duplicate-grant-id": [alice, issued, grant("grant-one", "auth0|alice", "b".repeat(64))],
    "grant-unknown-user": [grant("grant-one", "auth0|ghost", "a".repeat(64))],
    "duplicate-active-token-hash": [
      alice,
      bob,
      issued,
      grant("grant-two", "auth0|bob", "a".repeat(64)),
    ],
    "revoke-before-issue": [grantRevoke("grant-one"), alice, issued],
    "double-grant-revoke": [alice, issued, grantRevoke("grant-one"), grantRevoke("grant-one")],
    "duplicate-session-id": [
      alice,
      session("session-one", "auth0|alice"),
      session("session-one", "auth0|alice"),
    ],
    "session-unknown-user": [session("session-one", "auth0|ghost")],
    "session-end-before-start": [sessionEnd("session-one")],
    "session-ended-twice": [
      alice,
      session("session-one", "auth0|alice"),
      sessionEnd("session-one"),
      sessionEnd("session-one"),
    ],
  };
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
    ) as { cases: Array<{ expected: string; name: string }> };
    const inputs = guardInputs();
    expect(Object.keys(inputs).sort()).toEqual(manifest.cases.map(({ name }) => name).sort());
    for (const { expected, name } of manifest.cases) {
      const input = inputs[name]!;
      const before = structuredClone(input);
      expect(isIdentityEvent(input), name).toBe(false);
      expect(() => assertIdentityEvent(input), name).toThrowError(IdentityEventValidationError);
      try {
        assertIdentityEvent(input);
      } catch (error) {
        expect((error as IdentityEventValidationError).code, name).toBe(expected);
      }
      expect(input, name).toEqual(before);
    }
  });

  test("retains auditable status and answers every frozen query", () => {
    const records = goldenRecords();
    const events = eventsOf(records);
    const view = replay(events, identityReducer, identityInitialState);
    expect(userForSub(view, "auth0|alice")).toEqual({ email: "alice@example.com" });
    expect(userForSub(view, "auth0|unknown")).toBeNull();
    expect(roleOf(view, "electric-forest", "auth0|alice")).toBe("owner");
    expect(roleOf(view, "electric-forest", "auth0|björn")).toBe("admin");
    const afterRevoke = replay(events.slice(0, 5), identityReducer, emptyView());
    expect(roleOf(afterRevoke, "electric-forest", "auth0|björn")).toBeNull();
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

  test("CLI reports every corrupt-log invariant at its exact line", () => {
    const manifest = JSON.parse(readFileSync(join(evidence, "fuzz/corrupt-logs.json"), "utf8")) as {
      cases: Array<{ expected: string; line: number; name: string }>;
    };
    const cases = corruptLogs();
    expect(Object.keys(cases).sort()).toEqual(manifest.cases.map(({ name }) => name).sort());
    const scratch = mkdtempSync(join(tmpdir(), "eforest-identity-corrupt-"));
    try {
      for (const { expected, line, name } of manifest.cases) {
        const path = join(scratch, `${name}.jsonl`);
        writeFileSync(path, dump(cases[name]!), "utf8");
        const result = runCli(["replay", path, "--digest", "--reducer", reducerPath]);
        expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(1);
        expect(result.stderr, name).toContain(`line ${line}:`);
        expect(result.stderr, name).toContain(expected);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
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
