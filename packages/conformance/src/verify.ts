import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertOffsetOpacity,
  collectBoth,
  type CorpusOutcome,
  writeEvidence,
} from "./conformance.js";
import { firstDiffByte } from "./normalize.js";
import { repoRoot } from "./paths.js";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function compareText(label: string, actual: string, expected: string): void {
  const difference = firstDiffByte(actual, expected);
  requireCondition(
    difference < 0,
    `${label} differs at byte ${difference < 0 ? "unknown" : difference}`,
  );
}

function verifyTranscripts(
  transcripts: Readonly<Record<string, string>>,
  other: Readonly<Record<string, string>>,
  goldens: string,
): void {
  const names = Object.keys(transcripts).sort();
  const otherNames = Object.keys(other).sort();
  compareText("transcript file list", `${names.join("\n")}\n`, `${otherNames.join("\n")}\n`);
  for (const name of names) {
    const actual = transcripts[name];
    const counterpart = other[name];
    requireCondition(
      actual !== undefined && counterpart !== undefined,
      `missing transcript ${name}`,
    );
    compareText(`${name} memory/file`, actual, counterpart);
    const golden = readFileSync(join(goldens, name), "utf8");
    compareText(`${name} golden`, actual, golden);
  }
  const goldenNames = readdirSync(goldens)
    .filter((name) => name.endsWith(".http"))
    .sort();
  compareText("golden file list", `${names.join("\n")}\n`, `${goldenNames.join("\n")}\n`);
}

function verifyCorpus(left: readonly CorpusOutcome[], right: readonly CorpusOutcome[]): void {
  requireCondition(left.length === right.length, "memory/file corpus case counts diverged");
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    requireCondition(a !== undefined && b !== undefined, `missing corpus outcome at ${index}`);
    compareText(`corpus ${a.id} status`, JSON.stringify(a.status), JSON.stringify(b.status));
    compareText(
      `corpus ${a.id} responses`,
      JSON.stringify(a.responses),
      JSON.stringify(b.responses),
    );
    compareText(`corpus ${a.id} before digest`, a.digestBefore, b.digestBefore);
    compareText(`corpus ${a.id} after digest`, a.digestAfter, b.digestAfter);
  }
}

export async function main(): Promise<void> {
  assertOffsetOpacity();
  const run = await collectBoth();
  requireCondition(run.variants.length === 2, "conformance did not run both stores");
  const memory = run.variants.find((variant) => variant.variant === "memory");
  const file = run.variants.find((variant) => variant.variant === "file");
  requireCondition(memory !== undefined && file !== undefined, "missing memory or file run");
  requireCondition(memory.caseCount === file.caseCount, "memory/file spec case counts diverged");
  const goldens = resolve(repoRoot, "packages/conformance/transcripts");
  verifyTranscripts(memory.transcripts, file.transcripts, goldens);
  verifyCorpus(memory.corpus, file.corpus);
  writeEvidence(run);
  for (const variant of run.variants) {
    console.log(
      `${variant.variant}: ${variant.caseCount} transcript cases, ${variant.corpus.length} corpus seeds, ${variant.baseUrl}`,
    );
  }
  console.log("conformance: transcripts, corpus, and offset opacity passed");
}

await main();
