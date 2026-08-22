import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const evidence = resolve(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T01-issue-event-model/evidence",
);
const refusalPath = resolve(evidence, "refusals/issue-http-cases.txt");
const boundaryPath = resolve(evidence, "refusals/issue-boundary-cases.txt");
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

const limitLines = readFileSync(boundaryPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("E5_T01_LIMITS "));
requireCondition(
  JSON.stringify(limitLines) ===
    JSON.stringify(['E5_T01_LIMITS {"dispatchBytes":10485760,"stringCodeUnits":1048576}']),
  "issue request/string limits drifted",
);

const boundaryLines = readFileSync(boundaryPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("E5_T01_BOUNDARY "));
const expectedBoundaryCases = [
  ["exact-version-1.0", "v", "lexical-1.0"],
  ["exact-body-10mib", "body", "request-over-10mib"],
  ["exact-opened-nul-astral", "title+body", "nul+astral"],
  ["opened-title-nul", "title", "nul"],
  ["opened-title-astral", "title", "astral"],
  ["opened-body-nul", "body", "nul"],
  ["opened-body-astral", "body", "astral"],
  ["commented-comment-id-nul", "commentId", "nul"],
  ["commented-comment-id-astral", "commentId", "astral"],
  ["commented-body-nul", "body", "nul"],
  ["commented-body-astral", "body", "astral"],
  ["labeled-label-nul", "label", "nul"],
  ["labeled-label-astral", "label", "astral"],
  ["unlabeled-label-nul", "label", "nul"],
  ["unlabeled-label-astral", "label", "astral"],
  ["state-changed-to-nul", "to", "nul"],
  ["state-changed-to-astral", "to", "astral"],
  ["closed-reason-nul", "reason", "nul"],
  ["closed-reason-astral", "reason", "astral"],
];
requireCondition(
  boundaryLines.length === expectedBoundaryCases.length,
  "boundary transcript case count drifted",
);
const boundaryRecords = boundaryLines.map((line) =>
  JSON.parse(line.slice("E5_T01_BOUNDARY ".length)),
);
for (const [index, expected] of expectedBoundaryCases.entries()) {
  const record = boundaryRecords[index];
  requireCondition(record.case === expected[0], `boundary case ${index} name drifted`);
  requireCondition(record.field === expected[1], `${record.case}: field drifted`);
  requireCondition(record.invalid === expected[2], `${record.case}: invalid kind drifted`);
  requireCondition(record.status === 422, `${record.case}: expected HTTP 422`);
  requireCondition(
    record.responseBody === '{"error":{"class":"schema-violation"}}',
    `${record.case}: response body drifted`,
  );
  requireCondition(record.before.head === record.after.head, `${record.case}: head changed`);
  requireCondition(record.before.digest === record.after.digest, `${record.case}: digest changed`);
  requireCondition(
    Number.isInteger(record.requestBodyBytes) && record.requestBodyBytes > 0,
    `${record.case}: request byte count is missing`,
  );
  requireCondition(
    Number.isInteger(record.requestBodyCodeUnits) && record.requestBodyCodeUnits > 0,
    `${record.case}: request code-unit count is missing`,
  );
  requireCondition(
    /^[0-9a-f]{64}$/.test(record.requestBodySha256),
    `${record.case}: request SHA-256 is missing`,
  );
}
const exactVersionBody =
  '{"streamId":"issue:maple/reading-room/v-float","event":{"type":"issue.opened","payload":{"v":1.0,"title":"t","body":"b"},"ts":1}}';
requireCondition(
  boundaryRecords[0].requestBodySha256 ===
    createHash("sha256").update(exactVersionBody).digest("hex") &&
    boundaryRecords[0].payloadCodeUnits === 3,
  "exact-version-1.0 request body drifted",
);
const exactLargeBody = JSON.stringify({
  streamId: "issue:maple/reading-room/body-10mib",
  event: {
    type: "issue.opened",
    payload: { v: 1, title: "t", body: "x".repeat(10_485_760) },
    ts: 1,
  },
});
requireCondition(
  boundaryRecords[1].payloadCodeUnits === 10_485_760 &&
    boundaryRecords[1].requestBodyBytes > 10_485_760 &&
    boundaryRecords[1].requestBodySha256 ===
      createHash("sha256").update(exactLargeBody).digest("hex"),
  "exact-body-10mib no longer pins a 10 MiB body inside an over-limit request",
);
const exactUnicodeBody = JSON.stringify({
  streamId: "issue:maple/reading-room/unicode-combined",
  event: {
    type: "issue.opened",
    payload: { v: 1, title: "🧪\u0000title", body: "left\u0000right-🜁" },
    ts: 1,
  },
});
requireCondition(
  boundaryRecords[2].payloadCodeUnits === 21 &&
    boundaryRecords[2].requestBodySha256 ===
      createHash("sha256").update(exactUnicodeBody).digest("hex"),
  "exact-opened-nul-astral request body drifted",
);

const precedenceLines = readFileSync(boundaryPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("E5_T01_PRECEDENCE "));
const expectedPrecedenceCases = [
  [
    "unknown-before-schema",
    "unknown-action-type",
    404,
    '{"error":{"class":"unknown-action-type"}}',
  ],
  ["schema-before-validator", "schema-violation", 422, '{"error":{"class":"schema-violation"}}'],
  [
    "validator-after-schema",
    "validator-rejected",
    409,
    '{"error":{"class":"validator-rejected","reason":"issue/already-opened"}}',
  ],
];
requireCondition(
  precedenceLines.length === expectedPrecedenceCases.length,
  "precedence transcript case count drifted",
);
const precedenceRecords = precedenceLines.map((line) =>
  JSON.parse(line.slice("E5_T01_PRECEDENCE ".length)),
);
for (const [index, expected] of expectedPrecedenceCases.entries()) {
  const record = precedenceRecords[index];
  requireCondition(record.case === expected[0], `precedence case ${index} name drifted`);
  requireCondition(record.layer === expected[1], `${record.case}: precedence layer drifted`);
  requireCondition(record.status === expected[2], `${record.case}: precedence status drifted`);
  requireCondition(record.responseBody === expected[3], `${record.case}: response body drifted`);
  requireCondition(record.before.head === record.after.head, `${record.case}: head changed`);
  requireCondition(record.before.digest === record.after.digest, `${record.case}: digest changed`);
  requireCondition(
    Number.isInteger(record.requestBodyBytes) && record.requestBodyBytes > 0,
    `${record.case}: request byte count is missing`,
  );
  requireCondition(
    Number.isInteger(record.requestBodyCodeUnits) && record.requestBodyCodeUnits > 0,
    `${record.case}: request code-unit count is missing`,
  );
  requireCondition(
    /^[0-9a-f]{64}$/.test(record.requestBodySha256),
    `${record.case}: request SHA-256 is missing`,
  );
}
const precedenceBodies = [
  '{"streamId":"issue:maple/reading-room/source-aware","event":{"type":"issue.unknown","payload":{"v":1.0,"title":"\\u0000"},"ts":2}}',
  JSON.stringify({
    streamId: "issue:maple/reading-room/source-aware",
    event: {
      type: "issue.opened",
      payload: { v: 1, title: "duplicate\u0000title", body: "b" },
      ts: 1,
    },
  }),
  JSON.stringify({
    streamId: "issue:maple/reading-room/source-aware",
    event: {
      type: "issue.opened",
      payload: { v: 1, title: "duplicate", body: "b" },
      ts: 1,
    },
  }),
];
for (const [index, body] of precedenceBodies.entries()) {
  requireCondition(
    precedenceRecords[index].requestBodySha256 === createHash("sha256").update(body).digest("hex"),
    `${precedenceRecords[index].case}: request body drifted`,
  );
}

const scannerLines = readFileSync(boundaryPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("E5_T01_SCANNER "));
const expectedScannerCases = [
  {
    name: "escaped-key-valid",
    outcome: "accepted",
    status: 202,
    versionToken: "1",
    responseBody: '{"ok":true,"actor":"alice","identityOffset":"-1"}',
    rawBody:
      '{"streamId":"issue:maple/reading-room/scanner-escaped-valid","event":{"type":"issue.opened","payload":{"\\u0076":1,"title":"t","body":"b"},"ts":1}}',
  },
  {
    name: "escaped-key-invalid",
    outcome: "refused",
    status: 422,
    versionToken: "1.0",
    responseBody: '{"error":{"class":"schema-violation"}}',
    rawBody:
      '{"streamId":"issue:maple/reading-room/scanner-escaped-invalid","event":{"type":"issue.opened","payload":{"\\u0076":1.0,"title":"t","body":"b"},"ts":1}}',
  },
  {
    name: "duplicate-last-valid",
    outcome: "accepted",
    status: 202,
    versionToken: "1",
    responseBody: '{"ok":true,"actor":"alice","identityOffset":"-1"}',
    rawBody:
      '{"streamId":"issue:maple/reading-room/scanner-duplicate-valid","event":{"type":"issue.opened","payload":{"v":1.0,"v":1,"title":"t","body":"b"},"ts":1}}',
  },
  {
    name: "duplicate-last-invalid",
    outcome: "refused",
    status: 422,
    versionToken: "1.0",
    responseBody: '{"error":{"class":"schema-violation"}}',
    rawBody:
      '{"streamId":"issue:maple/reading-room/scanner-duplicate-invalid","event":{"type":"issue.opened","payload":{"v":1,"v":1.0,"title":"t","body":"b"},"ts":1}}',
  },
  {
    name: "decoy-valid",
    outcome: "accepted",
    status: 202,
    versionToken: "1",
    responseBody: '{"ok":true,"actor":"alice","identityOffset":"-1"}',
    rawBody:
      '{"v":1.0,"decoy":{"event":{"payload":{"v":1.0}}},"streamId":"issue:maple/reading-room/scanner-decoy-valid","event":{"type":"issue.opened","payload":{"v":1,"title":"literal \\"v\\":1.0","body":"b"},"ts":1}}',
  },
  {
    name: "decoy-invalid",
    outcome: "refused",
    status: 422,
    versionToken: "1.0",
    responseBody: '{"error":{"class":"schema-violation"}}',
    rawBody:
      '{"v":1,"decoy":{"event":{"payload":{"v":1}}},"streamId":"issue:maple/reading-room/scanner-decoy-invalid","event":{"type":"issue.opened","payload":{"v":1.0,"title":"literal \\"v\\":1","body":"b"},"ts":1}}',
  },
];
requireCondition(
  scannerLines.length === expectedScannerCases.length,
  "scanner transcript case count drifted",
);
const scannerRecords = scannerLines.map((line) => JSON.parse(line.slice("E5_T01_SCANNER ".length)));
for (const [index, expected] of expectedScannerCases.entries()) {
  const record = scannerRecords[index];
  requireCondition(record.case === expected.name, `scanner case ${index} name drifted`);
  requireCondition(record.outcome === expected.outcome, `${record.case}: outcome drifted`);
  requireCondition(record.status === expected.status, `${record.case}: status drifted`);
  requireCondition(
    record.versionToken === expected.versionToken,
    `${record.case}: version token drifted`,
  );
  requireCondition(
    record.responseBody === expected.responseBody,
    `${record.case}: response body drifted`,
  );
  requireCondition(record.before.head === -1, `${record.case}: initial head drifted`);
  if (expected.outcome === "accepted") {
    requireCondition(record.after.head === 0, `${record.case}: accepted head drifted`);
    requireCondition(
      record.after.digest !== record.before.digest,
      `${record.case}: accepted digest did not change`,
    );
  } else {
    requireCondition(record.after.head === record.before.head, `${record.case}: head changed`);
    requireCondition(
      record.after.digest === record.before.digest,
      `${record.case}: digest changed`,
    );
  }
  requireCondition(
    record.requestBodyBytes === Buffer.byteLength(expected.rawBody) &&
      record.requestBodyCodeUnits === expected.rawBody.length &&
      record.requestBodySha256 === createHash("sha256").update(expected.rawBody).digest("hex"),
    `${record.case}: request source drifted`,
  );
}

const recoveryLines = readFileSync(boundaryPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("E5_T01_RECOVERY "));
requireCondition(recoveryLines.length === 1, "operation recovery transcript case count drifted");
const recovery = JSON.parse(recoveryLines[0].slice("E5_T01_RECOVERY ".length));
const recoveryValidBody =
  '{"streamId":"issue:maple/reading-room/operation-recovery","event":{"type":"issue.opened","payload":{"v":1,"title":"stable","body":"payload"},"ts":1}}';
const recoveryInvalidBody =
  '{"streamId":"issue:maple/reading-room/operation-recovery","event":{"type":"issue.opened","payload":{"v":1.0,"title":"stable","body":"payload"},"ts":1}}';
const validPayload = JSON.stringify(JSON.parse(recoveryValidBody).event.payload);
const invalidPayload = JSON.stringify(JSON.parse(recoveryInvalidBody).event.payload);
requireCondition(validPayload === invalidPayload, "recovery payload fixtures are not byte-equal");
requireCondition(
  recovery.case === "operation-id-lexical-bypass" &&
    recovery.operationId === "issue-lexical-version-recovery" &&
    recovery.writerOperationId === recovery.operationId,
  "operation recovery identity drifted",
);
requireCondition(
  recovery.validStatus === 202 &&
    recovery.validResponseBody === '{"ok":true,"actor":"alice","identityOffset":"-1"}' &&
    recovery.status === 422 &&
    recovery.responseBody === '{"error":{"class":"schema-violation"}}',
  "operation recovery response drifted",
);
requireCondition(
  recovery.authorizedMutationCalls === 1,
  "invalid lexical request reached authorized mutation recovery",
);
requireCondition(
  recovery.before.head === 0 &&
    recovery.after.head === recovery.before.head &&
    recovery.after.digest === recovery.before.digest,
  "operation recovery refusal changed head or digest",
);
requireCondition(
  recovery.validRequestSha256 === createHash("sha256").update(recoveryValidBody).digest("hex") &&
    recovery.invalidRequestSha256 ===
      createHash("sha256").update(recoveryInvalidBody).digest("hex") &&
    recovery.decodedPayloadSha256 === createHash("sha256").update(validPayload).digest("hex"),
  "operation recovery request or decoded payload drifted",
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
  for (const line of [
    ...refusalLines,
    ...limitLines,
    ...boundaryLines,
    ...precedenceLines,
    ...scannerLines,
    ...recoveryLines,
    ...propertyLines,
  ])
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
    "online-offline-digest=e3f61f6f10794dd008fc2629f4e6a342b3ed40ff9cec79c971ca879a7182f105",
  ),
  "real-stream evidence does not pin online/offline digest equality",
);
console.log(
  `E5_T01_EVIDENCE_OK refusal-cases=${refusalLines.length} limits=${limitLines.length} boundary-cases=${boundaryLines.length} precedence-cases=${precedenceLines.length} scanner-cases=${scannerLines.length} recovery-cases=${recoveryLines.length} property-cases=${propertyLines.length}`,
);
