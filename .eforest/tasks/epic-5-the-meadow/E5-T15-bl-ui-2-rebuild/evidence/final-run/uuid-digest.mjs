import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
const root = process.argv[2]; const dir = process.argv[3];
const { reducerForStream, replayWithReducer } = await import(resolve(root, "packages/reducers/dist/src/index.js"));
for (const name of readdirSync(dir).filter((n) => n.endsWith(".events.jsonl")).sort()) {
  const streamId = decodeURIComponent(name.replace(/\.events\.jsonl$/, ""));
  const events = readFileSync(resolve(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const def = reducerForStream(streamId);
  const { digest } = replayWithReducer(def, events, streamId);
  console.log(`${streamId} head=${events.at(-1)?.offset} digest=${digest}`);
}
