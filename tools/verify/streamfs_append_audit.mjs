import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = join(process.cwd(), "packages/streamfs/src");
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
}
visit(sourceRoot);

const postFiles = [];
let postCount = 0;
for (const path of files) {
  const source = readFileSync(path, "utf8");
  const count = (source.match(/method:\s*"POST"/g) ?? []).length;
  if (count > 0) {
    postFiles.push(path);
    postCount += count;
  }
}
const fsPath = join(sourceRoot, "fs.ts");
if (postFiles.length !== 1 || postFiles[0] !== fsPath || postCount !== 2) {
  throw new Error(
    `raw append POST surface escaped fs.ts: files=${postFiles.join(",")} count=${postCount}`,
  );
}

const fsSource = readFileSync(fsPath, "utf8");
const dispatchStart = fsSource.indexOf("private async dispatch(");
const dispatchEnd = fsSource.indexOf("\n  }", dispatchStart);
const dispatchBody = dispatchStart >= 0 ? fsSource.slice(dispatchStart, dispatchEnd) : "";
if (!dispatchBody.includes("/dispatch") || !dispatchBody.includes('method: "POST"')) {
  throw new Error("metadata POST append is not visibly routed through /dispatch");
}

const manifest = await import(join(process.cwd(), "packages/client/dist/src/index.js"));
const documented = ["StreamWriter.append", "StreamWriter.flush"];
if (JSON.stringify(manifest.APPEND_SURFACE) !== JSON.stringify(documented)) {
  throw new Error("APPEND_SURFACE manifest differs from the documented client append surface");
}
console.log(
  "streamfs append audit: whole src scanned; APPEND_SURFACE matches; metadata POST is /dispatch only OK",
);
