import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournal } from "../src/sync/journal.js";
import { repairJournal } from "../src/sync/reconcile.js";

describe("offline reconcile crash boundaries", () => {
  it("confirms an accepted offset without producing a retry plan", () => {
    const offset = "0000000000000000_0000000000000004";
    const decisions = repairJournal(
      [{ kind: "accepted", path: "docs/a.txt", offset }],
      [{ offset } as never],
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: "confirmed", offset });
  });

  it("fails closed on an unassigned accepted offset", () => {
    expect(() =>
      repairJournal(
        [{ kind: "accepted", path: "docs/a.txt", offset: "0000000000000000_0000000000000099" }],
        [],
      ),
    ).toThrow("reconcile/journal-offset-unassigned");
  });

  it("retains the torn-tail journal contract before reconcile starts", () => {
    const root = mkdtempSync(join(tmpdir(), "eforest-reconcile-crash-"));
    const path = join(root, "journal.jsonl");
    writeFileSync(
      path,
      '{"action":"fs.file.write","base":"BASE_NONE","kind":"accepted","offset":"0000000000000000_0000000000000001","path":"a","seq":1}\n{"action":',
    );
    expect(() => readJournal(path)).toThrow(/not JSON|canonical JSON/);
  });
});
