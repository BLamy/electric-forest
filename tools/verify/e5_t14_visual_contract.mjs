#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone");

const references = [
  [
    "01-repository-list.png",
    2940,
    1604,
    "1642049d40a0c6e11e6ba1a999ca09c29794a51cb131e72444ffcd0858090165",
  ],
  [
    "02-repository-tree.png",
    3164,
    2070,
    "c3c1f61dd73dd6507b050d889943388bd5ff6c95b53e17d63ea0fdd26ea1acb0",
  ],
  [
    "03-file-view.png",
    3164,
    2070,
    "729f1e1a25c5a9499fbb640395732018f39d9cc2755ec45fa36ec4f677f7d3a9",
  ],
  [
    "04-pull-request-list.png",
    3164,
    2070,
    "9c70be90235dfa7eb93aebdf4f1044106b66276c297fe0d7f63b295defe445bc",
  ],
  [
    "05-pull-request-detail.png",
    3164,
    2070,
    "bca37acebd6a334794fc397afa6346ff7e8e5ff2433aaa8d00172e2946111fe4",
  ],
  [
    "06-diff-view.png",
    3164,
    2070,
    "7683386fd18907fd1ebb49c675cf75a4a4453928fa5a5fbb17f92aedfff99072",
  ],
  [
    "07-pr-activity.png",
    2940,
    1616,
    "ea6f50ff81a4b747d87f46c31498016e5ba12e1ad5b1a8db67d875c4b52f40b5",
  ],
  [
    "08-pr-commits.png",
    2940,
    1614,
    "3fc8940d4eee9bc01bf1f087160cd3fb1281e2801ba65e53b6245dafe1004250",
  ],
  [
    "09-pr-checks.png",
    2940,
    1608,
    "86cc51f430bf05ac28d2d7438b45c2848f2756c5085a63d79275deb666f08ba0",
  ],
];

for (const [name, width, height, digest] of references) {
  const bytes = await readFile(resolve(task, "references", name));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${name} is not PNG`);
  assert.equal(bytes.readUInt32BE(16), width, `${name} width drifted`);
  assert.equal(bytes.readUInt32BE(20), height, `${name} height drifted`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, `${name} hash drifted`);
}

const webPackage = JSON.parse(await readFile(resolve(root, "apps/web/package.json"), "utf8"));
assert.equal(webPackage.dependencies["@brett_lamy/docstream"], "0.3.7");
assert.equal(webPackage.dependencies["@brett_lamy/ui"], "0.0.1");
assert.equal(webPackage.dependencies["@pierre/diffs"], "1.3.6");
assert.equal(webPackage.dependencies["@pierre/trees"], "1.0.0-beta.6");

const source = async (path) => readFile(resolve(root, path), "utf8");
const markdown = await source("apps/web/src/components/markdown/Markdown.tsx");
assert.match(markdown, /@brett_lamy\/docstream\/streamdown/);
assert.match(markdown, /GitbookStreamdown/);
assert.match(markdown, /sanitize/i);

const prDetail = await source("apps/web/src/prs/PrDetail.tsx");
assert.match(prDetail, /@pierre\/diffs\/react/);
assert.match(prDetail, /MultiFileDiff/);
assert.match(prDetail, /PierrePathTree/);
assert.match(prDetail, /"split" \| "unified"/);

const trees = await source("apps/web/src/components/trees/RepositoryTree.tsx");
assert.match(trees, /@pierre\/trees\/react/);
assert.match(trees, /FileTree/);
assert.match(trees, /data-tree-adapter="@pierre\/trees"/);

const mobile = await source("apps/web/src/components/mobile/MobileProductShell.tsx");
assert.match(mobile, /@brett_lamy\/ui/);
for (const primitive of ["TouchKitProvider", "NavigationStack", "SplitView", "TabBar"]) {
  assert.match(mobile, new RegExp(`\\b${primitive}\\b`));
}
assert.match(mobile, /data-mobile-product-shell="@brett_lamy\/ui@0\.0\.1"/);

const shell = `${await source("apps/web/src/components/shell/ProductShell.tsx")}\n${await source("apps/web/src/prs/RepoChrome.tsx")}`;
for (const tab of ["Code", "Pull Requests", "Issues", "Wiki", "Settings"]) {
  assert.ok(shell.includes(tab), `desktop repository tab missing: ${tab}`);
}

const shadcn = JSON.parse(await readFile(resolve(root, "apps/web/components.json"), "utf8"));
assert.equal(shadcn.$schema, "https://ui.shadcn.com/schema.json");
for (const file of [
  "button",
  "card",
  "dialog",
  "input",
  "scroll-area",
  "select",
  "tabs",
  "textarea",
]) {
  await access(resolve(root, `apps/web/src/components/ui/${file}.tsx`));
}

await access(resolve(task, "evidence/package-source-manifest.md"));
console.log("E5_T14_VISUAL_CONTRACT_OK references=9 adapters=5 tabs=5");
