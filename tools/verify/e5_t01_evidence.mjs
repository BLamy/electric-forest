import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const evidence = resolve(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T01-issue-event-model/evidence",
);
const refusalPath = resolve(evidence, "refusals/issue-http-cases.txt");
const propertyPath = resolve(evidence, "property-suite.txt");
const runtimePath = process.argv[2] === undefined ? undefined : resolve(root, process.argv[2]);

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

const refusalLines = readFileSync(refusalPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("E5_T01_REFUSAL "));
const expectedCases = [
  "duplicate-open",
  "closed-reason-schema",
  "unknown-action",
  "prototype-to-string-action",
  "prototype-constructor-action",
  "duplicate-comment",
  "duplicate-label",
  "missing-label",
  "self-transition",
  "state-changed-to-closed",
  "duplicate-reopen",
  "closed-from-done",
  "malformed-body",
  "pre-open-comment",
];
requireCondition(
  refusalLines.length === expectedCases.length,
  "refusal transcript case count drifted",
);
const refusalCases = [];
for (const line of refusalLines) {
  const record = JSON.parse(line.slice("E5_T01_REFUSAL ".length));
  requireCondition(typeof record.case === "string", "refusal case name is missing");
  requireCondition(
    typeof record.requestBody === "string",
    `${record.case}: request body is missing`,
  );
  requireCondition(
    typeof record.responseBody === "string",
    `${record.case}: response body is missing`,
  );
  const response = JSON.parse(record.responseBody);
  requireCondition(
    response !== null && typeof response === "object",
    `${record.case}: response is not JSON`,
  );
  requireCondition(Number.isInteger(record.status), `${record.case}: response status is missing`);
  requireCondition(
    record.before.head === record.after.head,
    `${record.case}: head changed after refusal`,
  );
  requireCondition(
    record.before.digest === record.after.digest,
    `${record.case}: digest changed after refusal`,
  );
  refusalCases.push(record.case);
}
requireCondition(
  JSON.stringify(refusalCases) === JSON.stringify(expectedCases),
  `refusal case order changed: ${refusalCases.join(",")}`,
);

const propertyLines = readFileSync(propertyPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("E5_T01_PROPERTY "));
const expectedProperties = ["(a)", "(b)", "(c)", "(d)"].map(
  (property) => `E5_T01_PROPERTY property=${property} seeds=1000 steps=24 seed-range=0..999`,
);
requireCondition(
  JSON.stringify(propertyLines) === JSON.stringify(expectedProperties),
  "property transcript does not pin all four 1,000-seed runs",
);

if (runtimePath !== undefined) {
  const runtime = readFileSync(runtimePath, "utf8");
  for (const line of [...refusalLines, ...propertyLines])
    requireCondition(
      runtime.includes(line),
      `focused runtime did not emit committed evidence: ${line}`,
    );
}

const integration = readFileSync(resolve(evidence, "real-stream-integration.txt"), "utf8");
requireCondition(
  integration.includes("golden-records=7"),
  "real-stream evidence does not cover the golden sequence",
);
requireCondition(
  integration.includes(
    "online-offline-digest=d8f26393a6b6912ea9aee063ab399fb972a15d5ab4af2a3beb5aa646ce81dea4",
  ),
  "real-stream evidence does not pin online/offline digest equality",
);
console.log(
  `E5_T01_EVIDENCE_OK refusal-cases=${refusalLines.length} property-cases=${propertyLines.length}`,
);
