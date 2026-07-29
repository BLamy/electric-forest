import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, type Module } from "node:vm";

const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
  name: "eforest-namespace",
});
const namespaceRoot = fileURLToPath(new URL("./ns/", import.meta.url));
const modules = new Map<string, SourceTextModule>();

async function load(url: URL): Promise<SourceTextModule> {
  const path = fileURLToPath(url);
  if (!path.startsWith(namespaceRoot) || !path.endsWith(".js")) {
    throw new TypeError(`namespace module outside isolated graph: ${url.href}`);
  }
  const existing = modules.get(url.href);
  if (existing !== undefined) return existing;
  const module = new SourceTextModule(await readFile(url, "utf8"), {
    context,
    identifier: url.href,
  });
  modules.set(url.href, module);
  await module.link(link);
  return module;
}

async function link(specifier: string, referencing: Module): Promise<Module> {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new TypeError(`namespace runtime import denied: ${specifier}`);
  }
  return load(new URL(specifier, referencing.identifier));
}

const entry = new SourceTextModule(
  `
    import * as events from "./ns/events.js";
    import * as reducer from "./ns/reducer.js";

    export function invoke(operation, inputJson) {
      try {
        const input = JSON.parse(inputJson);
        let value;
        if (operation === "isEventType") value = events.isNamespaceEventType(input);
        else if (operation === "isName") value = events.isNamespaceName(input);
        else if (operation === "isDispatchEvent") value = events.isNamespaceDispatchEvent(input);
        else if (operation === "isEvent") value = events.isNamespaceEvent(input);
        else if (operation === "stamp") value = events.stampNamespaceEvent(input.event, input.sub);
        else if (operation === "replay") value = reducer.replayNamespaceStream(input);
        else if (operation === "boundary") {
          let stringCodeGeneration = false;
          let wasmCodeGeneration = false;
          try { Function("return 1")(); stringCodeGeneration = true; } catch {}
          try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); wasmCodeGeneration = true; } catch {}
          value = {
            process: typeof globalThis.process,
            fetch: typeof globalThis.fetch,
            require: typeof globalThis.require,
            stringCodeGeneration,
            wasmCodeGeneration,
          };
        }
        else throw new TypeError("unknown namespace operation");
        return JSON.stringify({ ok: true, value });
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        const message = error instanceof Error ? error.message : "namespace operation failed";
        return JSON.stringify({ ok: false, name, message });
      }
    }
  `,
  {
    context,
    identifier: new URL("./namespace-entry.js", import.meta.url).href,
  },
);
await entry.link(link);
await entry.evaluate();

const invoke = (entry.namespace as unknown as { readonly invoke: unknown }).invoke as (
  operation: string,
  inputJson: string,
) => string;
let pending = "";
for await (const chunk of process.stdin) {
  pending += String(chunk);
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line) as {
      readonly id: number;
      readonly operation: string;
      readonly input: unknown;
    };
    const response = invoke(request.operation, JSON.stringify(request.input));
    const permissions = {
      fsWrite: process.permission.has("fs.write"),
      child: process.permission.has("child"),
      worker: process.permission.has("worker"),
      addons: process.permission.has("addons"),
      inspector: process.permission.has("inspector"),
      wasi: process.permission.has("wasi"),
    };
    process.stdout.write(`${JSON.stringify({ id: request.id, response, permissions })}\n`);
  }
}
