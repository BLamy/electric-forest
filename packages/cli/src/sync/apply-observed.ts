import { canonicalJson } from "@eforest/protocol";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

interface ObservedApply {
  readonly v: 1;
  readonly offset: string;
  readonly path: string;
}

export class ObservedApplyJournal {
  private readonly records: ObservedApply[];

  constructor(readonly path: string) {
    if (!existsSync(path)) {
      this.records = [];
      return;
    }
    const source = readFileSync(path, "utf8");
    if (source.length === 0) {
      this.records = [];
      return;
    }
    if (!source.endsWith("\n") || source.includes("\r")) {
      throw new Error(`${path} must be LF-delimited canonical JSON`);
    }
    this.records = source
      .slice(0, -1)
      .split("\n")
      .map((line, index) => {
        const parsed = JSON.parse(line) as Partial<ObservedApply>;
        if (
          parsed.v !== 1 ||
          typeof parsed.offset !== "string" ||
          typeof parsed.path !== "string" ||
          Object.keys(parsed).sort().join(",") !== "offset,path,v" ||
          canonicalJson(parsed) !== line
        ) {
          throw new Error(`${path} line ${index + 1} is malformed`);
        }
        return parsed as ObservedApply;
      });
  }

  has(offset: string, path: string): boolean {
    return this.records.some((record) => record.offset === offset && record.path === path);
  }

  append(offset: string, path: string): void {
    if (this.has(offset, path)) return;
    const record: ObservedApply = { v: 1, offset, path };
    const descriptor = openSync(this.path, "a", 0o600);
    try {
      writeSync(descriptor, `${canonicalJson(record)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.records.push(record);
  }
}

export function observedApplyPath(root: string): string {
  return join(root, ".ef", "apply-observed");
}
