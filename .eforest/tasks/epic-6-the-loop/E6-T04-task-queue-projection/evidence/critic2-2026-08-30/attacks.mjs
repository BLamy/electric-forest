import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = "/Users/blamy/Documents/Codex/electric-forest";
const { canonicalJson } = await import(join(root, "packages/protocol/dist/src/index.js"));
const T = await import(join(root, "packages/tasks/dist/src/index.js"));
const ORG = "maple", REPO = "loom";
const t = (id, status, depends_on = [], extra = {}) => {
  const [epic, n] = id.slice(1).split("-T");
  return { id, epic: Number(epic), priority: String(Number(epic) * 100 + Number(n)), title: `Task ${id} does one thing`, status, depends_on, estimate: "M", capstone: false, ...extra };
};
const proj = (tasks) => T.projectQueue(T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks }));
const show = (label, tasks, orders = 3) => {
  const p = proj(tasks);
  const sources = T.queueSourcesFromGraph(ORG, REPO, { name: "x", tasks });
  const d = T.queueDigest(p);
  for (let s = 1; s <= orders; s++) {
    const q = T.projectQueue(T.permuteSources(sources, s * 31 + 7));
    if (T.queueDigest(q) !== d) throw new Error(`${label}: order-dependent digest`);
  }
  const blocked = Object.fromEntries(p.tasks.map((x) => [x.id, x.blocked.map((b) => `${b.reason}${b.detail ? ":" + b.detail : ""}@${b.ref}`)]));
  console.log(label, JSON.stringify(p.decision), JSON.stringify(blocked));
  return p;
};
console.log("--- P-cycle-2caps");
show("cycle-2caps", [t("E1-T01","pending",["E2"],{capstone:true}), t("E2-T01","pending",["E1-T01"],{capstone:true}), t("E2-T02","pending",[],{capstone:true})]);
console.log("--- P-zero-cap: bare ref to capstone-less epic");
show("zero-cap-deadlock", [t("E1-T01","pending",["E2"],{capstone:true}), t("E2-T01","pending",[],{})]);
show("zero-cap-but-startable", [t("E1-T01","pending",["E2"],{capstone:true}), t("E2-T01","pending",[]), t("E2-T02","pending",[],{capstone:true})]);
show("zero-cap-verified-epic (fixture shape)", [t("E1-T01","pending",["E2"],{capstone:true}), t("E2-T01","verified",[])]);
console.log("--- P-refuted-cap / implemented-cap");
show("cap-refuted-deps-ok", [t("E1-T01","refuted",[],{capstone:true}), t("E2-T01","pending",["E1"],{capstone:true})]);
show("cap-refuted-deps-unmet", [t("E1-T01","refuted",["E3"],{capstone:true}), t("E2-T01","pending",["E1"],{capstone:true}), t("E3-T01","pending",[],{capstone:true})]);
show("cap-implemented", [t("E1-T01","implemented",[],{capstone:true}), t("E2-T01","pending",["E1"],{capstone:true})]);
console.log("--- P-self-epic-noncap");
show("self-epic-noncap", [t("E1-T01","pending",["E1"]), t("E1-T02","pending",[],{capstone:true})]);
show("self-epic-noncap-cap-verified", [t("E1-T01","pending",["E1"]), t("E1-T02","verified",[],{capstone:true})]);
console.log("--- P-latent-deadlock");
show("latent-deadlock-active", [t("E1-T01","in-progress",[],{capstone:true}), t("E2-T01","pending",["E3"]), t("E3-T01","pending",["E2-T01"],{capstone:true})]);
show("latent-deadlock-active-verified", [t("E1-T01","verified",[],{capstone:true}), t("E2-T01","pending",["E3"]), t("E3-T01","pending",["E2-T01"],{capstone:true})]);
show("latent-deadlock-nocycle-active", [t("E1-T01","in-progress",[],{capstone:true}), t("E2-T01","pending",["E3"],{capstone:true}), t("E3-T01","pending",["E2"])]);
show("refuted-unsatisfiable", [t("E1-T01","refuted",["E2"],{capstone:true}), t("E2-T01","pending",["E1"])]);
show("refuted-unsatisfiable-nocap", [t("E1-T01","refuted",["E2"],{capstone:true}), t("E2-T01","verified",[])]);
console.log("--- P-refuted-only");
show("refuted-only", [t("E1-T01","refuted",[],{capstone:true})]);
show("refuted-only-plus-verified", [t("E1-T01","verified"), t("E1-T02","refuted",["E1-T01"],{capstone:true})]);
console.log("--- all verified / exhausted invariants");
show("all-verified-2-epics", [t("E1-T01","verified",[],{capstone:true}), t("E2-T01","verified",["E1"],{capstone:true})]);
show("all-verified-capless-epic", [t("E1-T01","verified",[]), t("E2-T01","verified",["E1-T01"],{capstone:true})]);
console.log("--- misc");
show("deadlock-plus-missing (ordering of reasons)", [t("E1-T01","pending",["E9-T01"],{capstone:true}), t("E2-T01","pending",["E7"],{capstone:true})]);
show("deadlock-only-through-two-capstone-epic", [t("E1-T01","pending",["E2"],{capstone:true}), t("E2-T01","pending",[],{capstone:true}), t("E2-T02","pending",["E1"],{capstone:true})]);
show("epic-ref-to-capstone-and-verified-noncap", [t("E1-T01","verified"), t("E1-T02","pending",[],{capstone:true}), t("E2-T01","pending",["E1","E1-T01"],{capstone:true})]);
show("split-suffix-id", [t("E1-T01","verified"), t("E1-T02","pending",["E1-T01"]), t("E1-T02a","pending",["E1-T02"],{capstone:true})]);
show("cycle-with-active-outside", [t("E1-T01","in-progress",[],{capstone:true}), t("E2-T01","pending",["E2-T02"]), t("E2-T02","pending",["E2-T01"],{capstone:true})]);
// deep chain: recursion depth
for (const n of [1000, 5000, 20000]) {
  const chain = [];
  for (let i = 1; i <= n; i++) chain.push({ ...t(`E1-T${String(i).padStart(2,"0")}`, "pending", i > 1 ? [`E1-T${String(i-1).padStart(2,"0")}`] : []), priority: String(100 + i), capstone: i === n });
  try { const p = proj(chain); console.log(`chain-${n}`, JSON.stringify(p.decision)); }
  catch (e) { console.log(`chain-${n} THREW ${e.constructor.name}: ${String(e.message).slice(0,80)}`); }
}
// self-loop through epic on a 2-capstone epic
show("self-epic-two-caps", [t("E1-T01","pending",["E1"],{capstone:true}), t("E1-T02","pending",[],{capstone:true})]);
