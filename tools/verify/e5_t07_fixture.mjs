import assert from "node:assert/strict";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import {
  meadowPrInitialStateForStream,
  meadowPrReducer,
} from "../../packages/meadow/dist/src/index.js";
import {
  issueInitialStateFor,
  reduceIssueApplicationEvent,
} from "../../packages/reducers/dist/src/index.js";

export const E5_T07_PR_STREAM = "pr:maple/reading-room/42";

export function parseCanonicalJsonl(source, label) {
  assert.ok(source.endsWith("\n"), `${label}: missing trailing newline`);
  assert.ok(!source.includes("\r"), `${label}: CRLF is forbidden`);
  const lines = source.slice(0, -1).split("\n");
  const records = lines.map((line, index) => {
    const record = JSON.parse(line);
    assert.equal(
      line,
      canonicalJson(record),
      `${label}:${String(index + 1)} is not canonical JSON`,
    );
    assert.equal(
      record.offset,
      `0000000000000000_${String(index).padStart(16, "0")}`,
      `${label}:${String(index + 1)} offset drifted`,
    );
    return record;
  });
  return records;
}

export function issueDigest(records, length = records.length) {
  return stateDigest(
    records.slice(0, length).reduce(reduceIssueApplicationEvent, issueInitialStateFor("7")),
  );
}

export function prDigest(records, length = records.length) {
  return stateDigest(
    records
      .slice(0, length)
      .reduce(meadowPrReducer, meadowPrInitialStateForStream(E5_T07_PR_STREAM)),
  );
}

export function verifyCloseFixture(issueSource, prSource, expected) {
  const issues = parseCanonicalJsonl(issueSource, "close-on-merge issue log");
  const prs = parseCanonicalJsonl(prSource, "close-on-merge PR log");
  assert.deepEqual(
    issues.map(({ type }) => type),
    ["issue.opened", "issue.state-changed", "issue.linked", "issue.state-changed"],
  );
  assert.deepEqual(
    prs.map(({ type }) => type),
    ["pr.opened", "pr.approved", "pr.merged", "pr.link-closed"],
  );
  const merged = prs.find(({ type }) => type === "pr.merged");
  const closed = issues.find(
    ({ type, payload }) => type === "issue.state-changed" && payload.to === "done",
  );
  const backlink = prs.find(({ type }) => type === "pr.link-closed");
  assert.ok(merged && closed && backlink, "close fixture is missing a citation endpoint");
  assert.equal(closed.payload.via.prMergedOffset, merged.offset, "issue merge citation drifted");
  assert.equal(backlink.payload.issueOffset, closed.offset, "PR issue citation drifted");
  assert.deepEqual(expected.citations, {
    prMergedOffset: merged.offset,
    issueOffset: closed.offset,
  });
  const observed = {
    issue: {
      beforeLink: issueDigest(issues, 2),
      afterLink: issueDigest(issues, 3),
      final: issueDigest(issues),
    },
    pr: { final: prDigest(prs) },
  };
  assert.deepEqual(observed, { issue: expected.issue, pr: expected.pr });
  assert.equal(
    issues.filter(({ type, payload }) => type === "issue.state-changed" && payload.to === "done")
      .length,
    1,
  );
  assert.equal(prs.filter(({ type }) => type === "pr.link-closed").length, 1);
  return { issues, prs, merged, closed, backlink, observed };
}
