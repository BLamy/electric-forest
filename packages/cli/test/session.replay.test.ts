import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { requireReducer } from "@eforest/reducers";
import {
  parseSessionManifest,
  sessionDumpFileName,
  SessionManifestError,
  validateSession,
  type SessionDump,
  type SessionManifest,
  type SessionManifestFailureCode,
  type SessionRecord,
} from "../src/session/manifest.js";
import {
  compositeDigest,
  replaySession,
  SessionReplayError,
  type SessionReplayFailureCode,
} from "../src/session/replay.js";

const ISSUE = "issue:maple/reading-room/17";
const PR = "pr:maple/reading-room/60";
const TARGET = "fs:maple/reading-room:main:meta";
const SOURCE = "fs:maple/reading-room:feature:meta";
const WIKI = "fs:maple/reading-room:wiki:meta";
const EVIDENCE = "evidence:maple/reading-room/pr/60";
const CONTENT = "evidence-content:maple/reading-room/run-60";

const O0 = offsetForOrdinal(0);
const O1 = offsetForOrdinal(1);
const O2 = offsetForOrdinal(2);
const ABSENT_OFFSET = offsetForOrdinal(99);

function record(ordinal: number, type: string, payload: unknown): SessionRecord {
  return { offset: offsetForOrdinal(ordinal), type, payload, ts: ordinal + 1 };
}

interface FixtureOptions {
  readonly entityRefStream?: string;
  readonly closeMergeOffset?: string;
  readonly forkOffset?: string;
  readonly attachmentSha256?: string;
  readonly shuffleManifest?: boolean;
}

interface Fixture {
  readonly manifest: SessionManifest;
  readonly dumps: ReadonlyMap<string, SessionDump>;
  readonly contentSha256: string;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const contentBytes = new TextEncoder().encode("E5-T12 negotiation evidence\n");
  const contentSha256 = sha256Hex(contentBytes);
  const contentBase64 = Buffer.from(contentBytes).toString("base64");
  const dumps = new Map<string, SessionDump>([
    [
      ISSUE,
      [
        record(0, "issue.opened", { v: 1, title: "Ship negotiation", body: "Replay it" }),
        record(1, "issue.state-changed", {
          v: 2,
          to: "done",
          via: { prStream: PR, prMergedOffset: options.closeMergeOffset ?? O2 },
        }),
      ],
    ],
    [
      PR,
      [
        record(0, "pr.opened", {
          v: 1,
          sourceBranch: SOURCE,
          targetBranch: TARGET,
          forkOffset: options.forkOffset ?? O0,
          title: "Negotiate issue 17",
          body: "Merge the branch",
          author: "builder",
          closes: [{ entity: "issue", stream: options.entityRefStream ?? ISSUE }],
        }),
        record(1, "pr.approved", { v: 1, reviewer: "reviewer" }),
        record(2, "pr.merged", {
          v: 1,
          targetMergeOffset: O0,
          kind: "fast-forward",
          resultTreeDigest: "a".repeat(64),
        }),
      ],
    ],
    [TARGET, [record(0, "fs.branch.genesis", { v: 1, branch: "main" })]],
    [SOURCE, [record(0, "fs.branch.fork", { v: 1, parentStreamId: TARGET, forkOffset: O0 })]],
    [WIKI, [record(0, "fs.branch.genesis", { v: 1, branch: "wiki" })]],
    [
      EVIDENCE,
      [
        record(0, "evidence.attached", {
          v: 1,
          attachmentId: "run-60",
          kind: "event-log",
          name: "negotiation.jsonl",
          mediaType: "application/x-ndjson",
          size: contentBytes.byteLength,
          sha256: options.attachmentSha256 ?? contentSha256,
          contentStream: CONTENT,
        }),
      ],
    ],
    [
      CONTENT,
      [
        record(0, "content.chunk", { v: 1, seq: 0, bytes: contentBase64 }),
        record(1, "content.sealed", {
          v: 1,
          sha256: contentSha256,
          size: contentBytes.byteLength,
          chunks: 1,
        }),
      ],
    ],
  ]);
  const identities = [
    { stream: ISSUE, role: "issue" as const, reducer: "issue" },
    { stream: PR, role: "pr" as const, reducer: "pr" },
    { stream: TARGET, role: "branch" as const, reducer: "streamfs" },
    { stream: SOURCE, role: "branch" as const, reducer: "streamfs" },
    { stream: WIKI, role: "wiki" as const, reducer: "streamfs" },
    { stream: EVIDENCE, role: "attachment" as const, reducer: "evidence" },
    { stream: CONTENT, role: "attachment" as const, reducer: "evidence-content" },
  ];
  const streams = identities
    .map((identity) => ({
      ...identity,
      head: dumps.get(identity.stream)!.at(-1)!.offset,
    }))
    .sort((left, right) => (left.stream < right.stream ? -1 : left.stream > right.stream ? 1 : 0));
  return {
    manifest: {
      session: "issue-to-merge",
      version: 1,
      root: PR,
      streams: options.shuffleManifest ? [...streams].reverse() : streams,
    },
    dumps,
    contentSha256,
  };
}

function manifestFailure(
  operation: () => unknown,
  code: SessionManifestFailureCode,
): SessionManifestError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionManifestError);
    expect(error).toMatchObject({ code });
    return error as SessionManifestError;
  }
  throw new Error(`expected ${code}`);
}

function replayFailure(
  operation: () => unknown,
  code: SessionReplayFailureCode,
): SessionReplayError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionReplayError);
    expect(error).toMatchObject({ code });
    return error as SessionReplayError;
  }
  throw new Error(`expected ${code}`);
}

describe("E5-T12 session manifest", () => {
  it("accepts canonical JSON with at most one trailing LF and derives portable dump names", () => {
    const { manifest } = fixture();
    const canonical = canonicalJson(manifest);
    expect(parseSessionManifest(canonical)).toEqual(parseSessionManifest(`${canonical}\n`));
    manifestFailure(() => parseSessionManifest(`${canonical}\r\n`), "session/invalid-manifest");
    manifestFailure(() => parseSessionManifest(`${canonical} `), "session/invalid-manifest");
    expect(sessionDumpFileName(PR)).toBe("pr%3Amaple%2Freading-room%2F60.events.jsonl");
  });

  it("rejects every frozen manifest failure with typed stream context", () => {
    const { manifest, dumps } = fixture();

    const unknownRole = {
      ...manifest,
      streams: manifest.streams.map((entry, index) =>
        index === 0 ? { ...entry, role: "future" } : entry,
      ),
    };
    expect(
      manifestFailure(() => parseSessionManifest(unknownRole), "session/unknown-role").stream,
    ).toBe(manifest.streams[0]!.stream);

    const duplicate = { ...manifest, streams: [...manifest.streams, manifest.streams[0]!] };
    expect(
      manifestFailure(() => parseSessionManifest(duplicate), "session/duplicate-stream").stream,
    ).toBe(manifest.streams[0]!.stream);

    expect(
      manifestFailure(
        () => parseSessionManifest({ ...manifest, root: "pr:maple/reading-room/missing" }),
        "session/bad-root",
      ).stream,
    ).toBe("pr:maple/reading-room/missing");

    const missing = new Map(dumps);
    missing.delete(WIKI);
    expect(
      manifestFailure(() => validateSession(manifest, missing), "session/missing-dump").stream,
    ).toBe(WIKI);

    const orphan = new Map(dumps);
    orphan.set("issue:maple/reading-room/orphan", [record(0, "issue.opened", { v: 1 })]);
    expect(
      manifestFailure(() => validateSession(manifest, orphan), "session/orphan-dump").stream,
    ).toBe("issue:maple/reading-room/orphan");

    const wrongHead = {
      ...manifest,
      streams: manifest.streams.map((entry) =>
        entry.stream === ISSUE ? { ...entry, head: ABSENT_OFFSET } : entry,
      ),
    };
    expect(
      manifestFailure(() => validateSession(wrongHead, dumps), "session/head-mismatch"),
    ).toMatchObject({ stream: ISSUE, expected: ABSENT_OFFSET, actual: O1 });
  });
});

describe("E5-T12 pure session replay", () => {
  it("replays the truthful seven-member closure and is manifest-order independent", () => {
    const ordered = fixture();
    const shuffled = fixture({ shuffleManifest: true });
    const first = replaySession(validateSession(ordered.manifest, ordered.dumps), requireReducer);
    const second = replaySession(validateSession(ordered.manifest, ordered.dumps), requireReducer);
    const reordered = replaySession(
      validateSession(`${canonicalJson(shuffled.manifest)}\n`, shuffled.dumps),
      requireReducer,
    );

    expect(first).toEqual(second);
    expect(reordered.digest).toBe(first.digest);
    expect(first.streams).toHaveLength(7);
    expect(first.streams.map(({ stream }) => stream)).toEqual(
      [...ordered.dumps.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(first.links).toEqual({ resolved: 4, unresolved: 0 });
  });

  it("rejects a dangling E5-T07 entity ref with rule 1 provenance", () => {
    const broken = fixture({ entityRefStream: "issue:maple/reading-room/missing" });
    const error = replayFailure(
      () => replaySession(validateSession(broken.manifest, broken.dumps), requireReducer),
      "session/unresolved-link",
    );
    expect(error).toMatchObject({ stream: PR, offset: O0, rule: 1 });
  });

  it("requires issue closedBy.prMergedOffset to name an exact pr.merged record", () => {
    const broken = fixture({ closeMergeOffset: O1 });
    const error = replayFailure(
      () => replaySession(validateSession(broken.manifest, broken.dumps), requireReducer),
      "session/unresolved-link",
    );
    expect(error).toMatchObject({ stream: ISSUE, offset: O1, rule: 2 });
  });

  it("requires the PR fork offset to exist in its target branch dump", () => {
    const broken = fixture({ forkOffset: ABSENT_OFFSET });
    const error = replayFailure(
      () => replaySession(validateSession(broken.manifest, broken.dumps), requireReducer),
      "session/unresolved-link",
    );
    expect(error).toMatchObject({ stream: PR, offset: O0, rule: 3 });
  });

  it("requires evidence content SHA-256 parity across distinct attachment members", () => {
    const valid = fixture();
    const replacement = `${valid.contentSha256[0] === "0" ? "1" : "0"}${valid.contentSha256.slice(1)}`;
    const broken = fixture({ attachmentSha256: replacement });
    const error = replayFailure(
      () => replaySession(validateSession(broken.manifest, broken.dumps), requireReducer),
      "session/unresolved-link",
    );
    expect(error).toMatchObject({ stream: EVIDENCE, offset: O0, rule: 4 });
  });

  it("makes the composite sensitive to any constituent result digest", () => {
    const valid = fixture();
    const replayed = replaySession(validateSession(valid.manifest, valid.dumps), requireReducer);
    const [first, ...rest] = replayed.streams;
    const changedDigest = `${first!.digest[0] === "0" ? "1" : "0"}${first!.digest.slice(1)}`;
    const changed = compositeDigest({
      streams: [{ ...first!, digest: changedDigest }, ...rest],
      links: replayed.links,
    });
    expect(changed).not.toBe(replayed.digest);
  });

  it("keeps the reachable session module graph free of client, server, and network imports", () => {
    const pending = [new URL("../src/session/replay.ts", import.meta.url)];
    const visited = new Set<string>();
    const banned =
      /^(?:@eforest\/(?:client|server|platform)|node:(?:http|https|net|tls|dns)|undici)$/;
    const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

    while (pending.length > 0) {
      const url = pending.pop()!;
      if (visited.has(url.href)) continue;
      visited.add(url.href);
      const source = readFileSync(url, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1]!;
        expect(specifier).not.toMatch(banned);
        if (specifier.startsWith(".")) {
          pending.push(
            new URL(specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : specifier, url),
          );
        } else if (specifier === "@eforest/protocol") {
          pending.push(new URL("../../protocol/src/index.ts", import.meta.url));
        }
      }
    }

    expect([...visited]).toContain(new URL("../src/session/manifest.ts", import.meta.url).href);
  });
});
