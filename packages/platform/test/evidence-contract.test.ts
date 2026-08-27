import { readFileSync } from "node:fs";
import {
  ATTACHMENT_EVENT_VERSION,
  EVIDENCE_REFUSAL_REASONS,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_BYTES,
  attachmentInitialStateForStream,
  attachmentReducer,
  contentBytes,
  contentInitialStateForStream,
  contentReducer,
  downloadAttachment,
  encodeCanonicalBase64,
  evidenceContentStreamId,
  evidenceStreamId,
  uploadAttachment,
  type AttachmentListState,
  type EvidenceClient,
  type EvidenceEntityRef,
} from "@eforest/evidence";
import {
  OFFSET_BEFORE_FIRST,
  canonicalJson,
  sha256Hex,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  event,
  openedPayload,
  prSnapshot,
  startPrHttpFixture,
  type DispatchResult,
  type PrHttpFixture,
} from "../../pr/test/helpers.js";

interface LogSnapshot {
  readonly headOffset: Offset | typeof OFFSET_BEFORE_FIRST;
  readonly dumpSha256: string;
}

interface RefusalScenario {
  readonly reason: (typeof EVIDENCE_REFUSAL_REASONS)[number];
  readonly streamId: string;
  readonly action: Event;
  readonly watched: readonly string[];
}

const encoder = new TextEncoder();
const taskEvidence = new URL(
  "../../../.eforest/tasks/epic-5-the-meadow/E5-T10-evidence-attachment-model/evidence/",
  import.meta.url,
);

function artifact(name: string): string {
  return readFileSync(new URL(name, taskEvidence), "utf8");
}

function expectArtifact(name: string, actual: string): void {
  if (process.env.EFOREST_E5_T10_PRINT === "1") {
    console.log(`E5_T10_ARTIFACT_BEGIN ${name}`);
    console.log(actual.trimEnd());
    console.log(`E5_T10_ARTIFACT_END ${name}`);
  }
  expect(actual).toBe(artifact(name));
}

function cleanEvent(record: Event): Event {
  const payload = record.payload as Record<string, unknown>;
  return {
    type: record.type,
    payload: Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
    ts: record.ts,
    ...((record as Event & { readonly offset?: Offset }).offset === undefined
      ? {}
      : { offset: (record as Event & { readonly offset: Offset }).offset }),
  } as Event;
}

async function snapshot(fixture: PrHttpFixture, streamId: string): Promise<LogSnapshot> {
  const records = (await fixture.streams.read(streamId)) as readonly (Event & {
    readonly offset?: Offset;
  })[];
  const dump = records.length === 0 ? "" : `${records.map(canonicalJson).join("\n")}\n`;
  return {
    headOffset: records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
    dumpSha256: sha256Hex(encoder.encode(dump)),
  };
}

async function expectAccepted(result: Promise<DispatchResult>): Promise<DispatchResult> {
  const response = await result;
  expect(response.status, response.body).toBe(202);
  return response;
}

function httpClient(fixture: PrHttpFixture, start: number): EvidenceClient {
  let clock = start;
  return {
    now: () => {
      clock += 1;
      return clock;
    },
    dispatch: async (streamId, current) => {
      const response = await fixture.dispatch(streamId, current);
      if (response.status !== 202) {
        throw new Error(`dispatch ${streamId} failed ${response.status}: ${response.body}`);
      }
      return response;
    },
    read: async (streamId) => (await fixture.streams.read(streamId)) as readonly Event[],
  };
}

function issueRef(entityId: string): EvidenceEntityRef {
  return { org: "maple", repo: "reading-room", entityType: "issue", entityId };
}

async function createIssue(fixture: PrHttpFixture, entityId: string, ts: number): Promise<string> {
  const streamId = `issue:maple/reading-room/${entityId}`;
  await expectAccepted(
    fixture.dispatch(
      streamId,
      event("issue.opened", { v: 1, title: `Evidence ${entityId}`, body: "Attach proof" }, ts),
    ),
  );
  return streamId;
}

async function createEmptyStream(fixture: PrHttpFixture, streamId: string): Promise<void> {
  await fixture.streams.create(streamId);
}

async function sealContent(
  fixture: PrHttpFixture,
  attachmentId: string,
  bytes: Uint8Array,
  ts: number,
): Promise<string> {
  const streamId = evidenceContentStreamId("maple", "reading-room", attachmentId);
  if (bytes.byteLength > 0) {
    await expectAccepted(
      fixture.dispatch(
        streamId,
        event(
          "content.chunk",
          { v: ATTACHMENT_EVENT_VERSION, seq: 0, bytes: encodeCanonicalBase64(bytes) },
          ts,
        ),
      ),
    );
  }
  await expectAccepted(
    fixture.dispatch(
      streamId,
      event(
        "content.sealed",
        {
          v: ATTACHMENT_EVENT_VERSION,
          sha256: sha256Hex(bytes),
          size: bytes.byteLength,
          chunks: bytes.byteLength === 0 ? 0 : 1,
        },
        ts + 1,
      ),
    ),
  );
  return streamId;
}

function attachedEvent(
  attachmentId: string,
  contentStream: string,
  sha256: string,
  size: number,
  ts: number,
): Event {
  return event(
    "evidence.attached",
    {
      v: ATTACHMENT_EVENT_VERSION,
      attachmentId,
      kind: "event-log",
      name: `${attachmentId}.jsonl`,
      mediaType: "application/x-ndjson",
      size,
      sha256,
      contentStream,
    },
    ts,
  );
}

function assertLegalContentLog(streamId: string, records: readonly Event[]): void {
  const clean = records.map(cleanEvent);
  let sealIndex = -1;
  let expectedSeq = 0;
  for (const [index, current] of clean.entries()) {
    if (current.type === "content.chunk") {
      expect(sealIndex).toBe(-1);
      expect((current.payload as { readonly seq: number }).seq).toBe(expectedSeq);
      expectedSeq += 1;
    } else {
      expect(current.type).toBe("content.sealed");
      expect(sealIndex).toBe(-1);
      sealIndex = index;
    }
  }
  const first = clean.reduce(contentReducer, contentInitialStateForStream(streamId));
  const second = clean.reduce(contentReducer, contentInitialStateForStream(streamId));
  expect(stateDigest(first)).toBe(stateDigest(second));
  expect(first.chunks).toBe(expectedSeq);
  expect(first.sha256).toBe(sha256Hex(contentBytes(first)));
}

describe("E5-T10 evidence contract over the real HTTP dispatch door", () => {
  let fixture: PrHttpFixture;

  beforeEach(async () => {
    fixture = await startPrHttpFixture();
  });

  afterEach(async () => {
    await fixture.stop();
  });

  it("attaches content and references to a real issue and a merged PR without moving either entity log", async () => {
    const issue = issueRef("e5-t10-golden");
    const issueStream = await createIssue(fixture, issue.entityId, 100);
    const pr: EvidenceEntityRef = {
      org: "maple",
      repo: "reading-room",
      entityType: "pr",
      entityId: "contract-pr",
    };
    const prStream = await fixture.createPr(pr.entityId);
    await expectAccepted(fixture.dispatch(prStream, event("pr.opened", openedPayload(fixture), 110)));
    await expectAccepted(
      fixture.dispatch(prStream, event("pr.approved", { v: 1, reviewer: "critic" }, 111)),
    );
    await expectAccepted(
      fixture.dispatch(prStream, event("pr.merged", { v: 1, mergedBy: "maintainer" }, 112)),
    );

    const issueBefore = await snapshot(fixture, issueStream);
    const prBefore = await prSnapshot(fixture.streams, prStream);
    expect(prBefore.state.status).toBe("merged");
    const issueBytes = new Uint8Array(
      readFileSync(new URL("e5-t10-source.jsonl", taskEvidence)),
    );
    const prBytes = encoder.encode("merged pull request evidence\n");
    const issueClient = httpClient(fixture, 100);
    const prClient = httpClient(fixture, 300);
    const issueUpload = await uploadAttachment(issueClient, {
      entityRef: issue,
      attachmentId: "issue-golden",
      kind: "event-log",
      name: "golden-issue.jsonl",
      mediaType: "application/x-ndjson",
      bytes: issueBytes,
    });
    const prUpload = await uploadAttachment(prClient, {
      entityRef: pr,
      attachmentId: "pr-content",
      kind: "event-log",
      name: "pr.jsonl",
      mediaType: "application/x-ndjson",
      bytes: prBytes,
    });
    const issueLink = event(
      "evidence.linked",
      {
        v: ATTACHMENT_EVENT_VERSION,
        attachmentId: "replay-golden",
        kind: "replay-recording",
        url: "https://app.replay.io/recording/e5-t10-golden?point=42&time=500",
        title: "Browser proof",
      },
      104,
    );
    const prLink = event(
      "evidence.linked",
      {
        v: ATTACHMENT_EVENT_VERSION,
        attachmentId: "pr-replay",
        kind: "replay-recording",
        url: "https://app.replay.io/recording/e5-t10-pr?point=30&time=40",
        title: "Merged PR proof",
      },
      320,
    );
    await expectAccepted(fixture.dispatch(issueUpload.attachmentStreamId, issueLink));
    await expectAccepted(fixture.dispatch(prUpload.attachmentStreamId, prLink));
    await expectAccepted(
      fixture.dispatch(
        issueUpload.attachmentStreamId,
        event("evidence.detached", { v: 1, attachmentId: "issue-golden" }, 105),
      ),
    );

    const downloadedIssue = await downloadAttachment(issueClient, issueUpload.contentStreamId);
    const downloadedPr = await downloadAttachment(prClient, prUpload.contentStreamId);
    expect(downloadedIssue).toEqual(issueBytes);
    expect(downloadedPr).toEqual(prBytes);
    const issueAfter = await snapshot(fixture, issueStream);
    expect(issueAfter).toEqual(issueBefore);
    const prAfter = await prSnapshot(fixture.streams, prStream);
    expect(prAfter).toEqual(prBefore);

    for (const [streamId, link] of [
      [issueUpload.attachmentStreamId, issueLink],
      [prUpload.attachmentStreamId, prLink],
    ] as const) {
      const records = (await fixture.streams.read(streamId)) as readonly Event[];
      const state = records.reduce(attachmentReducer, attachmentInitialStateForStream(streamId));
      expect(state.attachments).toHaveLength(2);
      const reference = state.attachments[1]!;
      expect(reference).toMatchObject({
        attachmentId: (link.payload as { readonly attachmentId: string }).attachmentId,
        type: "reference",
        kind: "replay-recording",
        url: (link.payload as { readonly url: string }).url,
      });
      expect(reference).not.toHaveProperty("contentStream");
      expect(reference).not.toHaveProperty("sha256");
      const rawLink = cleanEvent(records[1]!);
      expect({ type: rawLink.type, payload: rawLink.payload, ts: rawLink.ts }).toEqual(link);
    }

    const issueEvidence = (
      (await fixture.streams.read(issueUpload.attachmentStreamId)) as readonly Event[]
    ).reduce(
      attachmentReducer,
      attachmentInitialStateForStream(issueUpload.attachmentStreamId),
    );
    const prEvidence = (
      (await fixture.streams.read(prUpload.attachmentStreamId)) as readonly Event[]
    ).reduce(attachmentReducer, attachmentInitialStateForStream(prUpload.attachmentStreamId));
    const cleanIssueContent = (
      (await fixture.streams.read(issueUpload.contentStreamId)) as readonly Event[]
    ).map(cleanEvent);
    const cleanIssueAttachments = (
      (await fixture.streams.read(issueUpload.attachmentStreamId)) as readonly Event[]
    ).map(cleanEvent);
    expect(`${cleanIssueContent.map(canonicalJson).join("\n")}\n`).toBe(
      artifact("e5-t10-content.jsonl"),
    );
    expect(`${cleanIssueAttachments.map(canonicalJson).join("\n")}\n`).toBe(
      artifact("e5-t10-attachments.jsonl"),
    );
    expectArtifact(
      "e5-t10-lifecycle.txt",
      [
        `issue-source=${issueStream} lifecycle=opened head=${issueBefore.headOffset} dump-sha256=${issueBefore.dumpSha256} unchanged=true`,
        `pr-source=${prStream} lifecycle=opened,approved,merged status=${prBefore.state.status} head=${prBefore.headOffset} digest=${prBefore.digest} dump-sha256=${prBefore.dumpSha256} unchanged=true`,
        `issue-evidence=${issueUpload.attachmentStreamId} entries=${issueEvidence.attachments.length} content=1 references=1 downloaded-bytes=${downloadedIssue.byteLength} byte-parity=true`,
        `pr-evidence=${prUpload.attachmentStreamId} entries=${prEvidence.attachments.length} content=1 references=1 downloaded-bytes=${downloadedPr.byteLength} byte-parity=true`,
        "reference-events=2 exact-roundtrip=true bytes-fields=absent",
        "committed-issue-goldens=fresh-dispatch-byte-equal",
        "source-entity-logs-moved=0",
        "",
      ].join("\n"),
    );
  });

  it("drives all fourteen frozen refusal reasons and proves every watched log neutral", async () => {
    const scenarios: RefusalScenario[] = [];
    let ordinal = 0;
    const nextTs = () => 1_000 + ordinal++ * 10;
    const known = async (slug: string): Promise<string> => {
      const ref = issueRef(`refusal-${slug}`);
      await createIssue(fixture, ref.entityId, nextTs());
      const streamId = evidenceStreamId(ref);
      await createEmptyStream(fixture, streamId);
      return streamId;
    };

    const unknownEntity = evidenceStreamId(issueRef("refusal-missing-entity"));
    await createEmptyStream(fixture, unknownEntity);
    scenarios.push({
      reason: "evidence/unknown-entity",
      streamId: unknownEntity,
      action: event("evidence.waived", { v: 1, justification: "stream proof" }, nextTs()),
      watched: [unknownEntity],
    });

    const duplicate = await known("duplicate");
    await expectAccepted(
      fixture.dispatch(
        duplicate,
        event(
          "evidence.linked",
          {
            v: 1,
            attachmentId: "duplicate",
            kind: "replay-recording",
            url: "https://app.replay.io/recording/duplicate-a",
          },
          nextTs(),
        ),
      ),
    );
    scenarios.push({
      reason: "evidence/duplicate-attachment-id",
      streamId: duplicate,
      action: event(
        "evidence.linked",
        {
          v: 1,
          attachmentId: "duplicate",
          kind: "replay-recording",
          url: "https://app.replay.io/recording/duplicate-b",
        },
        nextTs(),
      ),
      watched: [duplicate],
    });

    const unknownAttachment = await known("unknown-attachment");
    scenarios.push({
      reason: "evidence/unknown-attachment",
      streamId: unknownAttachment,
      action: event("evidence.detached", { v: 1, attachmentId: "missing" }, nextTs()),
      watched: [unknownAttachment],
    });

    const alreadyDetached = await known("already-detached");
    await expectAccepted(
      fixture.dispatch(
        alreadyDetached,
        event(
          "evidence.linked",
          {
            v: 1,
            attachmentId: "detached",
            kind: "replay-recording",
            url: "https://app.replay.io/recording/detached",
          },
          nextTs(),
        ),
      ),
    );
    await expectAccepted(
      fixture.dispatch(
        alreadyDetached,
        event("evidence.detached", { v: 1, attachmentId: "detached" }, nextTs()),
      ),
    );
    scenarios.push({
      reason: "evidence/already-detached",
      streamId: alreadyDetached,
      action: event("evidence.detached", { v: 1, attachmentId: "detached" }, nextTs()),
      watched: [alreadyDetached],
    });

    const unsealedOwner = await known("unsealed");
    const unsealedContent = evidenceContentStreamId("maple", "reading-room", "unsealed");
    await expectAccepted(
      fixture.dispatch(
        unsealedContent,
        event("content.chunk", { v: 1, seq: 0, bytes: encodeCanonicalBase64(Uint8Array.of(1)) }, nextTs()),
      ),
    );
    scenarios.push({
      reason: "evidence/unsealed-content",
      streamId: unsealedOwner,
      action: attachedEvent("unsealed", unsealedContent, sha256Hex(Uint8Array.of(1)), 1, nextTs()),
      watched: [unsealedOwner, unsealedContent],
    });

    const notFoundOwner = await known("content-not-found");
    const notFoundContent = evidenceContentStreamId("maple", "reading-room", "not-found");
    scenarios.push({
      reason: "evidence/content-not-found",
      streamId: notFoundOwner,
      action: attachedEvent("not-found", notFoundContent, sha256Hex(new Uint8Array()), 0, nextTs()),
      watched: [notFoundOwner],
    });

    const digestOwner = await known("digest-mismatch");
    const digestContent = await sealContent(fixture, "digest-mismatch", Uint8Array.of(2), nextTs());
    scenarios.push({
      reason: "evidence/digest-mismatch",
      streamId: digestOwner,
      action: attachedEvent("digest-mismatch", digestContent, "0".repeat(64), 1, nextTs()),
      watched: [digestOwner, digestContent],
    });

    const sizeOwner = await known("size-mismatch");
    const sizeBytes = Uint8Array.of(3);
    const sizeContent = await sealContent(fixture, "size-mismatch", sizeBytes, nextTs());
    scenarios.push({
      reason: "evidence/size-mismatch",
      streamId: sizeOwner,
      action: attachedEvent("size-mismatch", sizeContent, sha256Hex(sizeBytes), 2, nextTs()),
      watched: [sizeOwner, sizeContent],
    });

    const oversizedOwner = await known("oversized");
    scenarios.push({
      reason: "evidence/oversized",
      streamId: oversizedOwner,
      action: attachedEvent(
        "oversized",
        evidenceContentStreamId("maple", "reading-room", "oversized"),
        "0".repeat(64),
        MAX_ATTACHMENT_BYTES + 1,
        nextTs(),
      ),
      watched: [oversizedOwner],
    });

    const outOfOrder = evidenceContentStreamId("maple", "reading-room", "out-of-order");
    await createEmptyStream(fixture, outOfOrder);
    scenarios.push({
      reason: "evidence/chunk-out-of-order",
      streamId: outOfOrder,
      action: event(
        "content.chunk",
        { v: 1, seq: 1, bytes: encodeCanonicalBase64(Uint8Array.of(4)) },
        nextTs(),
      ),
      watched: [outOfOrder],
    });

    const terminal = await sealContent(fixture, "terminal", new Uint8Array(), nextTs());
    scenarios.push({
      reason: "evidence/sealed-terminal",
      streamId: terminal,
      action: event(
        "content.chunk",
        { v: 1, seq: 0, bytes: encodeCanonicalBase64(Uint8Array.of(5)) },
        nextTs(),
      ),
      watched: [terminal],
    });

    const invalidUrl = await known("invalid-url");
    scenarios.push({
      reason: "evidence/invalid-url",
      streamId: invalidUrl,
      action: event(
        "evidence.linked",
        { v: 1, attachmentId: "invalid-url", kind: "replay-recording", url: "http://x" },
        nextTs(),
      ),
      watched: [invalidUrl],
    });

    const unknownKind = await known("unknown-kind");
    scenarios.push({
      reason: "evidence/unknown-kind",
      streamId: unknownKind,
      action: event(
        "evidence.linked",
        {
          v: 1,
          attachmentId: "unknown-kind",
          kind: "video",
          url: "https://app.replay.io/recording/unknown-kind",
        },
        nextTs(),
      ),
      watched: [unknownKind],
    });

    const unknownType = "evidence:maple/reading-room/wiki/home";
    await createEmptyStream(fixture, unknownType);
    scenarios.push({
      reason: "evidence/unknown-entity-type",
      streamId: unknownType,
      action: event("evidence.waived", { v: 1, justification: "stream proof" }, nextTs()),
      watched: [unknownType],
    });

    expect(scenarios.map(({ reason }) => reason)).toEqual(EVIDENCE_REFUSAL_REASONS);
    const transcript: string[] = [];
    for (const scenario of scenarios) {
      const before = await Promise.all(
        scenario.watched.map(async (streamId) => ({ streamId, ...(await snapshot(fixture, streamId)) })),
      );
      const response = await fixture.dispatch(scenario.streamId, scenario.action);
      const after = await Promise.all(
        scenario.watched.map(async (streamId) => ({ streamId, ...(await snapshot(fixture, streamId)) })),
      );
      expect(response.status, response.body).toBe(409);
      expect(JSON.parse(response.body)).toEqual({
        error: { class: "validator-rejected", reason: scenario.reason },
      });
      expect(after).toEqual(before);
      transcript.push(
        `E5_T10_REFUSAL ${canonicalJson({
          after,
          before,
          reason: scenario.reason,
          requestBody: JSON.stringify({ streamId: scenario.streamId, event: scenario.action }),
          responseBody: response.body,
          status: response.status,
        })}`,
      );
    }
    expectArtifact("e5-t10-refusals.txt", `${transcript.join("\n")}\n`);
  });

  it("holds the exact 512 KiB and 16 MiB decoded boundaries at the door", async () => {
    const exactChunkStream = evidenceContentStreamId("maple", "reading-room", "exact-chunk");
    const exactChunk = Uint8Array.from({ length: MAX_CHUNK_BYTES }, (_, index) => index & 0xff);
    await expectAccepted(
      fixture.dispatch(
        exactChunkStream,
        event("content.chunk", { v: 1, seq: 0, bytes: encodeCanonicalBase64(exactChunk) }, 2_000),
      ),
    );

    const oversizedChunkStream = evidenceContentStreamId(
      "maple",
      "reading-room",
      "oversized-chunk",
    );
    await createEmptyStream(fixture, oversizedChunkStream);
    const oversizedBefore = await snapshot(fixture, oversizedChunkStream);
    const oversized = await fixture.dispatch(
      oversizedChunkStream,
      event(
        "content.chunk",
        {
          v: 1,
          seq: 0,
          bytes: encodeCanonicalBase64(new Uint8Array(MAX_CHUNK_BYTES + 1)),
        },
        2_001,
      ),
    );
    expect(oversized.status).toBe(409);
    expect(JSON.parse(oversized.body)).toEqual({
      error: { class: "validator-rejected", reason: "evidence/oversized" },
    });
    expect(await snapshot(fixture, oversizedChunkStream)).toEqual(oversizedBefore);

    const exactTotalStream = evidenceContentStreamId("maple", "reading-room", "exact-total");
    const chunkBase64 = encodeCanonicalBase64(exactChunk);
    for (let seq = 0; seq < MAX_ATTACHMENT_BYTES / MAX_CHUNK_BYTES; seq += 1) {
      await expectAccepted(
        fixture.dispatch(
          exactTotalStream,
          event("content.chunk", { v: 1, seq, bytes: chunkBase64 }, 2_100 + seq),
        ),
      );
    }
    const totalBeforeOverflow = await snapshot(fixture, exactTotalStream);
    const overflow = await fixture.dispatch(
      exactTotalStream,
      event(
        "content.chunk",
        {
          v: 1,
          seq: MAX_ATTACHMENT_BYTES / MAX_CHUNK_BYTES,
          bytes: encodeCanonicalBase64(Uint8Array.of(1)),
        },
        2_200,
      ),
    );
    expect(overflow.status).toBe(409);
    expect(JSON.parse(overflow.body)).toEqual({
      error: { class: "validator-rejected", reason: "evidence/oversized" },
    });
    expect(await snapshot(fixture, exactTotalStream)).toEqual(totalBeforeOverflow);
    const totalBytes = new Uint8Array(MAX_ATTACHMENT_BYTES);
    for (let start = 0; start < totalBytes.byteLength; start += exactChunk.byteLength) {
      totalBytes.set(exactChunk, start);
    }
    await expectAccepted(
      fixture.dispatch(
        exactTotalStream,
        event(
          "content.sealed",
          {
            v: 1,
            sha256: sha256Hex(totalBytes),
            size: MAX_ATTACHMENT_BYTES,
            chunks: MAX_ATTACHMENT_BYTES / MAX_CHUNK_BYTES,
          },
          2_201,
        ),
      ),
    );
    const totalRecords = (await fixture.streams.read(exactTotalStream)) as readonly Event[];
    const totalState = totalRecords.reduce(
      contentReducer,
      contentInitialStateForStream(exactTotalStream),
    );
    expect(totalState).toMatchObject({
      sealed: true,
      size: MAX_ATTACHMENT_BYTES,
      chunks: MAX_ATTACHMENT_BYTES / MAX_CHUNK_BYTES,
      sha256: sha256Hex(totalBytes),
    });

    expectArtifact(
      "e5-t10-boundaries.txt",
      [
        `exact-chunk=${MAX_CHUNK_BYTES} status=202`,
        `over-chunk=${MAX_CHUNK_BYTES + 1} status=409 reason=evidence/oversized log-neutral=true`,
        `exact-total=${MAX_ATTACHMENT_BYTES} chunks=${MAX_ATTACHMENT_BYTES / MAX_CHUNK_BYTES} sealed=true`,
        `over-total=${MAX_ATTACHMENT_BYTES + 1} status=409 reason=evidence/oversized log-neutral=true`,
        "",
      ].join("\n"),
    );
  }, 240_000);

  it("serializes concurrent chunk and seal races into legal deterministic logs", async () => {
    const raceRuns = 16;
    let accepted = 0;
    let refused = 0;
    for (let run = 0; run < raceRuns; run += 1) {
      const chunkRace = evidenceContentStreamId("maple", "reading-room", `race-chunk-${run}`);
      const chunkResults = await Promise.all([
        fixture.dispatch(
          chunkRace,
          event("content.chunk", { v: 1, seq: 0, bytes: encodeCanonicalBase64(Uint8Array.of(1)) }, 3_000 + run),
        ),
        fixture.dispatch(
          chunkRace,
          event("content.chunk", { v: 1, seq: 0, bytes: encodeCanonicalBase64(Uint8Array.of(2)) }, 3_100 + run),
        ),
      ]);
      expect(chunkResults.map(({ status }) => status).sort()).toEqual([202, 409]);
      accepted += chunkResults.filter(({ status }) => status === 202).length;
      refused += chunkResults.filter(({ status }) => status === 409).length;
      const chunkRecords = (await fixture.streams.read(chunkRace)) as readonly Event[];
      expect(chunkRecords).toHaveLength(1);
      assertLegalContentLog(chunkRace, chunkRecords);

      const sealChunkRace = evidenceContentStreamId(
        "maple",
        "reading-room",
        `race-seal-chunk-${run}`,
      );
      const base = Uint8Array.of(run & 0xff);
      await expectAccepted(
        fixture.dispatch(
          sealChunkRace,
          event("content.chunk", { v: 1, seq: 0, bytes: encodeCanonicalBase64(base) }, 3_200 + run),
        ),
      );
      const seal = event(
        "content.sealed",
        { v: 1, chunks: 1, size: 1, sha256: sha256Hex(base) },
        3_300 + run,
      );
      const nextChunk = event(
        "content.chunk",
        { v: 1, seq: 1, bytes: encodeCanonicalBase64(Uint8Array.of(255 - run)) },
        3_400 + run,
      );
      const sealChunkResults = await Promise.all(
        run % 2 === 0
          ? [fixture.dispatch(sealChunkRace, seal), fixture.dispatch(sealChunkRace, nextChunk)]
          : [fixture.dispatch(sealChunkRace, nextChunk), fixture.dispatch(sealChunkRace, seal)],
      );
      expect(sealChunkResults.map(({ status }) => status).sort()).toEqual([202, 409]);
      accepted += sealChunkResults.filter(({ status }) => status === 202).length;
      refused += sealChunkResults.filter(({ status }) => status === 409).length;
      assertLegalContentLog(
        sealChunkRace,
        (await fixture.streams.read(sealChunkRace)) as readonly Event[],
      );

      const sealRace = evidenceContentStreamId("maple", "reading-room", `race-seal-${run}`);
      const emptySeal = event(
        "content.sealed",
        { v: 1, chunks: 0, size: 0, sha256: sha256Hex(new Uint8Array()) },
        3_500 + run,
      );
      const sealResults = await Promise.all([
        fixture.dispatch(sealRace, emptySeal),
        fixture.dispatch(sealRace, { ...emptySeal, ts: emptySeal.ts + 100 }),
      ]);
      expect(sealResults.map(({ status }) => status).sort()).toEqual([202, 409]);
      accepted += sealResults.filter(({ status }) => status === 202).length;
      refused += sealResults.filter(({ status }) => status === 409).length;
      const sealRecords = (await fixture.streams.read(sealRace)) as readonly Event[];
      expect(sealRecords).toHaveLength(1);
      assertLegalContentLog(sealRace, sealRecords);
    }

    expectArtifact(
      "e5-t10-concurrency.txt",
      [
        `race-runs=${raceRuns}`,
        `chunk-vs-chunk accepted=${raceRuns} refused=${raceRuns}`,
        `seal-vs-chunk accepted=${raceRuns} refused=${raceRuns}`,
        `seal-vs-seal accepted=${raceRuns} refused=${raceRuns}`,
        `accepted-total=${accepted}`,
        `refused-total=${refused}`,
        "illegal-logs=0",
        "",
      ].join("\n"),
    );
  });
});
