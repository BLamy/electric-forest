import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve("vendor/emulate/packages/emulate/dist/index.js");
const shebang = "#!/usr/bin/env node\n";
const source = await readFile(path, "utf8");
let body = source;
let count = 0;
while (body.startsWith(shebang)) {
  body = body.slice(shebang.length);
  count += 1;
}
if (count === 0) throw new Error("emulate CLI build is missing its node shebang");
if (count > 1) await writeFile(path, `${shebang}${body}`);
process.stdout.write(
  `EMULATE_CLI_SHEBANG_OK count=${String(count)} normalized=${String(count > 1)}\n`,
);
