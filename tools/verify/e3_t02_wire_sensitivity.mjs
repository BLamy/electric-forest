#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanCredentialLeaks } from "../../packages/browser-verify/dist/src/index.js";

const marker = "e3-t02-wire-secret-marker";
const cleanSession = "allowed-session.signature";
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
    "fixture-password-request-body",
    {
      ...base,
      direction: "request",
      method: "POST",
      url: `${base.url}__fixture/authorize`,
      bodyBase64: Buffer.from(`password=${marker}`).toString("base64"),
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
  [
    "set-cookie-path-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [
        ["set-cookie", `ef_session=${cleanSession}; Path=/${marker}; HttpOnly; SameSite=Lax`],
      ],
    },
  ],
  [
    "set-cookie-domain-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [
        [
          "set-cookie",
          `ef_session=${cleanSession}; Domain=${marker}.test; Path=/; HttpOnly; SameSite=Lax`,
        ],
      ],
    },
  ],
  [
    "set-cookie-samesite-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [["set-cookie", `ef_session=${cleanSession}; Path=/; HttpOnly; SameSite=${marker}`]],
    },
  ],
  [
    "set-cookie-expires-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [
        ["set-cookie", `ef_session=${cleanSession}; Path=/; HttpOnly; Expires=Wed, ${marker} GMT`],
      ],
    },
  ],
  [
    "set-cookie-max-age-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [["set-cookie", `ef_session=${cleanSession}; Path=/; HttpOnly; Max-Age=${marker}`]],
    },
  ],
  [
    "set-cookie-extension-name-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [["set-cookie", `ef_session=${cleanSession}; Path=/; HttpOnly; x-${marker}=clean`]],
    },
  ],
  [
    "set-cookie-extension-value-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [["set-cookie", `ef_session=${cleanSession}; Path=/; HttpOnly; Priority=${marker}`]],
    },
  ],
  [
    "request-other-cookie-name-secret",
    {
      ...base,
      direction: "request",
      method: "GET",
      headers: [["cookie", `ef_session=${cleanSession}; ${marker}=clean`]],
    },
  ],
  [
    "request-other-cookie-value-secret",
    {
      ...base,
      direction: "request",
      method: "GET",
      headers: [["cookie", `ef_session=${cleanSession}; proof=${marker}`]],
    },
  ],
  [
    "combined-set-cookie-other-cookie-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [
        [
          "set-cookie",
          `ef_session=${cleanSession}; Path=/; HttpOnly; SameSite=Lax, proof=${marker}; Path=/`,
        ],
      ],
    },
  ],
  [
    "malformed-cookie-secret",
    {
      ...base,
      direction: "request",
      method: "GET",
      headers: [["cookie", `ef_session=${cleanSession}; malformed-${marker}`]],
    },
  ],
  [
    "malformed-set-cookie-secret",
    {
      ...base,
      direction: "response",
      status: 200,
      headers: [
        ["set-cookie", `ef_session=${cleanSession}; Path=/;; HttpOnly; Priority=${marker}`],
      ],
    },
  ],
  [
    "duplicate-session-cookie-boundary",
    {
      ...base,
      direction: "request",
      method: "GET",
      headers: [["cookie", `ef_session=${cleanSession}; ef_session=${marker}.signature`]],
    },
  ],
  [
    "request-multi-header-duplicate-session",
    {
      ...base,
      direction: "request",
      method: "GET",
      headers: [
        ["cookie", `ef_session=${cleanSession}`],
        ["cookie", `ef_session=${marker}.signature`],
      ],
    },
  ],
  [
    "response-multi-header-duplicate-session",
    {
      ...base,
      direction: "response",
      status: 302,
      headers: [
        ["set-cookie", `ef_session=${cleanSession}; Path=/; HttpOnly; SameSite=Lax`],
        ["set-cookie", `ef_session=${marker}.signature; Path=/; HttpOnly; SameSite=Lax`],
      ],
    },
  ],
  [
    "mixed-case-combined-cross-field-session-boundary",
    {
      ...base,
      direction: "response",
      status: 302,
      headers: [
        [
          "Set-Cookie",
          `canopy=green; Expires=Wed, 09 Jun 2027 10:18:14 GMT, ef_session=${cleanSession}; Path=/; HttpOnly`,
        ],
        ["sEt-CoOkIe", `ef_session=${marker}.signature; Path=/; HttpOnly`],
      ],
    },
  ],
];

let transcript = "# E3-T02 full-wire sensitivity\n\n";
for (const [name, observation] of mutations) {
  assert.throws(
    () => scanCredentialLeaks([observation], { secretLiterals: [marker] }),
    /secret literal|ef_session cookie|malformed/,
    name,
  );
  transcript += `EXPECTED_RED ${name}\n`;
}
const formHeaders = [["content-type", "application/x-www-form-urlencoded; charset=utf-8"]];
const encodedMutations = [
  [
    "encoded-password-url",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=AdaShell1234%21`,
      },
      secrets: ["AdaShell1234!"],
    },
  ],
  [
    "encoded-password-form",
    {
      observation: {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from("proof=AdaShell1234%21").toString("base64"),
      },
      secrets: ["AdaShell1234!"],
    },
  ],
  [
    "encoded-code-verifier-form-name",
    {
      observation: {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from("code%5Fverifier=critic-value").toString("base64"),
      },
      secrets: [],
    },
  ],
  [
    "encoded-jwt-url-separators",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?token=eyJabcdefghijk%2Eabcdefghijk%2Eabcdefghijk`,
      },
      secrets: [],
    },
  ],
  [
    "malformed-url-percent-encoding",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=%2`,
      },
      secrets: [],
    },
  ],
  [
    "malformed-form-percent-encoding",
    {
      observation: {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from("proof=%GG").toString("base64"),
      },
      secrets: [],
    },
  ],
  [
    "double-encoded-password-url",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=AdaShell1234%2521`,
      },
      secrets: ["AdaShell1234!"],
    },
  ],
  [
    "recursive-percent-encoding-abuse",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=AdaShell1234%252521`,
      },
      secrets: [],
    },
  ],
  [
    "overlong-percent-decode-component",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=${"a".repeat(8193)}`,
      },
      secrets: [],
    },
  ],
  [
    "percent-decode-bomb",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=${"%41".repeat(8193)}`,
      },
      secrets: [],
    },
  ],
  [
    "form-plus-to-space-secret",
    {
      observation: {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from("proof=Ada+Shell").toString("base64"),
      },
      secrets: ["Ada Shell"],
    },
  ],
  [
    "form-encoded-plus-secret",
    {
      observation: {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from("proof=Ada%2BShell").toString("base64"),
      },
      secrets: ["Ada+Shell"],
    },
  ],
  [
    "encoded-secret-header-value",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["x-canopy-proof", "AdaShell1234%21"]],
      },
      secrets: ["AdaShell1234!"],
    },
  ],
];
for (const [name, { observation, secrets }] of encodedMutations) {
  assert.throws(
    () => scanCredentialLeaks([observation], { secretLiterals: secrets }),
    /JWT|code_verifier|secret literal|percent encoding/,
    name,
  );
  transcript += `EXPECTED_RED ${name}\n`;
}
const allowed = [
  {
    ...base,
    direction: "request",
    method: "GET",
    headers: [["cookie", `canopy=green; ef_session=${marker}.signature; theme=light`]],
  },
  {
    ...base,
    direction: "response",
    status: 302,
    headers: [
      [
        "set-cookie",
        [
          `ef_session=${marker}.signature`,
          "Path=/",
          "Domain=localhost",
          "HttpOnly",
          "SameSite=Lax",
          "Expires=Wed, 09 Jun 2027 10:18:14 GMT",
          "Max-Age=60",
          "Priority=High, canopy=green",
          "Path=/",
        ].join("; "),
      ],
    ],
  },
  {
    ...base,
    direction: "request",
    method: "POST",
    url: `${base.url}?label=canopy%20green&symbol=%2B`,
    headers: [...formHeaders, ["x-canopy-proof", "canopy%20green"]],
    bodyBase64: Buffer.from("note=canopy+green&symbol=%2B").toString("base64"),
  },
];
scanCredentialLeaks(allowed, { secretLiterals: [marker, `${marker}.signature`] });
transcript +=
  "CONTROL_GREEN exact Cookie/Set-Cookie HttpOnly exception with scanned attributes and other cookies\n";
transcript += "CONTROL_GREEN bounded percent-encoded URL/form/header nonsecrets\n";
transcript += `E3_T02_WIRE_SENSITIVITY_OK mutations=${String(mutations.length + encodedMutations.length)}\n`;
const path = resolve(
  ".eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/evidence/e3-t02-wire-sensitivity.txt",
);
await mkdir(resolve(path, ".."), { recursive: true });
await writeFile(path, transcript);
process.stdout.write(transcript);
