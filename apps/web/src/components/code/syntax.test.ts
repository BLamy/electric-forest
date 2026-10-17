import { describe, expect, it } from "vitest";
import { syntaxLines, type SyntaxSegment, type SyntaxSpan } from "./syntax.js";

const text = (line: readonly SyntaxSegment[]): string =>
  line.map((segment) => segment.text).join("");

describe("syntaxLines", () => {
  it("reproduces every line's text exactly", () => {
    const code = "const a = 1;\n/* two\nlines */\n\nreturn a;";
    const spans: SyntaxSpan[] = [
      { type: "keyword", start: 0, end: 5 },
      { type: "number", start: 10, end: 11 },
      { type: "comment", start: 13, end: 27 },
      { type: "keyword", start: 29, end: 35 },
    ];
    const lines = syntaxLines(code, spans);
    expect(lines.map(text)).toEqual(code.split("\n"));
  });

  it("cuts a span that crosses a newline and fills gaps as plain", () => {
    const lines = syntaxLines("x /* a\nb */ y", [{ type: "comment", start: 2, end: 11 }]);
    expect(lines).toEqual([
      [
        { type: "plain", text: "x " },
        { type: "comment", text: "/* a" },
      ],
      [
        { type: "comment", text: "b */" },
        { type: "plain", text: " y" },
      ],
    ]);
  });

  it("ignores overlapping or out-of-range spans without duplicating text", () => {
    const lines = syntaxLines("abc", [
      { type: "keyword", start: 0, end: 2 },
      { type: "string", start: 1, end: 9 },
    ]);
    expect(lines.map(text)).toEqual(["abc"]);
  });
});
