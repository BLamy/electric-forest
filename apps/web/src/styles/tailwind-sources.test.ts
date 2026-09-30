import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

/**
 * Focused Tailwind check for the owned registry blocks. The entry sheet uses
 * `source(none)`, so a utility that appears only inside src/blocks is generated only
 * because of its `@source "../blocks";` line. A missing utility is a silent layout break,
 * so this compiles styles/app.css exactly as @tailwindcss/vite does and asserts that
 * block-only utilities are emitted — and that dropping the blocks source drops them.
 */
const entry = resolve(import.meta.dirname, "app.css");

async function build(css: string): Promise<string> {
  const compiler = await compile(css, { base: dirname(entry), onDependency: () => undefined });
  const sources =
    compiler.root === "none" || compiler.root === null
      ? compiler.sources
      : [{ ...compiler.root, negated: false }, ...compiler.sources];
  const scanner = new Scanner({ sources });
  return compiler.build(scanner.scan());
}

/**
 * Utilities (as emitted selectors) that appear only in src/blocks — neither in another app
 * area nor in @brett_lamy/ui's dist: the About sidebar, the Files sidebar, the merge-button
 * fill, the global header inset, the chat avatar size and the selected workspace tile.
 */
const BLOCK_ONLY = [
  ".w-\\[296px\\]",
  ".w-\\[280px\\]",
  ".bg-\\(--gh-merge\\)",
  ".bg-\\[var\\(--gh-inset\\)\\]",
  ".size-\\(--ck-avatar-size\\)",
  ".group-data-selected\\:bg-\\(--tile\\)",
];

describe("Tailwind v4 sources for the owned registry blocks", () => {
  const css = readFileSync(entry, "utf8");

  it("declares explicit sources, including the blocks", () => {
    expect(css).toMatch(/@import "tailwindcss" source\(none\);/);
    expect(css).toMatch(/^@source "\.\.\/blocks";$/m);
  });

  it("emits utilities that appear only inside src/blocks", async () => {
    const output = await build(css);
    for (const selector of BLOCK_ONLY) expect(output, selector).toContain(selector);
  });

  it("drops them when the blocks source is removed (sensitivity)", async () => {
    const output = await build(css.replace(/^@source "\.\.\/blocks";$/m, ""));
    for (const selector of BLOCK_ONLY) expect(output, selector).not.toContain(selector);
  });
});
