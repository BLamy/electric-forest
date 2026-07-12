import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { replay, stateDigest, type Event } from "@eforest/protocol";
import { fixtureInitialState, fixtureReducer } from "@eforest/protocol/fixtures/reducer";
import { describe, expect, it } from "vitest";
import { createHttpServer } from "./http.js";
import { createDefaultReducerRegistry } from "./redux/reducers.js";
import { MemoryStreamStore } from "./store/memory.js";
import { createDefaultActionValidatorRegistry } from "./validation.js";

interface TestResponse {
  readonly status: number;
  readonly body: string;
}

const evidenceDir = resolve(
  process.cwd(),
  ".eforest/tasks/epic-0-the-seed/E0-T11-validated-dispatch/evidence",
);

async function request(
  base: string,
  path: string,
  init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): Promise<TestResponse> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.text() };
}

async function startServer(): Promise<{
  server: ReturnType<typeof createHttpServer>;
  base: string;
}> {
  const server = createHttpServer(new MemoryStreamStore(), {
    reducerRegistry: createDefaultReducerRegistry(),
    actionValidators: createDefaultActionValidatorRegistry(),
  });
  await new Promise<void>((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolveStop, reject) => {
    server.close((error) => (error ? reject(error) : resolveStop()));
  });
}

function invalidCase(index: number): { readonly body: string; readonly contentType: string } {
  switch (index % 10) {
    case 0:
      return { body: "{", contentType: "application/json" };
    case 1:
      return {
        body: JSON.stringify({ type: "set", ts: index }),
        contentType: "application/json",
      };
    case 2:
      return {
        body: JSON.stringify([{ type: "set", payload: 1, ts: index }]),
        contentType: "application/json",
      };
    case 3:
      return {
        body: JSON.stringify({ type: { nested: true }, payload: 1, ts: index }),
        contentType: "application/json",
      };
    case 4:
      return {
        body: JSON.stringify({ type: "set", payload: 1, ts: index, extra: true }),
        contentType: "application/json",
      };
    case 5:
      return {
        body: JSON.stringify({ type: "unknown/fuzz", payload: true, ts: index }),
        contentType: "application/json",
      };
    case 6:
      return {
        body: `${JSON.stringify({ type: "set", payload: 1, ts: index })},`,
        contentType: "application/json",
      };
    case 7:
      return {
        body: `{"type":"set","payload":{"__proto__":{"polluted":true}},"ts":${index},"marker":true}`,
        contentType: "application/json",
      };
    case 8:
      return {
        body: `{"type":"set","type":"set","payload":1,"ts":${index}}`,
        contentType: "application/json",
      };
    default:
      return {
        body: JSON.stringify({ type: "set", payload: 1, ts: index }),
        contentType: "text/plain",
      };
  }
}

describe("validated dispatch seeded fuzz", () => {
  it("survives 520 malformed and unknown actions with controls only in the log", async () => {
    const seed = 271828;
    const total = 520;
    const controls: Event[] = [];
    const { server, base } = await startServer();
    try {
      const created = await request(base, "/streams/fuzz-dispatch", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "fixture" }),
      });
      expect(created.status).toBe(201);

      for (let index = 0; index < total; index += 1) {
        const isControl = index % 101 === 0;
        const action: Event = { type: "increment", payload: 1, ts: seed + index };
        const candidate = isControl
          ? { body: JSON.stringify(action), contentType: "application/json" }
          : invalidCase(index);
        if (isControl) controls.push(action);
        const response = await request(base, "/streams/fuzz-dispatch/dispatch", {
          method: "POST",
          headers: { "content-type": candidate.contentType },
          body: candidate.body,
        });
        if (isControl) expect(response.status, `fuzz case ${index}`).toBe(201);
        else expect([400, 404, 422], `fuzz case ${index}`).toContain(response.status);
        expect(response.status, `fuzz case ${index} must not be 5xx`).toBeLessThan(500);
      }

      expect(Object.prototype).not.toHaveProperty("polluted");
      const dump = await request(base, "/streams/fuzz-dispatch/dump", { method: "GET" });
      expect(dump.status).toBe(200);
      const records = dump.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<Event & { offset: string }>;
      expect(records).toHaveLength(controls.length);
      expect(records.map(({ type, payload, ts }) => ({ type, payload, ts }))).toEqual(controls);
      const digest = stateDigest(replay(records, fixtureReducer, fixtureInitialState));
      const stillAlive = await request(base, "/streams/fuzz-dispatch/state", { method: "GET" });
      expect(stillAlive.status).toBe(200);

      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        resolve(evidenceDir, "e0-t11-fuzz.txt"),
        [
          `seed=${seed}`,
          `cases=${total}`,
          `controls=${controls.length}`,
          `post-fuzz-state-digest=${digest}`,
          `records=${records.length}`,
          "object-prototype-polluted=false",
        ].join("\n") + "\n",
      );
    } finally {
      await stopServer(server);
    }
  }, 60_000);
});
