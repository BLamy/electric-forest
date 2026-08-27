import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendDurableJson,
  createDurableJsonStream,
} from "../../packages/client/dist/src/index.js";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import {
  captureSession,
  parseSessionManifest,
  sessionDumpFileName,
  type SessionRecord,
} from "../../packages/cli/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const fixture = resolve(root, "packages/cli/fixtures/sessions/issue-to-merge");
const outIndex = process.argv.indexOf("--out");
const requestedOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
const scratch =
  requestedOut === undefined ? await mkdtemp(join(tmpdir(), "e5-t12-session-")) : undefined;
const out = resolve(requestedOut ?? join(scratch!, "issue-to-merge"));
const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });

try {
  const baseUrl = await server.start();
  const manifest = parseSessionManifest(await readFile(join(fixture, "session.json"), "utf8"));
  for (const entry of manifest.streams) {
    const url = `${baseUrl}/streams/${encodeURIComponent(entry.stream)}`;
    await createDurableJsonStream({ url });
    const records = (await readFile(join(fixture, sessionDumpFileName(entry.stream)), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionRecord);
    for (const record of records) await appendDurableJson({ url }, record, record.offset);
  }

  const unrelated = "issue:maple/reading-room/unrelated";
  const unrelatedUrl = `${baseUrl}/streams/${encodeURIComponent(unrelated)}`;
  await createDurableJsonStream({ url: unrelatedUrl });
  await appendDurableJson(
    { url: unrelatedUrl },
    {
      offset: "0000000000000000_0000000000000000",
      type: "issue.opened",
      payload: { v: 1, title: "Unrelated", body: "Closure must exclude this stream" },
      ts: 99,
    },
    "0000000000000000_0000000000000000",
  );

  const captured = await captureSession({ server: baseUrl, root: manifest.root, out });
  process.stdout.write(
    `LIVE-SESSION streams=${captured.manifest.streams.length} composite=${captured.replay.digest} out=${captured.directory} OK\n`,
  );
} finally {
  await server.stop();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
}
