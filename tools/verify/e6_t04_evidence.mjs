#!/usr/bin/env node
// verify-E6-T04: rebuild the committed queue fixture from its source logs in fresh
// processes (delete-and-rebuild parity, shuffled fetch orders), hold every frozen graph
// to its committed projection/markdown/digest, run the REAL tools/build_queue.py over
// every valid graph and byte-diff the normalized decisions and markdown against the
// TypeScript projector, fence a stale proof, and prove the apparatus is sensitive to one
// byte of source and to the bare-epic sentinel fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  BUILD_QUEUE_GENERATOR_LINE,
  E6_T04_BARE_EPIC_GUARD,
  QUEUE_VIOLATION_REASONS,
  checkQueueProof,
  generateQueueGraph,
  graphReadme,
  normalizeQueueDecision,
  permuteSources,
  projectQueue,
  queueDigest,
  queueProof,
  queueSourcesFromGraph,
  renderQueueMarkdown,
} from "../../packages/tasks/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, ".eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/evidence");
const runner = join(root, "tools/verify/e6_t04_queue.mjs");
const normalizer = join(root, "tools/verify/queue_differential.py");
const ORG = "maple";
const REPO = "loom";
const protectedNames = [
  "e6-t04-sources.jsonl",
  "e6-t04-queue.json",
  "e6-t04-QUEUE.md",
  "e6-t04-queue.digest",
  "e6-t04-proof.json",
  "e6-t04-endpoint.txt",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = (name) => join(evidence, name);
const before = new Map(protectedNames.map((name) => [name, sha256(readFileSync(artifact(name)))]));

function freshProcess(args, cwd, timezone, expectFailure = false) {
  const env = { ...process.env, LANG: "C", LC_ALL: "C", TZ: timezone };
  delete env.NODE_ENV;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env });
  if (expectFailure) return result;
  assert.equal(result.status, 0, `${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${args.join(" ")} wrote stderr`);
  return result.stdout;
}

function python(graph, tree) {
  rmSync(tree, { recursive: true, force: true });
  for (const task of graph.tasks) {
    const folder = join(tree, `epic-${task.epic}`, task.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "readme.md"), graphReadme(task));
  }
  const result = spawnSync("python3", [normalizer, "--tree", tree], { encoding: "utf8" });
  assert.equal(result.status, 0, `queue_differential.py failed\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

const view = (value) =>
  JSON.stringify({
    gate: value.gate,
    nextUp: value.nextUp,
    selected: value.selected,
    tuples: value.tuples,
    unlocks: value.unlocks,
    markdown: value.markdown,
  });

function tsView(graph) {
  const projection = projectQueue(queueSourcesFromGraph(ORG, REPO, graph));
  const normalized = normalizeQueueDecision(projection);
  return {
    projection,
    text: view({
      ...normalized,
      markdown: renderQueueMarkdown(projection, BUILD_QUEUE_GENERATOR_LINE),
    }),
  };
}

// 1. The committed queue fixture: sources → projection/markdown/digest/proof, byte-identical.
const sourceLines = readFileSync(artifact("e6-t04-sources.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => {
    const parsed = JSON.parse(line);
    assert.equal(canonicalJson(parsed), line, "e6-t04-sources.jsonl: non-canonical line");
    return parsed;
  });
const catalog = sourceLines.find((line) => line.stream.startsWith("repo-issues:"));
const sources = {
  catalog,
  tasks: sourceLines.filter((line) => !line.stream.startsWith("repo-issues:")),
};
const expectedDigest = readFileSync(artifact("e6-t04-queue.digest"), "utf8").trim();
assert.match(expectedDigest, /^[0-9a-f]{64}$/);
const expectedJson = readFileSync(artifact("e6-t04-queue.json"), "utf8");
const expectedMarkdown = readFileSync(artifact("e6-t04-QUEUE.md"), "utf8");
const expectedProof = readFileSync(artifact("e6-t04-proof.json"), "utf8");
const projection = projectQueue(sources);
assert.equal(`${canonicalJson(projection)}\n`, expectedJson, "queue.json drifted");
assert.equal(renderQueueMarkdown(projection), expectedMarkdown, "QUEUE.md drifted");
assert.equal(queueDigest(projection), expectedDigest, "digest drifted");
assert.equal(`${canonicalJson(queueProof(projection))}\n`, expectedProof, "proof drifted");
assert.equal(projection.decision.kind, "eligible");
assert.equal(projection.decision.nextEligible, "E2-T01");
assert.equal(queueProof(projection).heads.length, sources.tasks.length, "every task head consumed");
console.log(
  `E6_T04_FIXTURE catalog=${catalog.stream}@${projection.sources.catalog.offset} tasks=${projection.tasks.length} next=${projection.decision.nextEligible}`,
);
console.log(`E6_T04_DIGEST ${expectedDigest}`);
console.log(
  `E6_T04_QUEUE_MD sha256=${sha256(expectedMarkdown)} bytes=${Buffer.byteLength(expectedMarkdown)}`,
);

const scratch = mkdtempSync(join(tmpdir(), "e6-t04-"));
try {
  // 2. Delete-and-rebuild: the derived artifacts are re-derived in three fresh processes
  //    (foreign cwd + time zones, two shuffled fetch orders) and must be byte-identical.
  const expectedLine = `${expectedDigest} ${sha256(expectedJson)} ${sha256(expectedMarkdown)}`;
  const rebuilt = join(scratch, "rebuilt");
  const one = freshProcess(
    [runner, artifact("e6-t04-sources.jsonl"), "--out", rebuilt],
    scratch,
    "Pacific/Kiritimati",
  ).trim();
  const two = freshProcess(
    [runner, artifact("e6-t04-sources.jsonl"), "--shuffle", "7"],
    join(root, "packages/tasks"),
    "America/Sao_Paulo",
  ).trim();
  const three = freshProcess(
    [runner, artifact("e6-t04-sources.jsonl"), "--shuffle", "12345"],
    root,
    "UTC",
  ).trim();
  assert.equal(one, expectedLine, "process one");
  assert.equal(two, expectedLine, "process two (shuffled)");
  assert.equal(three, expectedLine, "process three (shuffled)");
  assert.equal(readFileSync(join(rebuilt, "queue.json"), "utf8"), expectedJson);
  assert.equal(readFileSync(join(rebuilt, "QUEUE.md"), "utf8"), expectedMarkdown);
  assert.equal(readFileSync(join(rebuilt, "queue.digest"), "utf8"), `${expectedDigest}\n`);
  assert.equal(readFileSync(join(rebuilt, "proof.json"), "utf8"), expectedProof);
  console.log(
    `E6_T04_REBUILD processes=3 shuffled=2 byte-identical=true digest=${one.split(" ")[0]}`,
  );

  // 3. Every frozen graph holds to its committed projection/markdown/digest; invalid graphs
  //    carry no nextEligible; each violation reason is reached.
  const graphs = readdirSync(join(evidence, "fixtures/graphs"))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(evidence, "fixtures/graphs", name), "utf8")));
  const reasons = new Set();
  let valid = 0;
  let invalid = 0;
  for (const graph of graphs) {
    const derived = projectQueue(queueSourcesFromGraph(ORG, REPO, graph));
    assert.equal(
      `${canonicalJson(derived)}\n`,
      readFileSync(join(evidence, "expected", `${graph.name}.queue.json`), "utf8"),
      graph.name,
    );
    assert.equal(
      renderQueueMarkdown(derived),
      readFileSync(join(evidence, "expected", `${graph.name}.QUEUE.md`), "utf8"),
      graph.name,
    );
    assert.equal(
      `${queueDigest(derived)}\n`,
      readFileSync(join(evidence, "expected", `${graph.name}.digest`), "utf8"),
      graph.name,
    );
    if (graph.valid) {
      valid += 1;
      assert.notEqual(derived.decision.kind, "invalid", graph.name);
    } else {
      invalid += 1;
      assert.equal(derived.decision.kind, "invalid", graph.name);
      assert.ok(
        !("nextEligible" in derived.decision),
        `${graph.name}: invalid proof has no nextEligible`,
      );
      for (const violation of derived.decision.violations) reasons.add(violation.reason);
    }
  }
  for (const reason of QUEUE_VIOLATION_REASONS) {
    if (reason === "queue/duplicate-id" || reason === "catalog/corrupt") continue;
    assert.ok(reasons.has(reason), `violation reason never reached: ${reason}`);
  }
  console.log(
    `E6_T04_GRAPHS valid=${valid} invalid=${invalid} reasons=${reasons.size}/${QUEUE_VIOLATION_REASONS.length}`,
  );

  // 4. Python/TypeScript differential: the real build_queue.py over every valid frozen
  //    graph and 40 generated DAGs; normalized decisions AND markdown (generator line
  //    aside) must be byte-identical. The frozen python.json must match a live run.
  let compared = 0;
  for (const graph of graphs) {
    if (!graph.valid) continue;
    const live = python(graph, join(scratch, "py", graph.name));
    assert.deepEqual(live.warnings, [], `${graph.name}: build_queue.py warned`);
    assert.equal(
      JSON.stringify(live),
      readFileSync(join(evidence, "expected", `${graph.name}.python.json`), "utf8").trim(),
      `${graph.name}: frozen python.json`,
    );
    const ts = tsView(graph);
    assert.equal(ts.text, view(live), `${graph.name}: Python/TypeScript mismatch`);
    compared += 1;
  }
  for (let seed = 1; seed <= 40; seed += 1) {
    const graph = generateQueueGraph(seed);
    const live = python(graph, join(scratch, "py", graph.name));
    assert.equal(tsView(graph).text, view(live), `${graph.name}: Python/TypeScript mismatch`);
    compared += 1;
  }
  console.log(`E6_T04_DIFFERENTIAL graphs=${compared} python=tools/build_queue.py mismatches=0`);

  // 5. Permutation invariance across 60 generated graphs (valid and cyclic) and 4 orders each.
  let permutations = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    for (const cyclic of [false, true]) {
      const base = queueSourcesFromGraph(ORG, REPO, generateQueueGraph(seed, { cyclic }));
      const reference = queueDigest(projectQueue(base));
      for (const order of [
        permuteSources(base, seed),
        permuteSources(base, seed + 1000),
        { catalog: base.catalog, tasks: [...base.tasks].reverse() },
      ]) {
        assert.equal(queueDigest(projectQueue(order)), reference, `seed ${seed} cyclic=${cyclic}`);
        permutations += 1;
      }
    }
  }
  console.log(`E6_T04_PERMUTATIONS graphs=120 orders=${permutations} digest-identical=true`);

  // 6. Proof fencing: a proof obtained before a dependency's stream moves is refused.
  const proof = queueProof(projection);
  const moved = {
    catalog: sources.catalog,
    tasks: sources.tasks.map((task) =>
      task.stream.endsWith("/E1-T02")
        ? {
            stream: task.stream,
            records: [
              ...task.records,
              {
                type: "issue.commented",
                payload: { v: 1, commentId: "late", body: "moved" },
                ts: 999,
                offset: `0000000000000000_${String(task.records.length).padStart(16, "0")}`,
              },
            ],
          }
        : task,
    ),
  };
  const stale = checkQueueProof(proof, moved);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "queue/stale-proof");
  assert.equal(stale.stale.stream, "issue:maple/loom/E1-T02");
  assert.equal(checkQueueProof(proof, permuteSources(sources, 3)).ok, true);
  console.log(
    `E6_T04_FENCE stale-refused=${stale.reason} moved=${stale.stale.stream} cited=${stale.stale.cited} current=${stale.stale.current}`,
  );

  // 7. Endpoint transcript: the frozen real-gateway run decided in-flight → eligible at
  //    the new head, every cited head advancing monotonically.
  const endpoint = readFileSync(artifact("e6-t04-endpoint.txt"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      assert.ok(line.startsWith("E6_T04_QUEUE "), "endpoint transcript line");
      return JSON.parse(line.slice("E6_T04_QUEUE ".length));
    });
  assert.deepEqual(
    endpoint.map((entry) => entry.step),
    ["empty", "in-flight", "eligible", "second-in-flight"],
  );
  assert.deepEqual(endpoint[1].decision, {
    kind: "in-flight",
    nextEligible: null,
    inFlight: "E1-T01",
  });
  assert.deepEqual(endpoint[2].decision, {
    kind: "eligible",
    nextEligible: "E1-T02",
    inFlight: null,
  });
  assert.deepEqual(endpoint[3].decision, {
    kind: "in-flight",
    nextEligible: null,
    inFlight: "E1-T02",
  });
  const headOf = (entry, id) => entry.heads.find((head) => head.stream.endsWith(`/${id}`)).offset;
  assert.ok(
    headOf(endpoint[2], "E1-T01") > headOf(endpoint[1], "E1-T01"),
    "E1-T01 head advanced at the verdict",
  );
  assert.notEqual(endpoint[1].digest, endpoint[2].digest);
  assert.equal(endpoint[1].heads.length, 4);
  console.log(
    `E6_T04_ENDPOINT steps=${endpoint.length} in-flight->eligible head=${headOf(endpoint[1], "E1-T01")}->${headOf(endpoint[2], "E1-T01")}`,
  );

  // 8. The bare-epic sentinel fixture: a non-capstone verified before the capstone must
  //    NOT satisfy `E1`; the queue-jumping E2-T01 stays blocked and E1-T02 is next.
  assert.equal(E6_T04_BARE_EPIC_GUARD, true, "E6_T04_BARE_EPIC_GUARD");
  const sentinel = graphs.find((graph) => graph.name === "bare-epic-noncapstone-first");
  const sentinelProjection = projectQueue(queueSourcesFromGraph(ORG, REPO, sentinel));
  assert.deepEqual(sentinelProjection.decision, {
    kind: "eligible",
    nextEligible: "E1-T02",
    inFlight: null,
  });
  assert.deepEqual(sentinelProjection.tasks.find((task) => task.id === "E2-T01").blocked, [
    { reason: "dep/epic-capstone-unverified", ref: "E1", detail: "pending" },
  ]);
  const sentinelPython = python(sentinel, join(scratch, "py", "sentinel"));
  assert.equal(sentinelPython.selected, "E1-T02");
  console.log(
    `E6_T04_SENTINEL fixture=bare-epic-noncapstone-first next=E1-T02 blocked=E2-T01:dep/epic-capstone-unverified python=E1-T02`,
  );

  // 9. Sensitivity: one byte of the source log changes the digest; the runner goes red
  //    against the committed digest.
  const mutated = sourceLines.map((line) => {
    if (!line.stream.endsWith("/E2-T01")) return line;
    const records = line.records.map((record) =>
      record.type === "issue.labeled" && record.payload.label === "task"
        ? { ...record, payload: { ...record.payload, label: "tasq" } }
        : record,
    );
    return { ...line, records };
  });
  const mutatedPath = join(scratch, "mutated.jsonl");
  writeFileSync(mutatedPath, `${mutated.map((line) => canonicalJson(line)).join("\n")}\n`);
  const mutatedLine = freshProcess([runner, mutatedPath], scratch, "UTC").trim();
  assert.notEqual(mutatedLine, expectedLine, "a one-byte mutation must move the digest");
  console.log(
    `MUTATION e6-t04-sources.jsonl(E2-T01 label task->tasq) digest=${mutatedLine.split(" ")[0]} EXPECTED-FAIL OK`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

for (const [name, digest] of before) {
  assert.equal(
    sha256(readFileSync(artifact(name))),
    digest,
    `${name} was rewritten during verification`,
  );
}
console.log("E6_T04_EVIDENCE OK");
