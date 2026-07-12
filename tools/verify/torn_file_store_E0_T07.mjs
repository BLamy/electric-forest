import { cpSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FILE_STORE_HEADER,
  FileStoreIntegrityError,
  FileStreamStore,
  streamLogPath,
} from "../../packages/server/dist/src/store/file.js";

const evidencePath = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function frameSpans(bytes) {
  const headerBytes = Buffer.byteLength(FILE_STORE_HEADER);
  const spans = [];
  let cursor = headerBytes;
  while (cursor < bytes.length) {
    const payloadLength = bytes.readUInt32BE(cursor);
    const total = 4 + payloadLength + 32;
    spans.push({ start: cursor, payloadStart: cursor + 4, payloadLength, end: cursor + total });
    cursor += total;
  }
  return spans;
}

function copyDataDir(source, root, name) {
  const target = join(root, name);
  cpSync(source, target, { recursive: true });
  return target;
}

function makeBase() {
  const dataDir = mkdtempSync(join(tmpdir(), "eforest-e0-t07-torn-base-"));
  const store = new FileStreamStore(dataDir);
  store.create("torn", { version: 1 });
  store.append("torn", [{ type: "set", payload: 1, ts: 1 }], 0);
  store.append("torn", [{ type: "set", payload: 2, ts: 2 }], 1);
  store.append("torn", [{ type: "set", payload: 3, ts: 3 }], 2);
  return dataDir;
}

function main() {
  const baseDir = makeBase();
  const scratch = mkdtempSync(join(tmpdir(), "eforest-e0-t07-torn-runs-"));
  try {
    const basePath = streamLogPath(baseDir, "torn");
    const baseBytes = readFileSync(basePath);
    const spans = frameSpans(baseBytes);
    const last = spans.at(-1);
    assert(last, "missing final append frame");
    const cuts = {
      "mid-length-prefix": last.start + 2,
      "mid-payload": last.payloadStart + Math.floor(last.payloadLength / 2),
      "mid-checksum": last.payloadStart + last.payloadLength + 16,
    };
    const truncations = [];
    for (const [name, cut] of Object.entries(cuts)) {
      const dataDir = copyDataDir(baseDir, scratch, name);
      const path = streamLogPath(dataDir, "torn");
      truncateSync(path, cut);
      const recovered = new FileStreamStore(dataDir).dump("torn");
      assert(recovered.length === 2, `${name} returned a partial record`);
      truncations.push({ name, byte: cut, result: "recovered-to-two-complete-records" });
    }

    const interiorDir = copyDataDir(baseDir, scratch, "interior-corruption");
    const interiorPath = streamLogPath(interiorDir, "torn");
    const corrupted = readFileSync(interiorPath);
    const interior = spans[1];
    corrupted[interior.payloadStart + 1] ^= 0xff;
    writeFileSync(interiorPath, corrupted);
    let integrityError = "";
    try {
      new FileStreamStore(interiorDir);
    } catch (error) {
      assert(error instanceof FileStoreIntegrityError, "interior corruption did not raise FileStoreIntegrityError");
      integrityError = error.message;
    }
    assert(integrityError.includes("torn") && integrityError.includes("byte"), "integrity error lacked location");
    const result = { task: "E0-T07", truncations, interiorCorruption: integrityError };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (evidencePath) writeFileSync(evidencePath, serialized);
    process.stdout.write(serialized);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
