import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, replay, stateDigest } from "../../../packages/protocol/dist/src/index.js";
import { fixtureInitialState, fixtureReducer } from "../../../packages/protocol/dist/fixtures/reducer.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = arg("base-url");
const streamId = arg("stream");
const actionsPath = arg("actions");
const dumpPath = arg("dump");
const refusalPath = arg("refusal");
const delayMs = Number(arg("delay-ms", "50"));
if (!baseUrl || !streamId || !actionsPath || !dumpPath || !refusalPath) {
  throw new Error("terminal_a requires --base-url, --stream, --actions, --dump, and --refusal");
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const request = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { status: response.status, body: await response.text() };
};
const path = `/streams/${encodeURIComponent(streamId)}`;

const created = await request(path, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ streamId, type: "fixture" }),
});
if (created.status !== 201 && created.status !== 200) {
  throw new Error(`stream create failed: ${created.status} ${created.body}`);
}

const actions = readFileSync(actionsPath, "utf8")
  .trimEnd()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const refusals = [];
for (const action of actions) {
  const response = await request(`${path}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  if (action.type === "capstone/invalid") {
    if (response.status !== 404) {
      throw new Error(`invalid dispatch returned ${response.status}: ${response.body}`);
    }
    refusals.push({ action, body: JSON.parse(response.body), status: response.status });
  } else if (response.status !== 201) {
    throw new Error(`valid dispatch returned ${response.status}: ${response.body}`);
  }
  await sleep(delayMs);
}

const dumpResponse = await request(`${path}/dump`);
if (dumpResponse.status !== 200) throw new Error(`dump failed: ${dumpResponse.status}`);
const dump = dumpResponse.body.length === 0 ? [] : dumpResponse.body.trimEnd().split("\n");
if (dump.length !== 5 || dump.some((line) => line.includes("capstone/invalid"))) {
  throw new Error(`dispatch dump contains the wrong events: ${dump.length}`);
}
writeFileSync(dumpPath, dump.length === 0 ? "" : `${dump.join("\n")}\n`);
writeFileSync(refusalPath, `${refusals.map((value) => `${canonicalJson(value)}\n`).join("")}`);
const events = dump.map((line) => {
  const { offset: _offset, ...event } = JSON.parse(line);
  return event;
});
const digest = stateDigest(replay(events, fixtureReducer, fixtureInitialState));
process.stdout.write(`A PID: ${process.pid}\n`);
process.stdout.write(`A valid events: ${dump.length}\n`);
process.stdout.write(`A refusals: ${refusals.length}\n`);
process.stdout.write(`A digest: ${digest}\n`);
