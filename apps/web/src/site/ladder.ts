export interface Milestone {
  readonly epic: string;
  readonly name: string;
  readonly milestone: string;
  readonly description: string;
}

/** The milestone ladder table in ROADMAP.md is the canonical epic list; read it, don't copy it. */
export function milestoneLadder(markdown: string): readonly Milestone[] {
  const rows: Milestone[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*(E\d+)\s*\|\s*([a-z-]+)\s*\|\s*\*\*([^*]+)\*\*\s*—\s*(.*?)\s*\|\s*$/.exec(
      line,
    );
    if (match !== null) {
      rows.push({ epic: match[1]!, name: match[2]!, milestone: match[3]!, description: match[4]! });
    }
  }
  return rows;
}
