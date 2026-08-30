// Critic attacks for E6-T04. Uses the built dist and the UNMODIFIED tools/build_queue.py
// through tools/verify/queue_differential.py. Prints one line per probe.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve("/Users/blamy/Documents/Codex/electric-forest");
const { canonicalJson } = await import(join(root, "packages/protocol/dist/src/index.js"));
const T = await import(join(root, "packages/tasks/dist/src/index.js"));
const normalizer = join(root, "tools/verify/queue_differential.py");
const scratch = mkdtempSync(join(tmpdir(), "e6-t04-critic-"));
const ORG = "maple";
const REPO = "loom";

function python(graph) {
  const tree = join(scratch, graph.name);
  rmSync(tree, { recursive: true, force: true });
  for (const task of graph.tasks) {
    const folder = join(tree, `epic-${task.epic}`, task.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "readme.md"), T.graphReadme(task));
  }
  const r = spawnSync("python3", [normalizer, "--tree", tree], { encoding: "utf8" });
  if (r.status !== 0) return { error: r.stderr };
  return JSON.parse(r.stdout);
}
const view = (v) =>
  JSON.stringify({ gate: v.gate, nextUp: v.nextUp, selected: v.selected, tuples: v.tuples, unlocks: v.unlocks, markdown: v.markdown });
function ts(graph) {
  const projection = T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, graph));
  const n = T.normalizeQueueDecision(projection);
  return { projection, text: view({ ...n, markdown: T.renderQueueMarkdown(projection, T.BUILD_QUEUE_GENERATOR_LINE) }), n };
}
function diffLines(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return `line ${i}: TS=${JSON.stringify(A[i])} PY=${JSON.stringify(B[i])}`;
  return "same";
}
const task = (id, status, deps = [], extra = {}) => {
  const [epic, n] = id.slice(1).split("-T");
  return { id, epic: Number(epic), priority: String(Number(epic) * 100 + Number(n)), title: `Task ${id}`, status, depends_on: deps, estimate: "M", capstone: false, ...extra };
};
function differential(name, graph) {
  const py = python(graph);
  if (py.error) { console.log(`[${name}] PYTHON ERROR ${py.error.trim()}`); return; }
  const t = ts(graph);
  const same = t.text === view(py);
  console.log(`[${name}] decision=${t.projection.decision.kind}${t.projection.decision.nextEligible !== undefined ? ":" + t.projection.decision.nextEligible : ""} pySelected=${py.selected} tsSelected=${t.n.selected} match=${same} warnings=${JSON.stringify(py.warnings)}`);
  if (!same) {
    const tj = JSON.parse(t.text), pj = JSON.parse(view(py));
    for (const k of ["gate", "nextUp", "selected", "tuples", "unlocks"]) if (JSON.stringify(tj[k]) !== JSON.stringify(pj[k])) console.log(`   ${k}: TS=${JSON.stringify(tj[k])} PY=${JSON.stringify(pj[k])}`);
    console.log(`   markdown: ${diffLines(tj.markdown, pj.markdown)}`);
  }
  if (t.projection.decision.kind === "invalid") console.log(`   violations=${JSON.stringify(t.projection.decision.violations)}`);
  return t;
}

console.log("== A1 crafted edge graphs (Python vs TS) ==");
// 1a. float-equal fractional priorities: exact decimal says E1-T02 first, float says tie.
differential("float-tie", { name: "float-tie", tasks: [
  task("E1-T01", "pending", [], { priority: "101.10000000000000001", queueJumpReason: "hotfix" }),
  task("E1-T02", "pending", [], { priority: "101.1", queueJumpReason: "hotfix" }),
  task("E1-T03", "pending", [], { capstone: true }),
]});
// 1b. equal priorities, ids differing: E1-T10 vs E1-T09 both 150.
differential("equal-prio", { name: "equal-prio", tasks: [
  task("E1-T09", "pending", [], { priority: "150.5", queueJumpReason: "r" }),
  task("E1-T10", "pending", [], { priority: "150.5", queueJumpReason: "r" }),
  task("E1-T11", "pending", [], { capstone: true }),
]});
// 1c. equal priority across epics where lexical id order != numeric: E10-T01 vs E9-T01.
differential("cross-epic-tie", { name: "cross-epic-tie", tasks: [
  task("E9-T01", "pending", [], { priority: "5000.5", queueJumpReason: "r", capstone: true }),
  task("E10-T01", "pending", [], { priority: "5000.5", queueJumpReason: "r", capstone: true }),
]});
// 1d. fractional with / without reason
differential("frac-no-reason", { name: "frac-no-reason", tasks: [
  task("E1-T01", "pending", [], { priority: "100.5" }),
  task("E1-T02", "pending", [], { capstone: true }),
]});
// 1e. bare-epic deps to epics with zero / one / two capstones
differential("bare-zero-cap", { name: "bare-zero-cap", tasks: [
  task("E1-T01", "verified"), task("E1-T02", "pending"),
  task("E2-T01", "pending", ["E1"]), task("E2-T02", "pending", [], { capstone: true }),
]});
differential("bare-one-cap-verified", { name: "bare-one-cap-verified", tasks: [
  task("E1-T01", "verified"), task("E1-T02", "verified", [], { capstone: true }),
  task("E2-T01", "pending", ["E1"]), task("E2-T02", "pending", [], { capstone: true }),
]});
differential("bare-two-caps", { name: "bare-two-caps", tasks: [
  task("E1-T01", "verified", [], { capstone: true }), task("E1-T02", "verified", [], { capstone: true }),
  task("E2-T01", "pending", ["E1"]), task("E2-T02", "pending", [], { capstone: true }),
]});
// 1f. cycle THROUGH a bare-epic reference: E1-T01 needs E2 (capstone E2-T01), which needs E1-T01.
differential("bare-epic-cycle", { name: "bare-epic-cycle", tasks: [
  task("E1-T01", "pending", ["E2"]), task("E1-T02", "pending", ["E1-T01"], { capstone: true }),
  task("E2-T01", "pending", ["E1-T01"], { capstone: true }),
]});
// 1g. self-epic cycle: capstone of E1 depends (transitively) on E1.
differential("self-epic-cycle", { name: "self-epic-cycle", tasks: [
  task("E1-T01", "pending", ["E1"]), task("E1-T02", "pending", ["E1-T01"], { capstone: true }),
]});
// 1h. unicode + hash titles
differential("unicode-title", { name: "unicode-title", tasks: [
  task("E1-T01", "pending", [], { title: "Répare l’arbre 🌲 — «fôret» électrique" }),
  task("E1-T02", "pending", [], { title: "Fix #12: colon: and hash", capstone: true }),
]});
differential("hash-title", { name: "hash-title", tasks: [
  task("E1-T01", "pending", [], { title: "Fix regression #12 in queue" }),
  task("E1-T02", "pending", [], { capstone: true }),
]});
// 1i. implemented-then-refuted task (refuted with verified deps) → rework
differential("refuted-rework", { name: "refuted-rework", tasks: [
  task("E1-T01", "verified"), task("E1-T02", "refuted", ["E1-T01"]), task("E1-T03", "pending", ["E1-T02"], { capstone: true }),
]});
// 1j. refuted with unverified deps: Python gate vs TS in-flight
differential("refuted-blocked", { name: "refuted-blocked", tasks: [
  task("E1-T01", "pending"), task("E1-T02", "refuted", ["E1-T01"]), task("E1-T03", "pending", ["E1-T02"], { capstone: true }),
]});
// 1k. gate is a capstone: unlocks section semantics
differential("capstone-gate-unlocks", { name: "capstone-gate-unlocks", tasks: [
  task("E1-T01", "verified"), task("E1-T02", "in-progress", ["E1-T01"], { capstone: true }),
  task("E2-T01", "pending", ["E1"]), task("E2-T02", "pending", ["E1-T02"]), task("E2-T03", "pending", ["E1-T02", "E2-T01"], { capstone: true }),
]});
// 1l. in-progress task whose own deps are unverified (a loop mistake)
differential("inprogress-unmet-deps", { name: "inprogress-unmet-deps", tasks: [
  task("E1-T01", "pending"), task("E1-T02", "in-progress", ["E1-T01"]), task("E1-T03", "pending", [], { capstone: true }),
]});
// 1m. verified task depending on a pending one (history inversion)
differential("verified-on-pending", { name: "verified-on-pending", tasks: [
  task("E1-T01", "pending"), task("E1-T02", "verified", ["E1-T01"]), task("E1-T03", "pending", ["E1-T02"], { capstone: true }),
]});
// 1n. eleven eligible + unlocks cap
{
  const tasks = [];
  for (let n = 1; n <= 12; n++) tasks.push(task(`E1-T${String(n).padStart(2, "0")}`, "pending"));
  tasks.push(task("E1-T13", "pending", [], { capstone: true }));
  differential("twelve-eligible", { name: "twelve-eligible", tasks });
}
// 1o. large graph: 40 epics x 25 tasks
{
  const tasks = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ids = [];
  for (let e = 1; e <= 40; e++) for (let n = 1; n <= 25; n++) {
    const id = `E${e}-T${String(n).padStart(2, "0")}`;
    const deps = new Set();
    for (let k = 0; k < 3 && ids.length; k++) { if (rnd() < 0.3 && e > 1) deps.add(`E${1 + Math.floor(rnd() * (e - 1))}`); else deps.add(ids[Math.floor(rnd() * ids.length)]); }
    const status = e <= 10 ? "verified" : "pending";
    tasks.push(task(id, status, [...deps].sort(), { capstone: n === 25 }));
    ids.push(id);
  }
  const t0 = Date.now();
  const t = differential("large-1000", { name: "large-1000", tasks });
  console.log(`   large graph ms=${Date.now() - t0} tasks=${t?.projection.tasks.length}`);
}

console.log("== A1 random graphs, my seeds ==");
let mism = 0, cmp = 0, cycValid = 0;
for (let seed = 5001; seed <= 5120; seed++) {
  for (const cyclic of [false, true]) {
    const g = T.generateQueueGraph(seed, { cyclic });
    const t = ts(g);
    if (t.projection.decision.kind === "invalid") continue;
    if (cyclic) cycValid++;
    const py = python(g);
    cmp++;
    if (py.error || t.text !== view(py)) { mism++; console.log(`  MISMATCH ${g.name} ${py.error ?? diffLines(JSON.parse(t.text).markdown, py.markdown)}`); }
  }
}
console.log(`compared=${cmp} (cyclic-but-valid=${cycValid}) mismatches=${mism}`);

console.log("== A2 stale proof after dependency status moves ==");
{
  const g = { name: "fence", tasks: [task("E1-T01", "implemented"), task("E1-T02", "pending", ["E1-T01"]), task("E1-T03", "pending", ["E1-T02"], { capstone: true })] };
  const sources = T.queueSourcesFromGraph(ORG, REPO, g);
  const proof = T.queueProof(T.projectQueue(sources));
  console.log(`  before: ${JSON.stringify(proof.decision)}`);
  const verifiedG = { ...g, tasks: g.tasks.map((x) => (x.id === "E1-T01" ? { ...x, status: "verified" } : x)) };
  const after = T.queueSourcesFromGraph(ORG, REPO, verifiedG);
  const check = T.checkQueueProof(proof, after);
  console.log(`  old proof vs moved: ${JSON.stringify({ ok: check.ok, reason: check.reason, stale: check.stale })}`);
  console.log(`  admit E1-T02 with old proof: ${JSON.stringify({ ok: T.admitSelection(proof, "E1-T02", after).ok, reason: T.admitSelection(proof, "E1-T02", after).reason })}`);
  const fresh = T.queueProof(T.projectQueue(after));
  console.log(`  fresh: ${JSON.stringify(fresh.decision)} admit E1-T02: ${T.admitSelection(fresh, "E1-T02", after).ok}`);
  // proof citing a queue offset AHEAD of the real head
  const ahead = { ...fresh, queue: { ...fresh.queue, offset: "0000000000000000_0000000000000099" } };
  const c2 = T.checkQueueProof(ahead, after);
  console.log(`  catalog offset ahead: ${JSON.stringify({ ok: c2.ok, reason: c2.reason, stale: c2.stale })}`);
  // forged decision with matching heads
  const forged = { ...fresh, decision: { kind: "eligible", nextEligible: "E1-T03", inFlight: null } };
  console.log(`  forged decision: ${JSON.stringify({ ok: T.checkQueueProof(forged, after).ok, reason: T.checkQueueProof(forged, after).reason })}`);
  const forged2 = { ...fresh, digest: "00".repeat(32) };
  console.log(`  forged digest: ${T.checkQueueProof(forged2, after).reason}`);
  // a proof with an extra head not in current (task stream removed)
  const missingHead = { ...fresh, heads: [...fresh.heads, { stream: "issue:maple/loom/E9-T99", offset: "0000000000000000_0000000000000001" }] };
  console.log(`  cited head absent now: ${JSON.stringify(T.checkQueueProof(missingHead, after).stale)}`);
}

console.log("== A3 two active + two capstones ==");
{
  for (const [name, g] of [
    ["same-epic", { name: "x", tasks: [task("E1-T01", "in-progress", [], { capstone: true }), task("E1-T02", "in-progress", [], { capstone: true })] }],
    ["diff-epic", { name: "x", tasks: [task("E1-T01", "in-progress", [], { capstone: true }), task("E2-T01", "implemented", [], { capstone: true })] }],
    ["two-caps-diff-epic-no-active", { name: "x", tasks: [task("E1-T01", "pending", [], { capstone: true }), task("E2-T01", "pending", [], { capstone: true })] }],
    ["implemented+refuted", { name: "x", tasks: [task("E1-T01", "implemented"), task("E1-T02", "refuted"), task("E1-T03", "pending", [], { capstone: true })] }],
  ]) {
    const p = T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, g));
    const pr = T.queueProof(p);
    console.log(`  ${name}: ${JSON.stringify(p.decision)} finalCapstone=${pr.finalCapstone} admit=${JSON.stringify(T.admitSelection(pr, "E1-T01", T.queueSourcesFromGraph(ORG, REPO, g)).reason)}`);
  }
}

console.log("== Unlisted ==");
{
  // stream status disagrees with body frontmatter: stream must win
  const g = { name: "x", tasks: [task("E1-T01", "pending"), task("E1-T02", "pending", ["E1-T01"], { capstone: true })] };
  const s = T.queueSourcesFromGraph(ORG, REPO, g);
  const forged = { ...s, tasks: s.tasks.map((t) => (t.stream.endsWith("E1-T01") ? { ...t, records: t.records.map((r) => (r.type === "issue.opened" ? { ...r, payload: { ...r.payload, body: r.payload.body.replace("status: pending", "status: verified") } } : r)) } : t)) };
  const p = T.projectQueue(forged);
  console.log(`  body says verified, stream pending → status=${p.tasks[0].status} decision=${JSON.stringify(p.decision)}`);
  // body says cancelled
  const forged2 = { ...s, tasks: s.tasks.map((t) => (t.stream.endsWith("E1-T01") ? { ...t, records: t.records.map((r) => (r.type === "issue.opened" ? { ...r, payload: { ...r.payload, body: r.payload.body.replace("status: pending", "status: cancelled") } } : r)) } : t)) };
  const p2 = T.projectQueue(forged2);
  console.log(`  body says cancelled → status=${p2.tasks[0]?.status} decision=${JSON.stringify(p2.decision)}`);
  // task labelled but never started → member pending
  // id differing only by case in body
  const forged3 = { ...s, tasks: s.tasks.map((t) => (t.stream.endsWith("E1-T01") ? { ...t, records: t.records.map((r) => (r.type === "issue.opened" ? { ...r, payload: { ...r.payload, body: r.payload.body.replace("id: E1-T01", "id: e1-t01") } } : r)) } : t)) };
  console.log(`  lowercase id in body → ${JSON.stringify(T.projectQueue(forged3).decision)}`);
  // catalog lists a stream with no records at all
  const s4 = { ...s, tasks: s.tasks.filter((t) => !t.stream.endsWith("E1-T01")) };
  const p4 = T.projectQueue(s4);
  console.log(`  catalog lists E1-T01 but no records fetched → members=${p4.tasks.map((t) => t.id)} heads=${JSON.stringify(p4.sources.tasks)} decision=${JSON.stringify(p4.decision)}`);
  // duplicate dep ref → what reason?
  const p5 = T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks: [task("E1-T01", "verified"), task("E1-T02", "pending", ["E1-T01", "E1-T01"], { capstone: true })] }));
  console.log(`  duplicate dep ref → ${JSON.stringify(p5.decision)}`);
  // evaluateQueue direct with duplicate id
  const e = T.evaluateQueue([{ id: "E1-T01", epic: 1, priority: "101", title: "a", status: "pending", dependsOn: [], capstone: false, queueJumpReason: false }, { id: "E1-T01", epic: 1, priority: "101", title: "b", status: "pending", dependsOn: [], capstone: false, queueJumpReason: false }]);
  console.log(`  evaluateQueue duplicate id → ${JSON.stringify(e.decision)}`);
  // task depending on itself only via epic: capstone E1-T01 depends on E1
  const p6 = T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks: [task("E1-T01", "pending", ["E1"], { capstone: true })] }));
  console.log(`  capstone depends on its own epic → ${JSON.stringify(p6.decision)} blocked=${JSON.stringify(p6.tasks[0].blocked)}`);
  // all verified in an epic with capstone verified but a NON-capstone still pending after it (capstone not final by status? no: by order) — a later-priority non-capstone
  const p7 = T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks: [task("E1-T01", "verified"), task("E1-T02", "verified", [], { capstone: true }), task("E1-T03", "pending", [], { priority: "102.5", queueJumpReason: "bug found after capstone" })] }));
  console.log(`  queue-jump after verified capstone → ${JSON.stringify(p7.decision)}`);
}
rmSync(scratch, { recursive: true, force: true });
