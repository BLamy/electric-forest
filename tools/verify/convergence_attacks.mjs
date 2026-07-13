import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const harness = resolve(repoRoot, "tools/verify/convergence.mjs");

function run(args) {
  return spawnSync(process.execPath, [harness, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 45_000,
  });
}

function output(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function expectRed(args, needle, label) {
  const result = run(args);
  if (result.status === 0) throw new Error(`${label} stayed green`);
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${label} timed out`);
  const text = output(result);
  if (!text.includes("DIVERGENCE path="))
    throw new Error(`${label} did not name a divergent path: ${text}`);
  if (needle && !text.includes(needle)) throw new Error(`${label} missing ${needle}: ${text}`);
  console.log(`${label}: expected red (${needle || "divergent path"})`);
}

expectRed(["--suppress-live", "1"], '"index":1', "suppress-first-record");
expectRed(["--suppress-live", "8"], '"index":8', "suppress-mid-record");
expectRed(["--suppress-live", "16"], '"index":16', "suppress-final-record");
expectRed(["--corrupt-cold-byte", "20"], "DIVERGENCE path=state.", "corrupt-cold-state-byte");
console.log("convergence attacks: all sensitivity checks passed");
