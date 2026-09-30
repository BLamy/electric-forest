import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@eforest/reducers";
import { ChannelMessage } from "../../blocks/chat/channel-message.js";
import { Readme } from "../../blocks/github/code-tab.js";
import { layoutFor } from "../../blocks/github/parts.js";
import { CommentCard } from "../../blocks/github/pull-request.js";

/**
 * Every block surface that shows user-authored Markdown (PR comments and descriptions, chat
 * messages, README / wiki / Markdown files) must hand its body to the Docstream adapter,
 * whose URL / active-content policy strips these vectors before anything reaches the DOM.
 */
const hostile = [
  "Hostile corpus",
  "",
  "[x](javascript:alert(1)) [y](//evil.example) [z](data:text/html,boom)",
  "",
  "[r]: data:text/html,<script>alert(1)</script>",
  "",
  '<img src=x onerror="window.__pwned=1">',
  '<iframe srcdoc="<script>window.__pwned=2</script>"></iframe>',
  '<a href="vbscript:x">vb</a>',
  '<svg onload="window.__pwned=3"></svg>',
  "<script>window.__pwned=4</script>",
  "",
  "[safe](https://example.com/docs)",
].join("\n");

function assertSafe(html: string): void {
  expect(html).toContain('data-markdown-renderer="docstream"');
  expect(html).toContain("Hostile corpus");
  expect(html).toContain("https://example.com/docs");
  expect(html).not.toMatch(/<(?:script|iframe|object|embed)\b/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
  expect(html).not.toMatch(/href="(?:javascript|data|vbscript):/i);
  expect(html).not.toMatch(/href="\/\//);
  expect(html).not.toContain('data-slot="markdown-view"');
}

const ui = layoutFor(1200);

describe("block Markdown surfaces enter the Docstream adapter", () => {
  it("PR comments and descriptions (CommentCard)", () => {
    assertSafe(
      renderToStaticMarkup(
        createElement(CommentCard, { ui, author: "mallory@example.test", when: "", body: hostile }),
      ),
    );
  });

  it("chat messages (ChannelMessage)", () => {
    const message: ChatMessage = {
      id: "msg_hostile",
      offset: "0000000000000000_0000000000000000",
      actor: "auth0|mallory",
      body: hostile,
      threadOf: null,
      ts: 1,
      revision: 1,
      editedAt: null,
      deleted: false,
    };
    assertSafe(
      renderToStaticMarkup(
        createElement(ChannelMessage, {
          message,
          replies: [],
          mine: false,
          dispatch: (() => Promise.reject(new Error("no dispatch in SSR"))) as never,
          onOpenThread: undefined,
          onError: () => undefined,
          references: {},
          org: "maple",
          answeredRuns: new Set<string>(),
        }),
      ),
    );
  });

  it("README, wiki and Markdown file previews (Readme)", () => {
    assertSafe(renderToStaticMarkup(createElement(Readme, { markdown: hostile, phone: false })));
  });
});
