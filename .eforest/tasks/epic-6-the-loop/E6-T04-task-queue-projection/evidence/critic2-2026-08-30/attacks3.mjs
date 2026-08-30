import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = "/Users/blamy/Documents/Codex/electric-forest";
const T = await import(join(root, "packages/tasks/dist/src/index.js"));
const ORG = "maple", REPO = "loom";
const G = (n) => JSON.parse(readFileSync(join(root, ".eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/evidence/fixtures/graphs", n + ".json"), "utf8"));
const graph = G("mixed-epics-interleaved-priority");
const sources = T.queueSourcesFromGraph(ORG, REPO, graph);
const proof = T.queueProof(T.projectQueue(sources));
console.log("proof decision", JSON.stringify(proof.decision), "heads", proof.heads.length);
const off = (n) => `0000000000000000_${String(n).padStart(16, "0")}`;
// (a) catalog moves: a new task issue appears
const newStream = `issue:${ORG}/${REPO}/E9-T01`;
const catMoved = { catalog: { stream: sources.catalog.stream, records: [...sources.catalog.records, { type: "repo.issue-observed", payload: { v: 1, issueStreamId: newStream, sourceOffset: off(0) }, ts: 999, offset: off(sources.catalog.records.length) }] }, tasks: [...sources.tasks, { stream: newStream, records: T.graphTaskRecords(ORG, REPO, { id: "E9-T01", epic: 9, priority: "901", title: "late", status: "pending", depends_on: [], estimate: "S", capstone: true }) }] };
let r = T.checkQueueProof(proof, catMoved); console.log("catalog-moved", r.ok, r.reason, JSON.stringify(r.stale));
// (b) a VERIFIED, unrelated task's stream gains a comment: proof must still be refused (every head consumed)
const v = sources.tasks.find((x) => x.records.some((rec) => rec.type === "task.verified"));
const vMoved = { catalog: sources.catalog, tasks: sources.tasks.map((x) => x === v ? { stream: x.stream, records: [...x.records, { type: "issue.commented", payload: { v: 1, commentId: "c9", body: "hi" }, ts: 999, offset: off(x.records.length) }] } : x) };
r = T.checkQueueProof(proof, vMoved); console.log("verified-task-moved", r.ok, r.reason, JSON.stringify(r.stale));
r = T.admitSelection(proof, proof.decision.nextEligible, vMoved); console.log("admit-after-move", r.ok, r.reason);
// (c) the chosen task itself gets started by someone else (its own stream moves): old proof must not admit it again
const next = sources.tasks.find((x) => x.stream.endsWith("/" + proof.decision.nextEligible));
const started = { catalog: sources.catalog, tasks: sources.tasks.map((x) => x === next ? { stream: x.stream, records: [...x.records, { type: "task.started", payload: { v: 1, by: { actor: "z", role: "builder", run: "agent-run:maple/z" } }, ts: 999, offset: off(x.records.length) }] } : x) };
r = T.admitSelection(proof, proof.decision.nextEligible, started); console.log("double-start", r.ok, r.reason, JSON.stringify(r.stale), "current decision", JSON.stringify(r.current.decision));
// (d) truncated stream (a record vanished): heads go backwards
const trunc = { catalog: sources.catalog, tasks: sources.tasks.map((x) => x === v ? { stream: x.stream, records: x.records.slice(0, -1) } : x) };
r = T.checkQueueProof(proof, trunc); console.log("truncated", r.ok, r.reason, JSON.stringify(r.stale));
// (e) proof with an extra forged head for a stream that does not exist
r = T.checkQueueProof({ ...proof, heads: [...proof.heads, { stream: "issue:maple/loom/E8-T01", offset: off(3) }] }, sources); console.log("forged-extra-head", r.ok, r.reason, JSON.stringify(r.stale));
// (f) proof with tasks[] tampered but digest/decision intact
r = T.checkQueueProof({ ...proof, tasks: proof.tasks.map((x) => ({ ...x, status: "verified" })) }, sources); console.log("tampered-tasks", r.ok, r.reason);
r = T.checkQueueProof({ ...proof, finalCapstone: "E1-T01" }, sources); console.log("tampered-finalCapstone", r.ok, r.reason);
r = T.checkQueueProof({ ...proof, v: 2 }, sources); console.log("wrong-version", r.ok, r.reason);
// attack 3: my own two-active + two-capstones inputs
const t = (id, status, depends_on = [], extra = {}) => { const [e, n] = id.slice(1).split("-T"); return { id, epic: +e, priority: String(+e * 100 + +n), title: `Task ${id} does one thing`, status, depends_on, estimate: "M", capstone: false, ...extra }; };
for (const [label, tasks] of [
  ["refuted+implemented, caps in E1 and E2", [t("E1-T01","refuted",[],{capstone:true}), t("E1-T02","implemented"), t("E2-T01","pending",["E1"],{capstone:true})]],
  ["in-progress+in-progress, two caps E2", [t("E1-T01","verified",[],{capstone:true}), t("E2-T01","in-progress",["E1"]), t("E2-T02","in-progress",[],{capstone:true}), t("E2-T03","pending",[],{capstone:true})]],
  ["three active", [t("E1-T01","refuted"), t("E1-T02","refuted"), t("E1-T03","implemented",[],{capstone:true})]],
]) {
  const p = T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks }));
  const pr = T.queueProof(p);
  const a = T.admitSelection(pr, tasks[0].id, T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks }));
  console.log(label, JSON.stringify(p.decision), "admit:", a.reason, "md has gate:", T.renderQueueMarkdown(p).includes("## Current gate"));
}
