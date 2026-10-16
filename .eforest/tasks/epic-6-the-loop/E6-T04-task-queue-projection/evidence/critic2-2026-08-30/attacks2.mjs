import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = "/Users/blamy/Documents/Codex/electric-forest";
const work = join(root, ".eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/work/critic2");
const { canonicalJson } = await import(join(root, "packages/protocol/dist/src/index.js"));
const T = await import(join(root, "packages/tasks/dist/src/index.js"));
const ORG = "maple", REPO = "loom";
const t = (id, status, depends_on = [], extra = {}) => {
  const [epic, n] = id.slice(1).split("-T");
  return { id, epic: Number(epic), priority: String(Number(epic) * 100 + Number(n)), title: `Task ${id} does one thing`, status, depends_on, estimate: "M", capstone: false, ...extra };
};
const proj = (tasks) => T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks }));
// 1. depth
for (const n of [1000, 5000, 20000]) {
  const chain = [];
  for (let i = 1; i <= n; i++) chain.push(t(`E${i}-T01`, "pending", i > 1 ? [`E${i-1}`] : [], { capstone: true }));
  const t0 = Date.now();
  try { const p = proj(chain); console.log(`chain-epics-${n}`, JSON.stringify(p.decision).slice(0,120), `${Date.now()-t0}ms`); }
  catch (e) { console.log(`chain-epics-${n} THREW ${e.constructor.name}: ${String(e.message).slice(0,80)}`); }
  // cyclic deep chain: last depends on first via epic ref
  const cyc = chain.map((x, i) => i === 0 ? { ...x, depends_on: [`E${n}`] } : x);
  try { const p = proj(cyc); console.log(`chain-epics-cyclic-${n}`, JSON.stringify(p.decision).slice(0,100)); }
  catch (e) { console.log(`chain-epics-cyclic-${n} THREW ${e.constructor.name}: ${String(e.message).slice(0,80)}`); }
}
// 2. 1000-task random graphs vs Python
const python = (graph, tree) => {
  rmSync(tree, { recursive: true, force: true });
  for (const task of graph.tasks) {
    const folder = join(tree, `epic-${task.epic}`, task.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "readme.md"), T.graphReadme(task));
  }
  const r = spawnSync("python3", [join(root, "tools/verify/queue_differential.py"), "--tree", tree], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};
const view = (v) => JSON.stringify({ gate: v.gate, nextUp: v.nextUp, selected: v.selected, tuples: v.tuples, unlocks: v.unlocks, markdown: v.markdown });
function big(seed, epics = 40, per = 25) {
  const rnd = T.seededRandom ? T.seededRandom(seed) : null;
  let s = seed >>> 0; const random = () => { s = (s + 0x6D2B79F5) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 15), z | 1); z ^= z + Math.imul(z ^ (z >>> 7), z | 61); return ((z ^ (z >>> 14)) >>> 0) / 4294967296; };
  const tasks = []; const ids = [];
  const frontierEpics = Math.floor(random() * epics); // epics fully verified
  let active = false; let frontier = true;
  for (let e = 1; e <= epics; e++) for (let n = 1; n <= per; n++) {
    const id = `E${e}-T${String(n).padStart(2,"0")}`;
    const deps = new Set();
    const k = Math.floor(random() * 4);
    for (let i = 0; i < k && ids.length; i++) {
      if (random() < 0.4 && e > 1) deps.add(`E${1 + Math.floor(random() * (e - 1))}`);
      else deps.add(ids[Math.floor(random() * ids.length)]);
    }
    let status;
    if (e <= frontierEpics) status = "verified";
    else if (frontier && random() < 0.5) status = "verified";
    else { frontier = false; if (!active && random() < 0.02) { active = true; status = ["in-progress","implemented","refuted"][Math.floor(random()*3)]; } else status = "pending"; }
    const frac = random() < 0.05;
    tasks.push({ ...t(id, status, [...deps].sort(), { capstone: n === per }), priority: frac ? `${e*100+n}.${1+Math.floor(random()*9)}` : `${e*100+n}`, ...(frac ? { queueJumpReason: `hotfix ${id}` } : {}) });
    ids.push(id);
  }
  return { name: `big-${seed}`, tasks };
}
let mismatches = 0, compared = 0, kinds = {};
for (const seed of [7001, 7002, 7003, 7004, 7005, 7006]) {
  const g = big(seed);
  const p = proj(g.tasks);
  kinds[p.decision.kind] = (kinds[p.decision.kind] || 0) + 1;
  if (p.decision.kind === "invalid") { console.log(g.name, "invalid", JSON.stringify(p.decision.violations).slice(0,200)); continue; }
  const t0 = Date.now();
  const live = python(g, join(work, "py", g.name));
  const ts = view({ ...T.normalizeQueueDecision(p), markdown: T.renderQueueMarkdown(p, T.BUILD_QUEUE_GENERATOR_LINE) });
  const py = view(live);
  compared++;
  if (ts !== py) { mismatches++; console.log(g.name, "MISMATCH", JSON.stringify(T.normalizeQueueDecision(p)).slice(0,300), "\nPY", JSON.stringify(live).slice(0,300)); }
  else console.log(g.name, `ok tasks=${p.tasks.length} decision=${JSON.stringify(p.decision)} bare-epic-deps=${g.tasks.filter(x=>x.depends_on.some(d=>/^E\d+$/.test(d))).length} warnings=${live.warnings.length} ${Date.now()-t0}ms`);
}
console.log(`BIG compared=${compared} mismatches=${mismatches} kinds=${JSON.stringify(kinds)}`);
