#!/usr/bin/env node
// E6-T05 CommonMark differential oracle (permanent verify step).
//
// The engine's "is this line a Verification-log entry heading?" is held against the
// reference implementation a Markdown renderer uses — `mdast-util-from-markdown`, a
// declared dependency of @eforest/tasks (runs 1-3 broke three hand-rolled generations of
// that predicate). Requires ZERO divergence over a frozen hand-built corpus plus a
// seeded generated corpus. Resolution is workspace-relative: no absolute paths, no
// node_modules/.pnpm reach-through.
//
//   --seeds <n>   generated cases (default 4000)
//   --print       emit the transcript instead of comparing it to the committed one
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(
  root,
  ".eforest/tasks/epic-6-the-loop/E6-T05-task-folder-stream-sync/evidence",
);
const { parseVerificationLogEntries } = await import(
  join(root, "packages/tasks/dist/src/index.js")
);
// Resolved through @eforest/tasks' own declared dependency, as a consumer would.
const requireFromTasks = createRequire(join(root, "packages/tasks/package.json"));
const { fromMarkdown } = requireFromTasks("mdast-util-from-markdown");

const args = process.argv.slice(2);
let seeds = 4000;
let print = false;
while (args.length > 0) {
  const flag = args.shift();
  if (flag === "--seeds") seeds = Number(args.shift());
  else if (flag === "--print") print = true;
  else {
    console.error(`unknown argument ${flag}`);
    process.exit(2);
  }
}

const ENTRY = "### 2026-08-31 — critic — VERDICT: verified";

/**
 * The engine's answer: 0-based lines it treats as entry headings. Entries are consumed
 * in order against the source lines, so two occurrences of identical heading text are
 * distinguished by position (matching by text alone over-counts a repeated heading and
 * would report a divergence the engine never made).
 */
function engineHeadings(body) {
  const lines = body.split("\n");
  const out = [];
  let cursor = 0;
  for (const entry of parseVerificationLogEntries(body)) {
    const head = entry.text.split("\n")[0];
    for (let index = cursor; index < lines.length; index += 1) {
      if (lines[index] === head) {
        out.push(index);
        cursor = index + 1;
        break;
      }
    }
  }
  return out;
}

/** CommonMark's answer: 0-based lines of depth-3 ATX headings starting with `### `. */
function referenceHeadings(body) {
  const lines = body.split("\n");
  const out = [];
  const walk = (node) => {
    if (node.type === "heading" && node.depth === 3 && node.position) {
      const index = node.position.start.line - 1;
      if (lines[index]?.startsWith("### ") === true) out.push(index);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(body));
  return out.sort((a, b) => a - b);
}

// The frozen hand-built corpus: every class three critics and the progress audit found,
// plus the must-still-dispatch cases (a real entry must never be silenced).
const FIXED = {
  "block7-quoted-gt-double": `<span title="a>b">\n${ENTRY}\n- Run: x`,
  "block7-quoted-gt-single": `<span title='a>b'>\n${ENTRY}\n- Run: x`,
  "block7-img-alt-arrow": `<img src="p.png" alt="looks like ->">\n${ENTRY}\n- Run: x`,
  "poison-empty-comment": `<!-->\n\n${ENTRY}\n- Run: x`,
  "poison-empty-comment3": `<!--->\n\n${ENTRY}\n- Run: x`,
  "para-then-span": `some prose\n<span>\n${ENTRY}\n- Run: x`,
  "para-then-br": `some prose\n<br>\n${ENTRY}\n- Run: x`,
  "para-then-img": `some prose\n<img src="x.png">\n${ENTRY}\n- Run: x`,
  "para-then-unknown-tag": `some prose\n<foo>\n${ENTRY}\n- Run: x`,
  "para-then-selfclose": `some prose\n<x/>\n${ENTRY}\n- Run: x`,
  "para-then-div-is-inert": `some prose\n<div>\n${ENTRY}\n- Run: x`,
  "list-then-span": `- item\n<span>\n${ENTRY}\n- Run: x`,
  "comment-normal": `<!--\n${ENTRY}\n-->`,
  "comment-close-inside-fence": "```\n<!--\n```\n" + ENTRY + "\n- Run: x",
  cdata: `<![CDATA[\n${ENTRY}\n]]>`,
  "cdata-oneline": `<![CDATA[x]]>\n${ENTRY}\n- Run: x`,
  "pi-oneline": `<?php echo 1; ?>\n${ENTRY}\n- Run: x`,
  "decl-gt-in-attr": `<!DOCTYPE html>\n${ENTRY}\n- Run: x`,
  "decl-multiline": `<!DOCTYPE\nhtml>\n${ENTRY}\n- Run: x`,
  "closing-div": `</div>\n${ENTRY}\n- Run: x`,
  "pre-with-attr-gt": `<pre title="a>b">\n${ENTRY}\n</pre>`,
  "pre-oneline": `<pre>x</pre>\n${ENTRY}\n- Run: x`,
  "tag-multiline-attrs": `<span\n  title="x">\n${ENTRY}\n- Run: x`,
  "tag-unclosed": `<foo bar\n${ENTRY}\n- Run: x`,
  selfclose: `<span/>\n${ENTRY}\n- Run: x`,
  "setext-under": `${ENTRY}\n===`,
  "tab-fence": "\t```\n" + ENTRY + "\n- Run: x",
  "html-comment-then-text-same-line": `<!-- c --> tail\n${ENTRY}\n- Run: x`,
  "fence-unterminated": "```\n" + ENTRY + "\n- Run: x",
  "plain-entry": `${ENTRY}\n- Run: x`,
  "entry-after-blank": `prose\n\n${ENTRY}\n- Run: x`,
  "indented-code": `    ${ENTRY}\n- Run: x`,
  "blockquote-entry": `> ${ENTRY}\n- Run: x`,
};

// A seeded generator: assemble bodies from structural atoms, so the corpus explores
// interleavings of the constructs above rather than one hand-picked shape each.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ATOMS = [
  "prose line",
  "",
  ENTRY,
  "- Run: agent-run:maple/x",
  "```",
  "~~~",
  "```markdown",
  "<!--",
  "-->",
  "<!-->",
  "<!--->",
  "<pre>",
  "</pre>",
  "<span>",
  '<span title="a>b">',
  "<br>",
  "<div>",
  "</div>",
  '<img src="x.png" alt="->">',
  "<![CDATA[",
  "]]>",
  "<?php",
  "?>",
  "<!DOCTYPE html>",
  "    indented",
  "> quoted",
  "- item",
  "\ttabbed",
  "<foo bar",
  "<x/>",
];
function generate(seed) {
  const random = mulberry32(seed);
  const count = 2 + Math.floor(random() * 8);
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(ATOMS[Math.floor(random() * ATOMS.length)]);
  }
  return lines.join("\n");
}

/** The declared version, read from @eforest/tasks' own manifest (not a store path). */
function referenceVersion() {
  const manifest = JSON.parse(readFileSync(join(root, "packages/tasks/package.json"), "utf8"));
  return manifest.dependencies["mdast-util-from-markdown"];
}

const divergences = [];
const transcript = [];
const record = (name, body) => {
  const engine = engineHeadings(body);
  const reference = referenceHeadings(body);
  const agree = JSON.stringify(engine) === JSON.stringify(reference);
  if (!agree) {
    divergences.push({ name, engine, reference, body });
  }
  return agree;
};

for (const name of Object.keys(FIXED).sort()) {
  const agree = record(name, FIXED[name]);
  transcript.push(
    `${agree ? "OK  " : "DIVERGE"} ${name} engine=${JSON.stringify(engineHeadings(FIXED[name]))}`,
  );
}
let generated = 0;
for (let seed = 1; seed <= seeds; seed += 1) {
  record(`seed-${seed}`, generate(seed));
  generated += 1;
}

const summary = [
  `E6_T05_DIFFERENTIAL fixed=${Object.keys(FIXED).length} generated=${generated} divergences=${divergences.length}`,
  `E6_T05_DIFFERENTIAL reference=mdast-util-from-markdown@${referenceVersion()}`,
];
const text = `${[...transcript, ...summary].join("\n")}\n`;

if (print) {
  process.stdout.write(text);
} else {
  const committed = readFileSync(join(evidence, "e6-t05-differential.txt"), "utf8");
  if (text !== committed) {
    const live = text.split("\n");
    const frozen = committed.split("\n");
    for (let index = 0; index < Math.max(live.length, frozen.length); index += 1) {
      if (live[index] !== frozen[index]) {
        console.error(`DIFFERENTIAL DIFF line ${index + 1}`);
        console.error(`  committed: ${frozen[index] ?? "<absent>"}`);
        console.error(`  live:      ${live[index] ?? "<absent>"}`);
      }
    }
    assert.fail("differential transcript drifted from the committed bytes");
  }
}

for (const divergence of divergences) {
  console.error(
    `DIVERGENCE ${divergence.name}: engine=${JSON.stringify(divergence.engine)} commonmark=${JSON.stringify(divergence.reference)}\n${JSON.stringify(divergence.body)}`,
  );
}
assert.equal(
  divergences.length,
  0,
  `the engine must agree with CommonMark on every case (${divergences.length} divergences)`,
);
if (!print) {
  console.log(summary.join("\n"));
  console.log(
    `E6_T05_DIFFERENTIAL transcript-sha256=${createHash("sha256").update(text).digest("hex")}`,
  );
}
