import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex, stateDigest, type Event } from "@eforest/protocol";
import {
  ATTACHMENT_EVENT_VERSION,
  EvidenceRefusalError,
  contentBytes,
  contentInitialStateValue,
  contentReducer,
  downloadAttachment,
  encodeCanonicalBase64,
  entityStreamId,
  evidenceContentStreamId,
  evidenceStreamId,
  reduceContentEvents,
  uploadAttachment,
  type EvidenceEntityRef,
} from "../src/index.js";
import { InMemoryEvidenceDoor, event } from "./helpers.js";

interface PropertyCorpus {
  readonly seeds: readonly number[];
  readonly casesPerSeed: number;
  readonly totalCases: number;
}

const entityRef: EvidenceEntityRef = {
  org: "blamy",
  repo: "electric-forest",
  entityType: "issue",
  entityId: "E5-T10-property",
};

function propertyCorpus(): PropertyCorpus {
  const source = readFileSync(
    new URL(
      "../../../.eforest/tasks/epic-5-the-meadow/E5-T10-evidence-attachment-model/evidence/e5-t10-property.txt",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source.endsWith("\n")).toBe(true);
  const lines = source.trim().split("\n");
  const seeds = lines
    .filter((line) => line.startsWith("seed="))
    .map((line) => Number.parseInt(line.slice("seed=".length), 16));
  const casesPerSeed = Number(
    lines.find((line) => line.startsWith("cases-per-seed="))?.split("=")[1],
  );
  const totalCases = Number(lines.find((line) => line.startsWith("total-cases="))?.split("=")[1]);
  expect(seeds.length).toBeGreaterThan(0);
  expect(new Set(seeds).size).toBe(seeds.length);
  expect(Number.isSafeInteger(casesPerSeed)).toBe(true);
  expect(seeds.length * casesPerSeed).toBe(totalCases);
  expect(totalCases).toBeGreaterThanOrEqual(500);
  return { seeds, casesPerSeed, totalCases };
}

function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function generatedBytes(next: () => number, ordinal: number): Uint8Array {
  if (ordinal === 0) return new Uint8Array();
  if (ordinal === 1) return Uint8Array.from({ length: 256 }, (_, value) => value);
  const length = Math.floor(next() * 4097);
  return Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

function replay(records: readonly Event[]) {
  const first = reduceContentEvents(records);
  const second = reduceContentEvents(records);
  expect(stateDigest(first)).toBe(stateDigest(second));
  return first;
}

describe("deterministic evidence property corpus", () => {
  it("round-trips at least 500 generated binary uploads and keeps every refusal log-neutral", async () => {
    const corpus = propertyCorpus();
    let executed = 0;

    for (const seed of corpus.seeds) {
      const next = random(seed);
      for (let caseIndex = 0; caseIndex < corpus.casesPerSeed; caseIndex += 1) {
        const ordinal = executed;
        const bytes = generatedBytes(next, caseIndex);
        const attachmentId = `seed-${seed.toString(16)}-case-${caseIndex}`;
        const door = new InMemoryEvidenceDoor();
        door.seedEntity(entityStreamId(entityRef));
        const uploaded = await uploadAttachment(door, {
          entityRef,
          attachmentId,
          kind: caseIndex % 2 === 0 ? "event-log" : "rr-trace",
          name: `${attachmentId}.bin`,
          mediaType: "application/octet-stream",
          bytes,
        });

        expect(await downloadAttachment(door, uploaded.contentStreamId)).toEqual(bytes);
        const contentRecords = await door.read(uploaded.contentStreamId);
        const contentState = replay(contentRecords);
        expect(contentState).toMatchObject({
          sealed: true,
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
        });
        expect(contentBytes(contentState)).toEqual(bytes);

        const attachmentStream = evidenceStreamId(entityRef);
        const refusalIndex = Math.floor(next() * 5);
        let targetStream = attachmentStream;
        let refused: Event;
        if (refusalIndex === 0) {
          targetStream = uploaded.contentStreamId;
          refused = event("content.chunk", {
            v: ATTACHMENT_EVENT_VERSION,
            seq: uploaded.chunks,
            bytes: encodeCanonicalBase64(Uint8Array.of(ordinal & 0xff)),
          });
        } else if (refusalIndex === 1) {
          targetStream = uploaded.contentStreamId;
          refused = event("content.sealed", {
            v: ATTACHMENT_EVENT_VERSION,
            chunks: uploaded.chunks,
            size: uploaded.size,
            sha256: uploaded.sha256,
          });
        } else if (refusalIndex === 2) {
          refused = event("evidence.attached", {
            v: ATTACHMENT_EVENT_VERSION,
            attachmentId,
            kind: caseIndex % 2 === 0 ? "event-log" : "rr-trace",
            name: `${attachmentId}.bin`,
            mediaType: "application/octet-stream",
            size: uploaded.size,
            sha256: uploaded.sha256,
            contentStream: uploaded.contentStreamId,
          });
        } else if (refusalIndex === 3) {
          refused = event("evidence.linked", {
            v: ATTACHMENT_EVENT_VERSION,
            attachmentId,
            kind: "replay-recording",
            url: `https://app.replay.io/recording/${attachmentId}`,
          });
        } else {
          refused = event("evidence.detached", {
            v: ATTACHMENT_EVENT_VERSION,
            attachmentId: `missing-${attachmentId}`,
          });
        }
        const before = await door.read(targetStream);
        await expect(door.dispatch(targetStream, refused)).rejects.toBeInstanceOf(
          EvidenceRefusalError,
        );
        expect(await door.read(targetStream)).toEqual(before);

        if (caseIndex % 16 === 0) {
          const payload = bytes.byteLength === 0 ? Uint8Array.of(0) : bytes.slice(0, 1);
          const chunk = event("content.chunk", {
            v: ATTACHMENT_EVENT_VERSION,
            seq: 0,
            bytes: encodeCanonicalBase64(payload),
          });
          const failed = contentReducer(
            contentReducer(contentInitialStateValue(), chunk),
            event("content.sealed", {
              v: ATTACHMENT_EVENT_VERSION,
              chunks: 1,
              size: payload.byteLength,
              sha256: "0".repeat(64),
            }),
          );
          const healed = contentReducer(
            failed,
            event("content.sealed", {
              v: ATTACHMENT_EVENT_VERSION,
              chunks: 1,
              size: payload.byteLength,
              sha256: sha256Hex(payload),
            }),
          );
          expect(healed).toBe(failed);
          expect(healed).toMatchObject({ sealed: false, sealError: "digest-mismatch" });
        }
        expect(evidenceContentStreamId(entityRef.org, entityRef.repo, attachmentId)).toBe(
          uploaded.contentStreamId,
        );
        executed += 1;
      }
    }

    expect(executed).toBe(corpus.totalCases);
  });
});
