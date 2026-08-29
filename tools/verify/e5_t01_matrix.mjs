import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKFLOW_TRANSITIONS } from "../../packages/reducers/dist/src/issues.js";

const root = process.cwd();
const moduleReadme = readFileSync(resolve(root, "packages/platform/src/issues/README.md"), "utf8");
const lines = moduleReadme.split(/\r?\n/);
const headerIndex = lines.findIndex((line) => line.startsWith("| state "));
if (headerIndex < 0) throw new Error("issue README matrix header is missing");

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const expectedActions = [
  "opened",
  "commented",
  "labeled",
  "unlabeled",
  "state-changed",
  "closed",
  "reopened",
];
const header = cells(lines[headerIndex]);
if (JSON.stringify(header) !== JSON.stringify(["state", ...expectedActions]))
  throw new Error(`issue README matrix columns changed: ${header.join(",")}`);

const rows = [];
for (const line of lines.slice(headerIndex + 2)) {
  if (!line.startsWith("|")) break;
  const row = cells(line);
  if (!row[0] || row[0].startsWith("-")) continue;
  rows.push(row);
}
if (rows.length !== 5) throw new Error(`expected 5 issue README matrix rows, got ${rows.length}`);

function implementationCell(state, action) {
  const value = WORKFLOW_TRANSITIONS[state][`issue.${action}`];
  if (value === false) return "refuse";
  if (action === "state-changed") {
    const destinations = Array.isArray(value) ? value : [];
    const expected = ["open", "in-progress", "done", "closed", "wont-do"].filter(
      (destination) => destination !== state && destination !== "closed",
    );
    if (JSON.stringify(destinations) === JSON.stringify(expected))
      return "any other non-closed state";
    return destinations.join(",");
  }
  return value;
}

for (const row of rows) {
  if (row.length !== 8) throw new Error(`matrix row ${row[0]} does not have 7 actions`);
  const state = row[0];
  if (!(state in WORKFLOW_TRANSITIONS)) throw new Error(`unknown matrix state ${state}`);
  for (const [index, action] of expectedActions.entries()) {
    const expected = row[index + 1];
    const actual = implementationCell(state, action);
    if (actual !== expected)
      throw new Error(`${state}/${action}: README=${expected}, implementation=${actual}`);
  }
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const forbiddenPatterns = [
  /\bcase\s+["'](?:open|in-progress|done|closed|wont-do)["']/,
  /\b(?:state|currentState)\s*!?==\s*["'](?:open|in-progress|done|closed|wont-do)["']/,
  /\bWORKFLOW_TRANSITIONS\s*=/,
];
const sourceFiles = [
  ...walk(resolve(root, "packages/platform/src/issues")),
  ...walk(resolve(root, "packages/server/src")),
].filter((path) => path.endsWith(".ts"));
const forbiddenMatches = [];
for (const path of sourceFiles) {
  if (path.endsWith("/workflow.ts")) continue;
  const source = readFileSync(path, "utf8");
  if (!/issue/i.test(source) && !path.includes("/issues/")) continue;
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(source)) forbiddenMatches.push(`${path}: ${pattern}`);
  }
}
if (forbiddenMatches.length > 0)
  throw new Error(`forbidden second-legality encoding:\n${forbiddenMatches.join("\n")}`);

const validatorSource = readFileSync(
  resolve(root, "packages/platform/src/issues/validators.ts"),
  "utf8",
);
if (!validatorSource.includes("isLegal"))
  throw new Error("issue validator no longer delegates legality to isLegal");

console.log("E5_T01_MATRIX_OK cells=35 forbidden-matches=0");
