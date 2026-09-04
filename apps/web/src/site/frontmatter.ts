/**
 * Flat-YAML frontmatter, exactly the dialect `tools/build_queue.py` accepts: `key: value`
 * lines between `---` fences, `#` comments stripped, no nesting. Browser-safe (no I/O) so
 * the same parser serves the build-time task index and the runtime docs corpus.
 */
export interface Frontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .split("#")[0]!
      .trim();
    fields[key] = unquote(value);
  }
  return { fields, body: text.slice(match[0].length) };
}

export function unquote(value: string): string {
  return (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ? value.slice(1, -1)
    : value;
}
