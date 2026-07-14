import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureInitialState, fixtureReducer } from "../fixtures/reducer.js";
import {
  CanonicalJsonError,
  canonicalJson,
  compareOffsets,
  isEvent,
  isOffsetBefore,
  maxOffset,
  OFFSET_BEFORE_FIRST,
  PROTOCOL_VERSION,
  replay,
  stateDigest,
  type Event,
  type Offset,
} from "./index.js";

const offset = (value: string) => value as Offset;

describe("canonicalJson frozen bytes", () => {
  it.each([
    [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
    [[-0, 1e21, "\ud800"], '[0,1e+21,"\\ud800"]'],
    [{ "😀": 1, a: { z: false, a: null } }, '{"a":{"a":null,"z":false},"😀":1}'],
  ])("encodes %j", (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
    ["bigint", 1n],
    ["undefined object field", { value: undefined }],
    ["undefined array entry", [undefined]],
    ["sparse array entry", Array(1)],
    ["function", () => undefined],
    ["symbol", Symbol("x")],
  ])("throws CanonicalJsonError for %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError for circular references", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("throws CanonicalJsonError for symbol object keys", () => {
    expect(() => canonicalJson({ [Symbol("key")]: 1 })).toThrow(CanonicalJsonError);
  });
});

describe("event envelope", () => {
  it("accepts exactly the frozen envelope", () => {
    expect(isEvent({ type: "x", payload: null, ts: 0 })).toBe(true);
  });

  it.each([
    null,
    { type: "x", payload: null },
    { type: "x", payload: null, ts: Number.NaN },
    { type: 1, payload: null, ts: 0 },
    { type: "x", payload: null, ts: 0, extra: true },
  ])("rejects malformed value %j", (value) => expect(isEvent(value)).toBe(false));

  it("rejects symbol-keyed extras", () => {
    expect(isEvent({ type: "x", payload: null, ts: 0, [Symbol("extra")]: true })).toBe(false);
  });
});

describe("offsets", () => {
  it("uses sentinel-first then lexicographic ordering", () => {
    expect(compareOffsets(offset("1"), offset("10"))).toBe(-1);
    expect(compareOffsets(offset("10"), offset("9"))).toBe(-1);
    expect(compareOffsets(offset("9"), offset("10"))).toBe(1);
    expect(compareOffsets(OFFSET_BEFORE_FIRST, offset("0"))).toBe(-1);
    expect(compareOffsets(OFFSET_BEFORE_FIRST, offset("-0"))).toBe(-1);
    expect(compareOffsets(offset("same"), offset("same"))).toBe(0);
    expect(isOffsetBefore(offset("0002"), offset("1"))).toBe(true);
    expect(maxOffset(offset("9"), offset("10"))).toBe(offset("9"));
  });
});

describe("digest and replay", () => {
  it("pins the counter golden through an independently hand-derived state vector", () => {
    const events: Event[] = [
      { type: "set", payload: 2, ts: 1 },
      { type: "increment", payload: 3, ts: 2 },
      { type: "push", payload: "done", ts: 3 },
    ];
    const finalState = replay(events, fixtureReducer, fixtureInitialState);
    const independentlyDerivedBytes = '{"count":5,"meta":{},"values":["done"]}';
    expect(finalState).toEqual({ count: 5, meta: {}, values: ["done"] });
    expect(createHash("sha256").update(independentlyDerivedBytes).digest("hex")).toBe(
      "5dcad1de965e75030a61ce33905b6418919237631bdd4f8aaa08ca955397f57d",
    );
    expect(stateDigest(finalState)).toBe(
      "5dcad1de965e75030a61ce33905b6418919237631bdd4f8aaa08ca955397f57d",
    );
  });

  it("matches the independent SHA-256 vector for an empty object", () => {
    expect(stateDigest({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(stateDigest({})).toBe(createHash("sha256").update("{}").digest("hex"));
  });

  it("replays as a left fold", () => {
    const events: Event[] = [
      { type: "set", payload: 2, ts: 1 },
      { type: "increment", payload: 4, ts: 2 },
    ];
    expect(replay(events, fixtureReducer, fixtureInitialState)).toEqual(
      events.reduce(fixtureReducer, fixtureInitialState),
    );
  });
});

describe("seeded properties", () => {
  const PROPERTY_SEED = 0x5eed_0003;
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  function sameValueZeroNormalized(value: unknown): unknown {
    if (typeof value === "number" && Object.is(value, -0)) return 0;
    if (Array.isArray(value)) return value.map(sameValueZeroNormalized);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, sameValueZeroNormalized(entry)]),
      );
    }
    return value;
  }

  it("is deterministic across shuffled key insertion and SameValueZero round trips", () => {
    const next = random(PROPERTY_SEED);
    for (let index = 0; index < 200; index += 1) {
      const value = {
        z: [next() < 0.2 ? -0 : next(), { 雪: index, é: `v${index}` }],
        a: Math.floor(next() * Number.MAX_SAFE_INTEGER),
        m: { b: next() > 0.5, a: null },
      };
      const shuffled = { m: value.m, z: value.z, a: value.a };
      const encoded = canonicalJson(value);
      expect(canonicalJson(shuffled)).toBe(encoded);
      expect(sameValueZeroNormalized(JSON.parse(encoded))).toEqual(sameValueZeroNormalized(value));
    }
  });

  it("has distinct digests for distinct generated canonical encodings", () => {
    const next = random(PROPERTY_SEED ^ 0xd16e57);
    const encodings = new Set<string>();
    const digests = new Set<string>();
    for (let index = 0; index < 256; index += 1) {
      const value = { index, sample: next(), nested: [index % 7, `value-${index}`] };
      encodings.add(canonicalJson(value));
      digests.add(stateDigest(value));
    }
    expect(digests.size).toBe(encodings.size);
  });

  it("obeys total-order laws and replay-fold equivalence", () => {
    const values = [OFFSET_BEFORE_FIRST, offset("0002"), offset("1"), offset("10"), offset("9")];
    for (const a of values) {
      expect(compareOffsets(a, a)).toBe(0);
      for (const b of values) {
        const reverse = compareOffsets(b, a);
        expect(compareOffsets(a, b)).toBe(reverse === 0 ? 0 : -reverse);
        expect(isOffsetBefore(a, b)).toBe(compareOffsets(a, b) === -1);
        for (const c of values) {
          if (compareOffsets(a, b) <= 0 && compareOffsets(b, c) <= 0) {
            expect(compareOffsets(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe("golden fixtures", () => {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
  for (const file of readdirSync(fixtureDir).filter((name) => name.endsWith(".events.jsonl"))) {
    it(`pins canonical bytes and digests for ${file}`, () => {
      const name = file.slice(0, -".events.jsonl".length);
      const raw = readFileSync(join(fixtureDir, file), "utf8");
      const lines = raw === "" ? [] : raw.trimEnd().split("\n");
      const events = lines.map((line) => JSON.parse(line) as Event);
      expect(events.every(isEvent)).toBe(true);
      expect(events.map(canonicalJson).join("\n") + (events.length ? "\n" : "")).toBe(raw);
      const expected = JSON.parse(
        readFileSync(join(fixtureDir, `${name}.expected.json`), "utf8"),
      ) as {
        protocolVersion: number;
        eventCount: number;
        canonicalSha256OfLog: string;
        finalStateDigest: string;
      };
      expect(expected.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(expected.eventCount).toBe(events.length);
      expect(createHash("sha256").update(raw).digest("hex")).toBe(expected.canonicalSha256OfLog);
      expect(stateDigest(replay(events, fixtureReducer, fixtureInitialState))).toBe(
        expected.finalStateDigest,
      );
    });
  }
});
