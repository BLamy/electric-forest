#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";

assert.equal(process.argv.length, 3, "usage: node e2_t06_restart_server.mjs <data-dir>");
const dataDir = resolve(process.argv[2]);
const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
const url = await server.start();
process.stdout.write(`E2_T06_READY ${JSON.stringify({ url })}\n`);
