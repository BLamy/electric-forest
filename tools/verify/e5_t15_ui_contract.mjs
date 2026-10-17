#!/usr/bin/env node
// E5-T15 UI contract: the web app renders on @brett_lamy/ui@2.0.0 + Tailwind v4 with owned
// github-clone / discord-clone registry blocks, and the three kept foundations (the Docstream
// Markdown adapter, @pierre/diffs, @pierre/trees) remain the only Markdown / diff / tree renderers.
//
//   node tools/verify/e5_t15_ui_contract.mjs      → prints E5_T15_UI_CONTRACT_OK … or exits 1
//
// Every failed assertion prints its own `E5_T15_CONTRACT_FAIL <id>: <detail>` line.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import * as prettier from "prettier";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../.."));
const web = join(root, "apps/web");
const src = join(web, "src");
const blocks = join(src, "blocks");
const upstreamDir = join(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T15-bl-ui-2-rebuild/evidence/upstream",
);
const failures = [];
let checks = 0;

function check(id, ok, detail) {
  checks += 1;
  if (!ok) failures.push(`E5_T15_CONTRACT_FAIL ${id}: ${detail}`);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function walk(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, predicate));
    else if (predicate(path)) out.push(path);
  }
  return out.sort();
}

const isSource = (path) => /\.(?:ts|tsx)$/.test(path);
const sources = walk(src, isSource);
const rel = (path) => relative(root, path);

/* ── 1. Exact pins and a single resolved copy ── */
const manifest = JSON.parse(read(join(web, "package.json")));
const deps = { ...manifest.dependencies, ...manifest.devDependencies };
check(
  "pin-ui",
  deps["@brett_lamy/ui"] === "2.0.0",
  `@brett_lamy/ui is ${String(deps["@brett_lamy/ui"])}, not exactly 2.0.0`,
);
check(
  "pin-docstream",
  deps["@brett_lamy/docstream"] === "1.5.0",
  `@brett_lamy/docstream is ${String(deps["@brett_lamy/docstream"])}, not 1.5.0 (the copy ui@2.0.0 depends on)`,
);
check(
  "pin-docstream-editor",
  deps["@brett_lamy/docstream-editor"] === "1.5.0",
  `@brett_lamy/docstream-editor is ${String(deps["@brett_lamy/docstream-editor"])}, not 1.5.0`,
);
for (const name of ["tailwindcss", "@tailwindcss/vite", "react-aria-components", "framer-motion"]) {
  check(
    `pin-${name}`,
    /^\d+\.\d+\.\d+$/.test(deps[name] ?? ""),
    `${name} must be an exact version, got ${String(deps[name])}`,
  );
}
const lock = read(join(root, "pnpm-lock.yaml"));
const importer = /\n {2}apps\/web:\n([\s\S]*?)\n {2}\S/.exec(lock)?.[1] ?? "";
const locked = (name) =>
  new RegExp(
    `'?${name.replace("/", "\\/")}'?:\\n\\s+specifier: ([^\\n]+)\\n\\s+version: ([^(\\n]+)`,
  ).exec(importer);
for (const [name, version] of [
  ["@brett_lamy/ui", "2.0.0"],
  ["@brett_lamy/docstream", "1.5.0"],
  ["@brett_lamy/docstream-editor", "1.5.0"],
]) {
  const entry = locked(name);
  check(
    `lock-${name}`,
    entry !== null && entry[1] === version && entry[2] === version,
    `pnpm-lock resolves ${name} for apps/web as ${entry === null ? "nothing" : `${entry[1]} → ${entry[2]}`}, not ${version}`,
  );
  const copies = new Set(
    [
      ...lock.matchAll(new RegExp(`\\n {2}'?${name.replace("/", "\\/")}@([0-9][^(:'\\n]*)`, "g")),
    ].map((m) => m[1]),
  );
  check(
    `lock-single-${name}`,
    copies.size === 1 && copies.has(version),
    `pnpm-lock carries ${name} versions [${[...copies].join(", ")}]`,
  );
}

/* ── 2. Tailwind v4 wiring ── */
const viteConfig = read(join(web, "vite.config.ts"));
check(
  "vite-tailwind",
  /from "@tailwindcss\/vite"/.test(viteConfig) && /tailwindcss\(\)/.test(viteConfig),
  "vite.config.ts does not run @tailwindcss/vite",
);
check(
  "vite-no-docstream-alias",
  !/find:[^\n]*docstream/.test(viteConfig),
  "vite.config.ts aliases a Docstream specifier (it would hijack ui@2.0.0's own import)",
);
const appCss = read(join(src, "styles/app.css"));
check(
  "css-entry",
  /@import "tailwindcss" source\(none\);/.test(appCss),
  'styles/app.css must start Tailwind with `@import "tailwindcss" source(none);`',
);
const sourceLines = [...appCss.matchAll(/^@source "([^"]+)";/gm)].map((m) => m[1]);
check(
  "css-source-blocks",
  sourceLines.includes("../blocks"),
  'styles/app.css has no `@source "../blocks";` for the owned registry blocks',
);
check(
  "css-source-ui-dist",
  sourceLines.some((line) => line.includes("@brett_lamy/ui/dist")),
  "styles/app.css does not scan @brett_lamy/ui's dist",
);
for (const entry of readdirSync(src)) {
  const path = join(src, entry);
  if (!statSync(path).isDirectory() || entry === "styles") continue;
  const hasSource = walk(path, isSource).some(
    (file) => /\.tsx$/.test(file) || /className/.test(read(file)),
  );
  if (!hasSource) continue;
  check(
    `css-source-${entry}`,
    sourceLines.includes(`../${entry}`),
    `src/${entry} has class names but no @source line — its utilities would be purged`,
  );
}
check(
  "css-source-root",
  sourceLines.includes("../*.tsx"),
  "styles/app.css does not scan src/*.tsx",
);
const main = read(join(src, "main.tsx"));
check(
  "main-imports",
  /import "\.\/styles\/app\.css";/.test(main) &&
    /import "@brett_lamy\/ui\/styles\.css";/.test(main),
  "main.tsx must import the package sheet and styles/app.css",
);
for (const legacy of [
  "styles.css",
  "styles/product-shell.css",
  "styles/tokens.css",
  "chat/run-accordion.css",
]) {
  check(`legacy-css-${legacy}`, !existsSync(join(src, legacy)), `src/${legacy} still exists`);
}

/* ── 3. Deleted chrome ── */
for (const gone of [
  "vendor/chatkit",
  "components/ui",
  "components/mobile",
  "components/touchkit",
]) {
  check(
    `deleted-${gone}`,
    !existsSync(join(src, gone)),
    `src/${gone} exists (its chrome was replaced by the package and owned blocks)`,
  );
}

/* ── 4. No block mock data ── */
check(
  "blocks-exist",
  existsSync(join(blocks, "github")) && existsSync(join(blocks, "chat")),
  "src/blocks/github and src/blocks/chat must exist",
);
const blockFiles = walk(blocks, isSource);
check(
  "no-data-ts",
  !walk(blocks).some((file) => /(^|\/)data\.tsx?$/.test(file)),
  "a block data.ts mock exists under src/blocks",
);
const MOCK_IDENTIFIERS =
  /\b(REPO|PULLS|ISSUES|ISSUE_COUNTS|PR_COUNTS|PR_TIMELINE|PR_FILES|PR_COMMITS|PR_CHECKS|README_MD|TREE|USERS|ME|CHANNELS|PRESENCE|WORKSPACES|BOT_REPLY|RUNS|WORKFLOWS|LABELS)\b/;
const MOCK_LITERALS =
  /acme|orbit|Alex|Rivera|maya-chen|jonasw|priya-r|leodm|samokafor|avakim|orbit-bot|12\.4k|stitch|today's digest/;
for (const file of sources) {
  const text = read(file);
  check(
    `no-data-import:${rel(file)}`,
    !/from ["']\.{1,2}\/(?:[\w-]+\/)*data(?:\.(?:js|ts))?["']/.test(text) ||
      !file.startsWith(blocks),
    `${rel(file)} imports a block data module`,
  );
  if (file.startsWith(blocks)) {
    const hit = MOCK_IDENTIFIERS.exec(text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""));
    check(
      `no-mock-identifier:${rel(file)}`,
      hit === null,
      `${rel(file)} references block mock identifier ${hit?.[0]}`,
    );
  }
  const literal = MOCK_LITERALS.exec(text);
  check(
    `no-mock-literal:${rel(file)}`,
    literal === null,
    `${rel(file)} contains block mock literal "${literal?.[0]}"`,
  );
}

/* ── 5. Markdown enters only the Docstream adapter ── */
const adapter = join(src, "components/markdown/Markdown.tsx");
const adapterText = read(adapter);
check(
  "adapter-sanitizes",
  /GitbookStreamdown markdown=\{markdown\}/.test(adapterText) &&
    /sanitizeMarkdownForRender\(props\.source\)/.test(adapterText),
  "Markdown.tsx must render GitbookStreamdown with the sanitized source",
);
const BYPASS =
  /\b(MarkdownView|MessageMarkdown|FbMd|GitbookStreamdown|MarkdownEditor|RichText|dangerouslySetInnerHTML|innerHTML)\b|@brett_lamy\/docstream\/streamdown/;
for (const file of sources) {
  if (file === adapter || /\.test\.tsx?$/.test(file)) continue;
  const code = read(file).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  const hit = BYPASS.exec(code);
  check(
    `markdown-adapter-only:${rel(file)}`,
    hit === null,
    `${rel(file)} uses ${hit?.[0]} (Markdown must enter components/markdown/Markdown.tsx)`,
  );
}
for (const [file, surface] of [
  ["wiki/WikiPage.tsx", "wiki page"],
  ["issues/IssueDetail.tsx", "issue body"],
  ["blocks/github/pull-request.tsx", "PR comment"],
  ["blocks/chat/channel-message.tsx", "chat message"],
  ["blocks/github/code-tab.tsx", "README / Markdown file"],
]) {
  check(
    `markdown-surface:${file}`,
    /<Markdown\b/.test(read(join(src, file))),
    `${file} no longer renders the ${surface} through <Markdown>`,
  );
}

/* ── 6. Diffs through @pierre/diffs, trees through @pierre/trees; no lookalikes ── */
const importers = (pattern) => sources.filter((file) => pattern.test(read(file))).map(rel);
check(
  "diffs-importers",
  JSON.stringify(importers(/from "@pierre\/diffs/)) ===
    JSON.stringify(["apps/web/src/blocks/github/pull-request.tsx"]),
  `@pierre/diffs imported by [${importers(/from "@pierre\/diffs/).join(", ")}]`,
);
check(
  "trees-importers",
  JSON.stringify(importers(/from "@pierre\/trees/)) ===
    JSON.stringify(["apps/web/src/components/trees/RepositoryTree.tsx"]),
  `@pierre/trees imported by [${importers(/from "@pierre\/trees/).join(", ")}]`,
);
const prView = read(join(src, "blocks/github/pull-request.tsx"));
check(
  "pr-multifilediff",
  /<MultiFileDiff\b/.test(prView) && /<PierrePathTree\b/.test(prView),
  "pull-request.tsx must render MultiFileDiff and PierrePathTree for Changes",
);
check(
  "code-repository-tree",
  /<RepositoryTree\b/.test(read(join(src, "blocks/github/code-tab.tsx"))),
  "code-tab.tsx must render the Pierre RepositoryTree sidebar",
);
const LOOKALIKE =
  /\b(?:function|const)\s+(FileTree|TreeItem|DiffView|CodeView|parsePatch|DiffLines)\b|<(?:DiffView|FileTree|CodeView|SurfaceDiff|SurfaceFiles)\b|\b(SurfaceDiff|SurfaceFiles)\b/;
for (const file of sources) {
  if (file.endsWith("components/trees/RepositoryTree.tsx")) continue;
  const hit = LOOKALIKE.exec(read(file).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""));
  check(
    `no-lookalike:${rel(file)}`,
    hit === null,
    `${rel(file)} defines or renders ${hit?.[0]} (diffs/trees must be Pierre)`,
  );
}

/* ── 7. Compact navigation is the package's own (no data-slot lookalikes) ── */
for (const file of sources) {
  const hit = /["'](navigation-stack|chat-shell[a-z-]*)["']/.exec(read(file));
  check(
    `no-slot-lookalike:${rel(file)}`,
    hit === null,
    `${rel(file)} emits the package data-slot "${hit?.[1]}"`,
  );
}

/* ── 8. No block-local side channels ── */
for (const file of [...blockFiles, ...walk(join(src, "chat"), isSource)]) {
  const hit =
    /useState<(?:TimelineItem|MessageData|Channel)\b|\bsetItems\(|\bsetChannels\(|BOT_REPLY|'m' \+ Date\.now|"m" \+ Date\.now/.exec(
      read(file),
    );
  check(
    `no-side-channel:${rel(file)}`,
    hit === null,
    `${rel(file)} appends to local state (${hit?.[0]}) instead of dispatching`,
  );
}

/* ── 9. Gate honesty ── */
for (const file of blockFiles) {
  const hit = /eslint-disable|@ts-nocheck|@ts-ignore|@ts-expect-error/.exec(read(file));
  check(
    `no-suppression:${rel(file)}`,
    hit === null,
    `${rel(file)} suppresses a gate (${hit?.[0]})`,
  );
}
for (const config of [
  ".prettierignore",
  "eslint.config.mjs",
  "tsconfig.check.json",
  "apps/web/tsconfig.json",
]) {
  check(
    `gate-covers-blocks:${config}`,
    !/blocks/.test(read(join(root, config))),
    `${config} mentions src/blocks (an ignore or exclude)`,
  );
}
const webTsconfig = JSON.parse(read(join(web, "tsconfig.json")));
check(
  "tsc-web-includes-src",
  (webTsconfig.include ?? []).includes("src/**/*.tsx"),
  "apps/web/tsconfig.json must include src/**/*.tsx",
);
const rootPackage = JSON.parse(read(join(root, "package.json")));
check(
  "typecheck-runs-web",
  /tsc -p apps\/web\/tsconfig\.json/.test(rootPackage.scripts.typecheck),
  "pnpm typecheck must typecheck apps/web (Bundler resolution)",
);

/* ── 10. Provenance: header + every divergent hunk carries an `ef:` marker ── */
const registries = Object.fromEntries(
  ["github-clone", "discord-clone"].map((name) => [
    name,
    JSON.parse(read(join(upstreamDir, `${name}.json`))),
  ]),
);
const prettierConfig = (await prettier.resolveConfig(join(root, "package.json"))) ?? {};

function lcsHunks(a, b) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const hunks = [];
  let i = 0;
  let j = 0;
  let current = null;
  const flush = () => {
    if (current !== null) hunks.push(current);
    current = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
      current ??= { start: j, end: j, added: [] };
      i += 1;
    } else {
      current ??= { start: j, end: j, added: [] };
      current.added.push(b[j]);
      j += 1;
      current.end = j;
    }
  }
  flush();
  return hunks;
}

for (const file of blockFiles) {
  const text = read(file);
  const header = text.split("\n").slice(0, 5).join("\n");
  const named = /registry\/blocks\/(github|discord)-clone\/([\w/.-]+\.tsx?)/.exec(header);
  check(
    `provenance-header:${rel(file)}`,
    named !== null,
    `${rel(file)} has no registry/blocks/(github|discord)-clone/<file> header in its first 5 lines`,
  );
  if (named === null) continue;
  const upstream = registries[`${named[1]}-clone`].files.find(
    (entry) => entry.path === `registry/blocks/${named[1]}-clone/${named[2]}`,
  );
  check(
    `provenance-upstream:${rel(file)}`,
    upstream !== undefined,
    `${rel(file)} names ${named[0]}, which the committed registry snapshot does not contain`,
  );
  if (upstream === undefined) continue;
  const formatted = await prettier.format(upstream.content, { ...prettierConfig, filepath: file });
  const owned = text.split("\n");
  // A hunk is marked by an `ef:` line within three lines of it, or by lying inside an
  // `// ef:begin <reason>` … `// ef:end` region (a rewired declaration).
  const inRegion = [];
  let open = false;
  for (const line of owned) {
    if (/\/\/ ef:begin\b/.test(line)) open = true;
    inRegion.push(open);
    if (/\/\/ ef:end\b/.test(line)) open = false;
  }
  check(
    `provenance-regions-closed:${rel(file)}`,
    !open,
    `${rel(file)} has an unterminated ef:begin region`,
  );
  const unmarked = lcsHunks(formatted.split("\n"), owned).filter((hunk) => {
    if (hunk.end > hunk.start && inRegion.slice(hunk.start, hunk.end).every(Boolean)) return false;
    if (
      hunk.end === hunk.start &&
      inRegion[hunk.start] === true &&
      inRegion[Math.max(0, hunk.start - 1)] === true
    )
      return false;
    const window = owned.slice(Math.max(0, hunk.start - 3), Math.min(owned.length, hunk.end + 3));
    return !window.some((line) => /\bef:/.test(line));
  });
  check(
    `provenance-ef-markers:${rel(file)}`,
    unmarked.length === 0,
    `${rel(file)} diverges from ${named[0]} without an ef: marker at lines ${unmarked.map((hunk) => `${String(hunk.start + 1)}-${String(hunk.end)}`).join(", ")}`,
  );
}

if (failures.length > 0) {
  process.stdout.write(`${failures.join("\n")}\n`);
  process.stdout.write(
    `E5_T15_UI_CONTRACT_FAILED failures=${String(failures.length)} checks=${String(checks)}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `E5_T15_UI_CONTRACT_OK checks=${String(checks)} ui=2.0.0 docstream=1.5.0 editor=1.5.0 blocks=${String(blockFiles.length)} sources=${String(sources.length)} root=${dirname(web) === join(root, "apps") ? "." : root}\n`,
);
