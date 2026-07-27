import { stateDigest } from "../../packages/protocol/dist/src/index.js";

export const initialState = Object.freeze({ records: Object.freeze([]) });

export function reducer(state, record) {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.type !== "fs.file.content" ||
    typeof record.ts !== "number" ||
    !Number.isFinite(record.ts) ||
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload) ||
    record.payload.v !== 2 ||
    typeof record.payload.contentStreamId !== "string" ||
    typeof record.payload.contentBase64 !== "string"
  ) {
    throw new TypeError("canopy/content-invalid");
  }
  const bytes = Buffer.from(record.payload.contentBase64, "base64");
  if (bytes.toString("base64") !== record.payload.contentBase64) {
    throw new TypeError("canopy/content-noncanonical-base64");
  }
  return {
    records: [
      ...state.records,
      {
        contentStreamId: record.payload.contentStreamId,
        contentSha256: stateDigest([...bytes]),
        size: bytes.byteLength,
        ts: record.ts,
      },
    ],
  };
}
