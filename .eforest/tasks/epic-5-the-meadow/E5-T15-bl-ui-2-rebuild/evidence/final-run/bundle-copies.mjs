// Counts distinct installed copies of @brett_lamy/* packages in the built bundle by reading
// every inline source map's `sources` (rollup output), keyed by the pnpm store directory.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(process.argv[2], "assets");
const copies = new Map();
let maps = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") || n.endsWith(".css"))) {
  const text = readFileSync(resolve(dir, f), "utf8");
  const m = text.match(/sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/);
  if (!m) continue;
  maps++;
  const map = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  for (const s of map.sources) {
    const hit = s.match(/node_modules\/\.pnpm\/(@brett_lamy\+[a-z-]+@[^/]+)\/node_modules\/(@brett_lamy\/[a-z-]+)\//);
    const direct = s.match(/node_modules\/(@brett_lamy\/[a-z-]+)\//);
    const key = hit ? `${hit[2]} <- ${hit[1]}` : direct ? `${direct[1]} <- (direct)` : undefined;
    if (!key) continue;
    if (!copies.has(key)) copies.set(key, new Set());
    copies.get(key).add(f);
  }
}
const byPkg = new Map();
for (const key of copies.keys()) {
  const pkg = key.split(" <- ")[0];
  byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), key.split(" <- ")[1]]);
}
console.log(`maps=${maps}`);
for (const [k, v] of [...copies].sort()) console.log(`${k} chunks=${v.size}`);
let ok = true;
for (const [pkg, stores] of [...byPkg].sort()) {
  console.log(`PACKAGE ${pkg} copies=${stores.length} ${stores.join(",")}`);
  if (stores.length !== 1) ok = false;
}
for (const need of ["@brett_lamy/ui", "@brett_lamy/docstream", "@brett_lamy/docstream-editor"])
  if (!byPkg.has(need)) { console.log(`MISSING ${need}`); ok = false; }
console.log(ok ? "E5_T15_BUNDLE_SINGLE_COPY_OK" : "E5_T15_BUNDLE_SINGLE_COPY_FAIL");
process.exit(ok ? 0 : 1);
