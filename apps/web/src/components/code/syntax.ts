import { useEffect, useState } from "react";

/**
 * Syntax highlighting through gpu-lexer: one small WebGPU model tokenizes any language
 * into display spans (no grammars, no language argument). Without WebGPU or a secure
 * context `parse` rejects and callers render plain text — highlighting is cosmetic and
 * never changes the text a view shows.
 */

export type SyntaxType =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "function"
  | "constant"
  | "operator";

export interface SyntaxSpan {
  readonly type: SyntaxType;
  readonly start: number;
  readonly end: number;
}

export interface SyntaxSegment {
  readonly type: SyntaxType;
  readonly text: string;
}

/** Past this many UTF-16 code units the view stays plain rather than stall the GPU. */
export const SYNTAX_MAX_CODE_UNITS = 256 * 1024;

/**
 * Split span-covered source into per-line segments. Spans that cross a newline (block
 * comments, template strings) are cut at each line break, and any gap the spans leave is
 * plain, so every line's segments concatenate to exactly that line's text.
 */
export function syntaxLines(code: string, spans: readonly SyntaxSpan[]): SyntaxSegment[][] {
  const lines: SyntaxSegment[][] = [[]];
  const push = (type: SyntaxType, text: string): void => {
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part.length > 0) lines[lines.length - 1]!.push({ type, text: part });
    });
  };
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(span.start, cursor);
    const end = Math.min(span.end, code.length);
    if (end <= start) continue;
    if (start > cursor) push("plain", code.slice(cursor, start));
    push(span.type, code.slice(start, end));
    cursor = end;
  }
  if (cursor < code.length) push("plain", code.slice(cursor));
  return lines;
}

let lexer: Promise<(code: string) => Promise<SyntaxSpan[]>> | undefined;
const cache = new Map<string, Promise<readonly SyntaxSpan[] | null>>();
const CACHE_LIMIT = 64;

/** Spans for `code`, or null when it cannot be highlighted here (no WebGPU, too large). */
export function syntaxSpans(code: string): Promise<readonly SyntaxSpan[] | null> {
  if (code.length === 0 || code.length > SYNTAX_MAX_CODE_UNITS) return Promise.resolve(null);
  const cached = cache.get(code);
  if (cached !== undefined) return cached;
  // Loaded on first use so the model and shader stay out of the initial bundle.
  lexer ??= import("gpu-lexer").then(
    (module) => module.parse as (code: string) => Promise<SyntaxSpan[]>,
  );
  const result = lexer.then((parse) => parse(code)).catch(() => null);
  cache.set(code, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}

/** Per-line syntax segments for `code`; null until (or unless) highlighting is available. */
export function useSyntaxLines(code: string): SyntaxSegment[][] | null {
  const [state, setState] = useState<{ code: string; lines: SyntaxSegment[][] | null }>({
    code,
    lines: null,
  });
  useEffect(() => {
    let cancelled = false;
    void syntaxSpans(code).then((spans) => {
      if (!cancelled) setState({ code, lines: spans === null ? null : syntaxLines(code, spans) });
    });
    return () => {
      cancelled = true;
    };
  }, [code]);
  return state.code === code ? state.lines : null;
}
