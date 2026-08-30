import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = "/Users/blamy/Documents/Codex/electric-forest";
const work = join(root, ".eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/work/critic2");
const T = await import(join(root, "packages/tasks/dist/src/index.js"));
const ORG = "maple", REPO = "loom";
const t = (id, status, depends_on = [], extra = {}) => { const [e, n] = id.slice(1).split("-T"); return { id, epic: +e, priority: String(+e * 100 + +n), title: `Task ${id} does one thing`, status, depends_on, estimate: "M", capstone: false, ...extra }; };
const proj = (tasks) => T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks }));
for (const n of [1000, 2000, 3000, 5000]) {
  // reverse chain DAG: E1 depends on E2 depends on E3 ... (deep recursion in queue order)
  const chain = []; for (let i = 1; i <= n; i++) chain.push(t(`E${i}-T01`, "pending", i < n ? [`E${i+1}`] : [], { capstone: true }));
  try { const p = proj(chain); console.log(`reverse-dag-${n}`, JSON.stringify(p.decision).slice(0,80)); } catch (e) { console.log(`reverse-dag-${n} THREW ${e.constructor.name}`); }
}
const python = (graph, tree) => { rmSync(tree, { recursive: true, force: true }); for (const task of graph.tasks) { const f = join(tree, `epic-${task.epic}`, task.id); mkdirSync(f, { recursive: true }); writeFileSync(join(f, "readme.md"), T.graphReadme(task)); } const r = spawnSync("python3", [join(root, "tools/verify/queue_differential.py"), "--tree", tree], { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(r.stdout); };
const view = (v) => JSON.stringify({ gate: v.gate, nextUp: v.nextUp, selected: v.selected, tuples: v.tuples, unlocks: v.unlocks, markdown: v.markdown });
function big(seed, epics = 40, per = 25) {
  let s = seed >>> 0; const random = () => { s = (s + 0x6D2B79F5) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 15), z | 1); z ^= z + Math.imul(z ^ (z >>> 7), z | 61); return ((z ^ (z >>> 14)) >>> 0) / 4294967296; };
  const tasks = [], ids = []; const frontierEpics = Math.floor(random() * epics); let frontier = true;
  for (let e = 1; e <= epics; e++) for (let n = 1; n <= per; n++) {
    const id = `E${e}-T${String(n).padStart(2,"0")}`; const deps = new Set(); const k = Math.floor(random() * 4);
    for (let i = 0; i < k && ids.length; i++) { if (random() < 0.4 && e > 1) deps.add(`E${1 + Math.floor(random() * (e - 1))}`); else deps.add(ids[Math.floor(random() * ids.length)]); }
    let status; if (e <= frontierEpics) status = "verified"; else if (frontier && random() < 0.5) status = "verified"; else { frontier = false; status = "pending"; }
    tasks.push(t(id, status, [...deps].sort(), { capstone: n === per })); ids.push(id);
  }
  return { name: `bigE-${seed}`, tasks };
}
let mm = 0;
for (const seed of [8001, 8002, 8003, 8004]) {
  const g = big(seed); const p = proj(g.tasks);
  if (p.decision.kind === "invalid") { console.log(g.name, "invalid", JSON.stringify(p.decision.violations).slice(0,200)); continue; }
  const live = python(g, join(work, "py", g.name));
  const ts = view({ ...T.normalizeQueueDecision(p), markdown: T.renderQueueMarkdown(p, T.BUILD_QUEUE_GENERATOR_LINE) });
  const same = ts === view(live); if (!same) mm++;
  console.log(g.name, same ? "ok" : "MISMATCH", JSON.stringify(p.decision), "nextUp", T.normalizeQueueDecision(p).nextUp.length, "py", live.nextUp.length);
}
console.log("BIG-eligible mismatches", mm);
