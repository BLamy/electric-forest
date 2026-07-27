#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanCredentialLeaks } from "../../packages/browser-verify/dist/src/index.js";

const marker = "e3-t02-wire-secret-marker";
const base = {
  layer: "browser",
  url: "http://127.0.0.1/",
  headers: [],
  bodyBase64: null,
};
const mutations = [
  [
    "url-query",
    { ...base, direction: "request", method: "GET", url: `${base.url}?leak=${marker}` },
  ],
  [
    "request-header",
    { ...base, direction: "request", method: "GET", headers: [["x-proof-leak", marker]] },
  ],
  [
    "request-body",
    {
      ...base,
      direction: "request",
      method: "POST",
      bodyBase64: Buffer.from(marker).toString("base64"),
    },
  ],
  [
    "response-header",
    { ...base, direction: "response", status: 200, headers: [["x-proof-leak", marker]] },
  ],
  [
    "response-body",
    {
      ...base,
      direction: "response",
      status: 200,
      bodyBase64: Buffer.from(marker).toString("base64"),
    },
  ],
  [
    "non-http-only-session-cookie",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [["set-cookie", `ef_session=${marker}.signature; Path=/; SameSite=Lax`]],
    },
  ],
];

let transcript = "# E3-T02 full-wire sensitivity\n\n";
for (const [name, observation] of mutations) {
  assert.throws(
    () => scanCredentialLeaks([observation], { secretLiterals: [marker] }),
    /secret literal|ef_session cookie is not narrowly HttpOnly/,
    name,
  );
  transcript += `EXPECTED_RED ${name}\n`;
}
const allowed = [
  {
    ...base,
    direction: "request",
    method: "GET",
    headers: [["cookie", `ef_session=${marker}.signature`]],
  },
  {
    ...base,
    direction: "response",
    status: 302,
    headers: [
      ["set-cookie", `ef_session=${marker}.signature; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`],
    ],
  },
];
scanCredentialLeaks(allowed, { secretLiterals: [marker, `${marker}.signature`] });
transcript += "CONTROL_GREEN exact Cookie/Set-Cookie HttpOnly exception\n";
transcript += `E3_T02_WIRE_SENSITIVITY_OK mutations=${String(mutations.length)}\n`;
const path = resolve(
  ".eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/evidence/e3-t02-wire-sensitivity.txt",
);
await mkdir(resolve(path, ".."), { recursive: true });
await writeFile(path, transcript);
process.stdout.write(transcript);
