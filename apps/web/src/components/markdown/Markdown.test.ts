import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, sanitizeMarkdownForRender } from "./Markdown.js";

const hostile = `# Safe heading

<script>globalThis.__wikiPwned = true</script>
<img src="data:image/svg+xml,<svg onload='alert(1)'>" onerror="alert(2)">
<iframe srcdoc="<script>alert(3)</script>"></iframe>
<object data="javascript:alert(4)"></object>
[bad](javascript:alert(5))
[encoded](data:text/html,boom)
[protocol relative](//attacker.example/payload)
[safe](https://example.com/docs)
<a href="vbscript:alert(6)" onclick="alert(7)">bad html link</a>
{% embed url="javascript:alert(8)" /%}
`;

describe("shared Docstream Markdown adapter", () => {
  it("does not elide lines from a long wiki body", () => {
    const source = `# Home\n\n${Array.from(
      { length: 180 },
      (_, index) => `Line ${String(index).padStart(3, "0")}: stable wiki proof.\n`,
    ).join("")}`;
    const html = renderToStaticMarkup(createElement(Markdown, { source }));

    expect(html).toContain("Line 000: stable wiki proof.");
    expect(html).toContain("Line 090: stable wiki proof.");
    expect(html).toContain("Line 179: stable wiki proof.");
  });
  it("hardens active markup and unsafe URLs before handing markdown to Docstream", () => {
    const safe = sanitizeMarkdownForRender(hostile);
    expect(safe, "hostile-sanitizer-removes-active-markup").not.toMatch(
      /<\/?(?:script|iframe|object|svg)\b/i,
    );
    expect(safe).not.toMatch(/\son[a-z]+\s*=/i);
    expect(safe).not.toMatch(/\bsrcdoc\s*=/i);
    expect(safe).not.toMatch(/(?:javascript|data|vbscript):/i);
    expect(safe).toContain("https://example.com/docs");
    expect(safe).toContain("#blocked");
  });

  it("renders the hostile corpus through Docstream without active DOM", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: hostile }));
    expect(html).toContain('data-markdown-renderer="docstream"');
    expect(html).toContain('data-docstream=""');
    expect(html).toContain("Safe heading");
    expect(html).toContain("https://example.com/docs");
    expect(html).not.toMatch(/<(?:script|iframe|object|embed|math|style)\b/i);
    expect(html).not.toMatch(/<svg\b[^>]*\bon[a-z]+=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/(?:javascript|data|vbscript):/i);
  });
});
