import { replay, stateDigest, type Event } from "@eforest/protocol";
import { fixtureInitialState, fixtureReducer } from "@eforest/protocol/fixtures/reducer";
import { startServer, type RunningServer } from "./harness.js";

interface Options {
  readonly seed: number;
  readonly iterations: number;
}

interface ResponseSnapshot {
  readonly status: number;
  readonly body: string;
}

function options(args: readonly string[]): Options {
  const seedIndex = args.indexOf("--seed");
  const iterationsIndex = args.indexOf("--iterations");
  const seed = seedIndex >= 0 ? Number(args[seedIndex + 1]) : 20260712;
  const iterations = iterationsIndex >= 0 ? Number(args[iterationsIndex + 1]) : 256;
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("usage: fuzz --seed <integer> [--iterations <positive integer>]");
  }
  return { seed, iterations };
}

function next(state: { value: number }): number {
  state.value = (state.value * 1664525 + 1013904223) >>> 0;
  return state.value;
}

function digestFromDump(body: string): string {
  const value = JSON.parse(body) as readonly (Event & { readonly offset: string })[];
  return stateDigest(
    replay(
      value.map(({ type, payload, ts }) => ({ type, payload, ts })),
      fixtureReducer,
      fixtureInitialState,
    ),
  );
}

async function dump(
  server: RunningServer,
  stream: string,
): Promise<{ body: string; digest: string }> {
  const response = await fetch(`${server.baseUrl}/streams/${stream}?offset=-1`);
  const body = await response.text();
  if (response.status !== 200) throw new Error(`dump returned ${response.status}`);
  return { body, digest: digestFromDump(body) };
}

async function request(
  server: RunningServer,
  stream: string,
  choice: number,
  index: number,
): Promise<ResponseSnapshot> {
  let response: Response;
  if (choice === 0) {
    response = await fetch(`${server.baseUrl}/streams/${stream}?offset=-2`);
  } else if (choice === 1) {
    response = await fetch(`${server.baseUrl}/streams/${stream}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "0" },
      body: "{",
    });
  } else if (choice === 2) {
    response = await fetch(`${server.baseUrl}/streams/${stream}`, {
      method: "POST",
      headers: { "content-type": "text/plain", "stream-seq": "0" },
      body: "not-json",
    });
  } else if (choice === 3) {
    response = await fetch(`${server.baseUrl}/streams/${stream}`, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": "0" },
      body: JSON.stringify({ events: [{ type: "push", payload: index, ts: index }] }),
    });
  } else {
    response = await fetch(`${server.baseUrl}/streams/${stream}?offset=not-an-offset`);
  }
  return { status: response.status, body: await response.text() };
}

async function run(config: Options): Promise<void> {
  const servers = await Promise.all(
    (["memory", "file"] as const).map(async (variant) => ({
      variant,
      server: await startServer(variant),
    })),
  );
  const random = { value: config.seed >>> 0 };
  const stream = `fuzz-${config.seed}`;
  try {
    for (const { variant, server } of servers) {
      const created = await fetch(`${server.baseUrl}/streams/${stream}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fuzz: true }),
      });
      if (created.status !== 201)
        throw new Error(`${variant} setup create returned ${created.status}`);
    }
    for (let index = 0; index < config.iterations; index += 1) {
      const choice = next(random) % 5;
      const before = await Promise.all(servers.map(({ server }) => dump(server, stream)));
      const responses = await Promise.all(
        servers.map(({ server }) => request(server, stream, choice, index)),
      );
      if (
        responses[0]?.status !== responses[1]?.status ||
        responses[0]?.body !== responses[1]?.body
      ) {
        throw new Error(
          `seed ${config.seed} iteration ${index} store response divergence: ${JSON.stringify(responses)}`,
        );
      }
      const after = await Promise.all(servers.map(({ server }) => dump(server, stream)));
      if (responses[0] !== undefined && responses[0].status >= 400) {
        for (let variantIndex = 0; variantIndex < servers.length; variantIndex += 1) {
          if (before[variantIndex]?.digest !== after[variantIndex]?.digest) {
            throw new Error(
              `seed ${config.seed} iteration ${index} refused request mutated ${servers[variantIndex]?.variant} digest`,
            );
          }
        }
      }
    }
  } catch (error) {
    throw new Error(
      `fuzz seed ${config.seed} iteration failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await Promise.all(servers.map(({ server }) => server.stop()));
  }
}

const config = options(process.argv.slice(2));
console.log(`fuzz seed=${config.seed} iterations=${config.iterations}`);
await run(config);
console.log("fuzz: both-store responses and refused-request digests passed");
