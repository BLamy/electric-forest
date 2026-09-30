import { useLayoutEffect, useMemo, useRef } from "react";
import { GitbookStreamdown } from "@brett_lamy/docstream/streamdown";

const DANGEROUS_PROTOCOL = /^(?:javascript|data|vbscript):/i;
const ACTIVE_ELEMENT_BLOCK =
  /<\s*(script|iframe|object|embed|svg|math|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const ACTIVE_ELEMENT_TAG = /<\s*\/?\s*(?:script|iframe|object|embed|svg|math|style)\b[^>]*>/gi;
const EVENT_HANDLER_ATTRIBUTE = /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SRCDOC_ATTRIBUTE = /\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function safeUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("//") || DANGEROUS_PROTOCOL.test(trimmed) ? "#blocked" : value;
}

/** Render-side hardening only; the canonical stream bytes are never rewritten. */
export function sanitizeMarkdownForRender(markdown: string): string {
  return markdown
    .replace(ACTIVE_ELEMENT_BLOCK, "")
    .replace(ACTIVE_ELEMENT_TAG, "")
    .replace(EVENT_HANDLER_ATTRIBUTE, "")
    .replace(SRCDOC_ATTRIBUTE, "")
    .replace(
      /\b(href|src)\s*=\s*(["'])(.*?)\2/gi,
      (_match, name: string, quote: string, value: string) =>
        `${name}=${quote}${safeUrl(value)}${quote}`,
    )
    .replace(
      /(!?\[[^\]\n]*\]\()\s*([^\s)]+)(\))/g,
      (_match, prefix: string, value: string, suffix: string) =>
        `${prefix}${safeUrl(value)}${suffix}`,
    )
    .replace(
      /^(\[[^\]\n]+\]:\s*)(\S+)/gm,
      (_match, prefix: string, value: string) => `${prefix}${safeUrl(value)}`,
    )
    .replace(
      /(\burl\s*=\s*["'])(.*?)(["'])/gi,
      (_match, prefix: string, value: string, suffix: string) =>
        `${prefix}${safeUrl(value)}${suffix}`,
    );
}

export interface MarkdownProps {
  readonly source: string;
  readonly className?: string;
  readonly "data-testid"?: string;
}

export function Markdown(props: MarkdownProps): React.JSX.Element {
  const markdown = useMemo(() => sanitizeMarkdownForRender(props.source), [props.source]);
  const containerRef = useRef<HTMLDivElement>(null);
  // `wb-md` is the package's Markdown typography (styling only): Docstream still renders the
  // sanitized source below, so every Markdown surface keeps this adapter's URL policy.
  const className = props.className ? `wb-md min-w-0 ${props.className}` : "wb-md min-w-0";

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (root === null) return;
    const checkboxes = root.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:not([aria-label]):not([aria-labelledby])',
    );
    checkboxes.forEach((checkbox, index) => {
      const item = checkbox.closest("li");
      const text = item?.textContent?.replace(/\s+/g, " ").trim();
      checkbox.setAttribute(
        "aria-label",
        text === undefined || text === "" ? `Checklist item ${String(index + 1)}` : text,
      );
    });
  }, [markdown]);

  return (
    <div
      ref={containerRef}
      className={className}
      data-testid={props["data-testid"] ?? "markdown"}
      data-markdown-renderer="docstream"
    >
      <GitbookStreamdown markdown={markdown} />
    </div>
  );
}
