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
  [
    "hidden-malformed-url-final-pass",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=%2525GG`,
      },
      secrets: [],
    },
  ],
  [
    "hidden-malformed-form-final-pass",
    {
      observation: {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from("proof=%2525GG").toString("base64"),
      },
      secrets: [],
    },
  ],
  [
    "hidden-malformed-header-final-pass",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["x-canopy-proof", "%2525GG"]],
      },
      secrets: [],
    },
  ],
  [
    "decoded-nul-url",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=AdaShell1234%00%21`,
      },
      secrets: ["AdaShell1234!"],
    },
  ],
  [
    "double-encoded-nul-url",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=AdaShell1234%2500%21`,
      },
      secrets: ["AdaShell1234!"],
    },
  ],
  [
    "decoded-unit-separator-url",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=AdaShell1234%1F%21`,
      },
      secrets: ["AdaShell1234!"],
    },
  ],
  [
    "invented-double-encoded-del-form-name",
    {
      observation: {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from("proof%257F=clean").toString("base64"),
      },
      secrets: [],
    },
  ],
  [
    "raw-code-verifier-header-name",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["code_verifier", "clean"]],
      },
      secrets: [],
    },
  ],
  [
    "case-varied-code-verifier-header-name",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["Code_Verifier", "clean"]],
      },
      secrets: [],
    },
  ],
  [
    "encoded-code-verifier-header-name",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["code%5Fverifier", "clean"]],
      },
      secrets: [],
    },
  ],
  [
    "protected-literal-header-name",
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["adashell1234!", "clean"]],
      },
      secrets: ["adashell1234!"],
    },
  ],
  ...["G_", "G-", "_G", "G"].map((suffix) => [
    `terminal-percent-${suffix.replaceAll("_", "underscore").replaceAll("-", "dash")}-url`,
    {
      observation: {
        ...base,
        direction: "request",
        method: "GET",
        url: `${base.url}?proof=%2525${suffix}`,
      },
      secrets: [],
    },
  ]),
];
for (const [name, { observation, secrets }] of encodedMutations) {
  assert.throws(
    () => scanCredentialLeaks([observation], { secretLiterals: secrets }),
    /JWT|code_verifier|secret literal|percent encoding/,
    name,
  );
  transcript += `EXPECTED_RED ${name}\n`;
}

function componentObservations(serialized) {
  return [
    [
      "url-name",
      { ...base, direction: "request", method: "GET", url: `${base.url}?${serialized}=clean` },
    ],
    [
      "url-value",
      { ...base, direction: "request", method: "GET", url: `${base.url}?proof=${serialized}` },
    ],
    [
      "form-name",
      {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from(`${serialized}=clean`).toString("base64"),
      },
    ],
    [
      "form-value",
      {
        ...base,
        direction: "request",
        method: "POST",
        headers: formHeaders,
        bodyBase64: Buffer.from(`proof=${serialized}`).toString("base64"),
      },
    ],
    [
      "header-name",
      { ...base, direction: "request", method: "GET", headers: [[serialized, "clean"]] },
    ],
    [
      "header-value",
      { ...base, direction: "request", method: "GET", headers: [["x-proof", serialized]] },
    ],
    [
      "cookie-name",
      {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["cookie", `canopy=clean; ${serialized}=clean`]],
      },
    ],
    [
      "cookie-value",
      {
        ...base,
        direction: "request",
        method: "GET",
        headers: [["cookie", `canopy=clean; proof=${serialized}`]],
      },
    ],
    [
      "set-cookie-name",
      {
        ...base,
        direction: "response",
        status: 200,
        headers: [["set-cookie", `${serialized}=clean; Path=/; HttpOnly`]],
      },
    ],
    [
      "set-cookie-value",
      {
        ...base,
        direction: "response",
        status: 200,
        headers: [["set-cookie", `canopy=${serialized}; Path=/; HttpOnly`]],
      },
    ],
    [
      "set-cookie-attribute-name",
      {
        ...base,
        direction: "response",
        status: 200,
        headers: [["set-cookie", `canopy=clean; Path=/; ${serialized}=clean`]],
      },
    ],
    [
      "set-cookie-attribute-value",
      {
        ...base,
        direction: "response",
        status: 200,
        headers: [["set-cookie", `canopy=clean; Path=/; Proof=${serialized}`]],
      },
    ],
  ];
}

function pathObservation(serialized, absolute = true) {
  assert.ok(serialized.startsWith("/"), "path probe must begin with /");
  return {
    ...base,
    direction: "request",
    method: "GET",
    url: absolute ? `${base.url.slice(0, -1)}${serialized}` : serialized,
  };
}

function authorityObservation(channel, serialized) {
  const targets = {
    "absolute-userinfo": `http://${serialized}@example.com/clean`,
    "absolute-host": `http://${serialized}.test/clean`,
    "absolute-port": `http://example.com:${serialized}/clean`,
    "scheme-relative-userinfo": `//${serialized}@example.com/clean`,
    "scheme-relative-host": `//${serialized}.test/clean`,
    "scheme-relative-port": `//example.com:${serialized}/clean`,
    "authority-host": `${serialized}.test:443`,
    "authority-port": `example.com:${serialized}`,
    // Run-13 refutation: a bracketed host whose serialized suffix is neither a
    // `:port` nor empty. These bytes were discarded before inspection.
    "absolute-bracket-suffix": `http://[::1]x${serialized}/clean`,
    "scheme-relative-bracket-suffix": `//[::1]x${serialized}/clean`,
    "authority-bracket-suffix": `[::1]x${serialized}`,
    "absolute-bracket-suffix-after-userinfo": `http://user@[::1]x${serialized}/clean`,
  };
  const url = targets[channel];
  assert.ok(url, `unknown authority channel ${channel}`);
  return {
    ...base,
    direction: "request",
    method: channel.startsWith("authority-") ? "CONNECT" : "GET",
    url,
  };
}

const exactAuthorityAttacks = [
  ["absolute-userinfo", "http://%63ritic@example.com/clean", "GET"],
  ["scheme-relative-userinfo", "//%63ritic@example.com/clean", "GET"],
  ["absolute-host-after-userinfo", "http://example.com@%63ritic.test/clean", "GET"],
  ["scheme-relative-host-default-path", "//%63ritic.test", "GET"],
  // The exact run-13 counterexamples. The bracket branch computed the suffix as
  // `remainder` and returned only the bracket contents plus an optional
  // colon-prefixed port, discarding every other serialized byte.
  ["bracket-suffix-absolute-direct", "http://[::1]x%63ritic/clean", "GET"],
  ["bracket-suffix-scheme-relative-direct", "//[::1]x%63ritic/clean", "GET"],
  ["bracket-suffix-absolute-adjacent", "http://[::1]%63ritic/clean", "GET"],
  ["bracket-suffix-absolute-nested", "http://[::1]x%2563ritic/clean", "GET"],
  ["bracket-suffix-absolute-same-depth", "http://[::1]x%25%36%33ritic/clean", "GET"],
  ["bracket-suffix-scheme-relative-nested", "//[::1]x%2563ritic/clean", "GET"],
  ["bracket-suffix-scheme-relative-same-depth", "//[::1]x%25%36%33ritic/clean", "GET"],
  ["bracket-suffix-authority-form", "[::1]x%63ritic", "CONNECT"],
];
let authorityExpectedRed = 0;
for (const [caseName, url, method] of exactAuthorityAttacks) {
  assert.throws(
    () =>
      scanCredentialLeaks([{ ...base, direction: "request", method, url }], {
        secretLiterals: ["critic"],
      }),
    /secret literal/,
    `authority ${caseName}`,
  );
  transcript += `EXPECTED_RED authority-${caseName}\n`;
  authorityExpectedRed += 1;
}

assert.throws(
  () =>
    scanCredentialLeaks(
      [{ ...base, direction: "request", method: "GET", url: "/clean#%63ritic" }],
      { secretLiterals: ["critic"] },
    ),
  /secret literal/,
  "actually serialized browser fragment",
);
transcript += "EXPECTED_RED observed-serialized-fragment\n";
authorityExpectedRed += 1;

const encodedPathAttacks = [
  ["direct-leading-character", "/%63ritic"],
  ["nested-leading-character", "/%2563ritic"],
  ["same-depth-leading-character", "/%25%36%33ritic"],
  ["direct-infix-character", "/c%72itic"],
  ["direct-all-characters", "/%63%72%69%74%69%63"],
];
let encodedPathExpectedRed = 0;
for (const [caseName, serialized] of encodedPathAttacks) {
  assert.throws(
    () =>
      scanCredentialLeaks([pathObservation(serialized)], {
        secretLiterals: ["critic"],
      }),
    /secret literal/,
    `encoded path ${caseName}`,
  );
  transcript += `EXPECTED_RED encoded-path-${caseName}\n`;
  encodedPathExpectedRed += 1;
}

const normalizationRemovalAttacks = [
  ["direct-before-dot-dot", "/%63ritic/.."],
  ["nested-before-dot-dot", "/%2563ritic/.."],
  ["same-depth-before-dot-dot", "/%25%36%33ritic/.."],
  ["middle-before-encoded-dot-dot", "/a/%63ritic/%2e%2e/b"],
];
let normalizationRemovalExpectedRed = 0;
for (const [caseName, serialized] of normalizationRemovalAttacks) {
  for (const [targetKind, absolute] of [
    ["relative", false],
    ["absolute", true],
  ]) {
    assert.throws(
      () =>
        scanCredentialLeaks([pathObservation(serialized, absolute)], {
          secretLiterals: ["critic"],
        }),
      /secret literal/,
      `normalization removal ${caseName} ${targetKind}`,
    );
    transcript += `EXPECTED_RED normalization-removal-${caseName}-${targetKind}\n`;
    normalizationRemovalExpectedRed += 1;
  }
}

const mixedPercentAttacks = [
  ["adjacent-literal-before-nested", "%25%2525G", []],
  ["separated-literal-before-nested", "%25x%2525G_", []],
  ["infix-literal-before-nested", "left%25middle%2525G-right", []],
  ["nested-before-literal", "%2525G%25", []],
  ["literal-masks-protected", "%25%252563%252572%252569%252574%252569%252563", ["critic"]],
];
let mixedExpectedRed = 0;
for (const [caseName, serialized, secrets] of mixedPercentAttacks) {
  for (const [channel, observation] of componentObservations(serialized)) {
    assert.throws(
      () => scanCredentialLeaks([observation], { secretLiterals: secrets }),
      /secret literal|percent encoding/,
      `${caseName} ${channel}`,
    );
    transcript += `EXPECTED_RED mixed-percent-${caseName}-${channel}\n`;
    mixedExpectedRed += 1;
  }
}

const alternateProtectedAttacks = [
  ["same-depth-leading-character", "%25%36%33ritic"],
  ["same-depth-infix-character", "c%25%37%32itic"],
];
let alternateExpectedRed = 0;
for (const [caseName, serialized] of alternateProtectedAttacks) {
  for (const [channel, observation] of componentObservations(serialized)) {
    assert.throws(
      () => scanCredentialLeaks([observation], { secretLiterals: ["critic"] }),
      /secret literal/,
      `${caseName} ${channel}`,
    );
    transcript += `EXPECTED_RED alternate-protected-${caseName}-${channel}\n`;
    alternateExpectedRed += 1;
  }
}

function protectedCharacterVariants(character) {
  const octet = character.codePointAt(0).toString(16).padStart(2, "0");
  const high = octet[0];
  const low = octet[1];
  const encodedHigh = `%${high.codePointAt(0).toString(16)}`;
  const encodedLow = `%${low.codePointAt(0).toString(16)}`;
  return [character, `%${octet}`, `%25${octet}`, `%25${encodedHigh}${encodedLow}`];
}

let protectedLiteralSpellings = [""];
for (const character of "critic") {
  protectedLiteralSpellings = protectedLiteralSpellings.flatMap((prefix) =>
    protectedCharacterVariants(character).map((variant) => `${prefix}${variant}`),
  );
}
for (const serialized of protectedLiteralSpellings) {
  for (const [channel, observation] of componentObservations(serialized)) {
    assert.throws(
      () => scanCredentialLeaks([observation], { secretLiterals: ["critic"] }),
      /secret literal|percent encoding/,
      `protected literal spelling ${serialized} ${channel}`,
    );
  }
}
transcript += `PROPERTY_RED protected-literal-per-character variants=4 spellings=${String(protectedLiteralSpellings.length)} channels=url-name,url-value,form-name,form-value,header-name,header-value,cookie-name,cookie-value,set-cookie-name,set-cookie-value,set-cookie-attribute-name,set-cookie-attribute-value\n`;
for (const serialized of protectedLiteralSpellings) {
  assert.throws(
    () =>
      scanCredentialLeaks([pathObservation(`/${serialized}`)], {
        secretLiterals: ["critic"],
      }),
    /secret literal/,
    `encoded path protected literal spelling ${serialized}`,
  );
}
transcript += `PROPERTY_RED encoded-path-protected-literal variants=4 spellings=${String(protectedLiteralSpellings.length)} channels=path-segment\n`;

const authorityChannels = [
  "absolute-userinfo",
  "absolute-host",
  "absolute-port",
  "scheme-relative-userinfo",
  "scheme-relative-host",
  "scheme-relative-port",
  "authority-host",
  "authority-port",
  "absolute-bracket-suffix",
  "scheme-relative-bracket-suffix",
  "authority-bracket-suffix",
  "absolute-bracket-suffix-after-userinfo",
];
let authorityPropertyCases = 0;
for (const serialized of protectedLiteralSpellings) {
  for (const channel of authorityChannels) {
    assert.throws(
      () =>
        scanCredentialLeaks([authorityObservation(channel, serialized)], {
          secretLiterals: ["critic"],
        }),
      /secret literal/,
      `authority protected literal spelling ${serialized} ${channel}`,
    );
    authorityPropertyCases += 1;
  }
}
transcript += `PROPERTY_RED authority-protected-literal variants=4 spellings=${String(protectedLiteralSpellings.length)} channels=${authorityChannels.join(",")} cases=${String(authorityPropertyCases)}\n`;

const normalizationProtectedSpellings = [
  "%63ritic",
  "%2563ritic",
  "%25%36%33ritic",
  "c%72itic",
  "%63%72%69%74%69%63",
];
const dotSpellings = [".", "%2e", "%252e"];
const dotDotSpellings = ["..", "%2e%2e", ".%2e", "%2e.", "%252e%252e"];
const normalizationPlacements = [
  ["leading", (dot, secret, dotDot) => `/${dot}/${secret}/${dotDot}/tail`],
  ["middle", (dot, secret, dotDot) => `/a/${dot}/${secret}/${dotDot}/b`],
  ["trailing", (dot, secret, dotDot) => `/a/${dot}/${secret}/${dotDot}`],
];
let normalizationPropertyCases = 0;
for (const protectedSpelling of normalizationProtectedSpellings) {
  for (const dotSpelling of dotSpellings) {
    for (const dotDotSpelling of dotDotSpellings) {
      for (const [placement, makePath] of normalizationPlacements) {
        const serialized = makePath(dotSpelling, protectedSpelling, dotDotSpelling);
        for (const absolute of [false, true]) {
          assert.throws(
            () =>
              scanCredentialLeaks([pathObservation(serialized, absolute)], {
                secretLiterals: ["critic"],
              }),
            /secret literal/,
            `normalization property ${placement} ${serialized} absolute=${String(absolute)}`,
          );
          normalizationPropertyCases += 1;
        }
      }
    }
  }
}
transcript += `PROPERTY_RED normalization-removal protected=${String(normalizationProtectedSpellings.length)} dot=${String(dotSpellings.length)} dot-dot=${String(dotDotSpellings.length)} placements=${String(normalizationPlacements.length)} targets=relative,absolute cases=${String(normalizationPropertyCases)}\n`;

const percentSuffixCharacters = ["G", "_", "-"];
const percentSuffixAlphabet = [
  "",
  ...percentSuffixCharacters,
  ...percentSuffixCharacters.flatMap((high) =>
    percentSuffixCharacters.map((low) => `${high}${low}`),
  ),
];
for (const suffix of percentSuffixAlphabet) {
  const direct = `100%25${suffix}`;
  const nested = `%2525${suffix}`;
  const safeObservations = [
    { ...base, direction: "request", method: "GET", url: `${base.url}?proof=${direct}` },
    {
      ...base,
      direction: "request",
      method: "POST",
      headers: formHeaders,
      bodyBase64: Buffer.from(`proof=${direct}&${direct}=clean`).toString("base64"),
    },
    {
      ...base,
      direction: "request",
      method: "GET",
      headers: [
        [`x-percent-${suffix || "empty"}`, direct],
        [`x%2Dpercent-${suffix || "empty"}`, "clean"],
      ],
    },
  ];
  scanCredentialLeaks(safeObservations, { secretLiterals: [] });

  const rejectedObservations = [
    { ...base, direction: "request", method: "GET", url: `${base.url}?proof=${nested}` },
    {
      ...base,
      direction: "request",
      method: "POST",
      headers: formHeaders,
      bodyBase64: Buffer.from(`proof=${nested}&${nested}=clean`).toString("base64"),
    },
    {
      ...base,
      direction: "request",
      method: "GET",
      headers: [
        [`x-proof-${suffix || "empty"}`, nested],
        [`x%2525${suffix}`, "clean"],
      ],
    },
  ];
  for (const observation of rejectedObservations) {
    assert.throws(
      () => scanCredentialLeaks([observation], { secretLiterals: [] }),
      /percent encoding/,
      `nested percent suffix ${JSON.stringify(suffix)}`,
    );
  }
}
transcript += `PROPERTY_RED nested-percent suffixes=${String(percentSuffixAlphabet.length)} channels=url,form-name,form-value,header-name,header-value\n`;
transcript += `PROPERTY_GREEN direct-literal-percent suffixes=${String(percentSuffixAlphabet.length)} channels=url,form-name,form-value,header-name,header-value\n`;
const mixedOrderTemplates = [
  (suffix) => `%25%2525${suffix}`,
  (suffix) => `%25x%2525${suffix}`,
  (suffix) => `%2525${suffix}%25`,
  (suffix) => `%25%2525${suffix}%25%2525${suffix}`,
];
for (const suffix of percentSuffixAlphabet) {
  for (const [orderIndex, makeSerialized] of mixedOrderTemplates.entries()) {
    const serialized = makeSerialized(suffix);
    for (const [channel, observation] of componentObservations(serialized)) {
      assert.throws(
        () => scanCredentialLeaks([observation], { secretLiterals: [] }),
        /percent encoding/,
        `mixed percent order ${String(orderIndex)} suffix ${JSON.stringify(suffix)} ${channel}`,
      );
    }
  }
}
transcript += `PROPERTY_RED mixed-percent-order suffixes=${String(percentSuffixAlphabet.length)} orders=${String(mixedOrderTemplates.length)} channels=url-name,url-value,form-name,form-value,header-name,header-value,cookie-name,cookie-value,set-cookie-name,set-cookie-value,set-cookie-attribute-name,set-cookie-attribute-value\n`;

const cleanMixedPercentControls = [
  "%25%20canopy",
  "canopy%20%25",
  "left%25middle%2Dright",
  "%25x%2D%25",
  "%25%25",
];
for (const serialized of cleanMixedPercentControls) {
  for (const [channel, observation] of componentObservations(serialized)) {
    scanCredentialLeaks([observation], { secretLiterals: [] });
    assert.ok(channel);
  }
}
transcript += `PROPERTY_GREEN mixed-percent-order controls=${String(cleanMixedPercentControls.length)} channels=url-name,url-value,form-name,form-value,header-name,header-value,cookie-name,cookie-value,set-cookie-name,set-cookie-value,set-cookie-attribute-name,set-cookie-attribute-value\n`;

const exactSameDepthControls = [
  ["adjacent-ab", "%25%41%42"],
  ["adjacent-deadbeef", "%25%64%65%61%64%62%65%65%66"],
  ["multiple-ab-cd", "%25%41%42%25%43%44"],
  ["embedded-ab-cd", "left%25%41%42middle%25%43%44right"],
];
for (const [caseName, serialized] of exactSameDepthControls) {
  for (const [channel, observation] of componentObservations(serialized)) {
    scanCredentialLeaks([observation], { secretLiterals: ["critic"] });
    transcript += `CONTROL_GREEN same-depth-${caseName}-${channel}\n`;
  }
  scanCredentialLeaks([pathObservation(`/${serialized}`)], {
    secretLiterals: ["critic"],
  });
  transcript += `CONTROL_GREEN same-depth-${caseName}-path-segment\n`;
}

const safeNormalizationPaths = [
  ["same-depth-before-dot-dot", "/%25%41%42/.."],
  ["literal-dot-navigation", "/safe/./path/../clean"],
  ["encoded-dot-navigation", "/safe/%2e/path/%2e%2e/clean"],
  ["nested-dot-navigation", "/safe/%252e/path"],
  ["encoded-slash", "/safe%2Fvalue"],
  ["path-parameter", "/safe;proof=%25%41%42"],
  ["utf8", "/caf%C3%A9"],
  ["repeated-segments", "//safe///path"],
  ["trailing-segment", "/safe/path/"],
];
for (const [caseName, serialized] of safeNormalizationPaths) {
  for (const absolute of [false, true]) {
    scanCredentialLeaks([pathObservation(serialized, absolute)], {
      secretLiterals: ["critic"],
    });
    transcript += `CONTROL_GREEN normalization-${caseName}-${absolute ? "absolute" : "relative"}\n`;
  }
}

const safeAuthorityTargets = [
  ["absolute-userinfo-host-port", "GET", "http://user:pass@example.com:8080/clean?proof=green"],
  ["scheme-relative-userinfo", "GET", "//user@example.com/clean"],
  ["absolute-ipv6-port", "GET", "http://[2001:db8::1]:8080/clean"],
  ["scheme-relative-ipv6", "GET", "//[::1]/clean"],
  ["authority-host-port", "CONNECT", "example.com:443"],
  ["authority-ipv6-port", "CONNECT", "[2001:db8::1]:443"],
  ["punycode-host", "GET", "http://xn--caf-dma.example/clean"],
  ["same-depth-userinfo", "GET", "http://%25%41%42@example.com/clean"],
  ["same-depth-host", "GET", "http://%25%41%42.example/clean"],
  ["same-depth-port", "GET", "http://example.com:%25%41%42/clean"],
  ["encoded-at-userinfo", "GET", "http://safe%40name@example.com/clean"],
  ["encoded-colon-userinfo", "GET", "http://safe%3Aname@example.com/clean"],
  ["encoded-slash-host", "GET", "http://safe%2Fname.example/clean"],
  ["encoded-query-host", "GET", "http://safe%3Fname.example/clean"],
  ["encoded-fragment-host", "GET", "http://safe%23name.example/clean"],
  ["empty-absolute-path", "GET", "http://example.com"],
  ["empty-scheme-relative-path", "GET", "//example.com?proof=green"],
  ["origin-query-boundary", "GET", "/cri/tic?cr=itic"],
  ["authority-boundary", "GET", "http://cri@tic.test/clean"],
  ["path-query-boundary", "GET", "http://example.com/cri?proof=tic"],
  ["observed-safe-fragment", "GET", "/clean#safe%20fragment"],
  // Malformed bracket suffixes are preserved and inspected, not blanket-rejected:
  // a suffix carrying no protected literal must still be green.
  ["bracket-suffix-safe-absolute", "GET", "http://[::1]xsafe/clean"],
  ["bracket-suffix-safe-scheme-relative", "GET", "//[::1]xsafe/clean"],
  ["bracket-suffix-safe-authority", "CONNECT", "[::1]xsafe"],
  ["bracket-suffix-safe-encoded", "GET", "http://[::1]x%41%42/clean"],
  ["bracket-suffix-safe-same-depth", "GET", "http://[::1]x%25%41%42/clean"],
  ["unterminated-bracket-host", "GET", "http://[::1xsafe/clean"],
  ["empty-bracket-suffix", "GET", "http://[::1]/clean"],
];
for (const [caseName, method, url] of safeAuthorityTargets) {
  scanCredentialLeaks([{ ...base, direction: "request", method, url }], {
    secretLiterals: ["critic"],
  });
  transcript += `CONTROL_GREEN authority-${caseName}\n`;
}

const sameDepthHexOctets = ["30", "39", "41", "46", "61", "66"];
const sameDepthHexPairs = sameDepthHexOctets.flatMap((high) =>
  sameDepthHexOctets.map((low) => [high, low]),
);
for (const [high, low] of sameDepthHexPairs) {
  const sameDepth = `%25%${high}%${low}`;
  const genuinelyNested = `%2525${String.fromCodePoint(Number.parseInt(high, 16))}${String.fromCodePoint(Number.parseInt(low, 16))}`;
  for (const [channel, observation] of componentObservations(sameDepth)) {
    scanCredentialLeaks([observation], { secretLiterals: [] });
    assert.ok(channel);
  }
  for (const [channel, observation] of componentObservations(genuinelyNested)) {
    assert.throws(
      () => scanCredentialLeaks([observation], { secretLiterals: [] }),
      /percent encoding/,
      `nested same-depth control ${high}/${low} ${channel}`,
    );
  }
}
transcript += `PROPERTY_GREEN same-depth-octet-runs pairs=${String(sameDepthHexPairs.length)} channels=url-name,url-value,form-name,form-value,header-name,header-value,cookie-name,cookie-value,set-cookie-name,set-cookie-value,set-cookie-attribute-name,set-cookie-attribute-value\n`;
transcript += `PROPERTY_RED deeper-percent-with-hex pairs=${String(sameDepthHexPairs.length)} channels=url-name,url-value,form-name,form-value,header-name,header-value,cookie-name,cookie-value,set-cookie-name,set-cookie-value,set-cookie-attribute-name,set-cookie-attribute-value\n`;
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
  {
    ...base,
    direction: "request",
    method: "POST",
    url: `${base.url}?ratio=100%25`,
    headers: [...formHeaders, ["x-canopy-percent", "100%25"]],
    bodyBase64: Buffer.from("ratio=100%25").toString("base64"),
  },
  {
    ...base,
    direction: "request",
    method: "GET",
    headers: [
      ["x-canopy-proof", "clean"],
      ["x%2Dcanopy-proof", "clean"],
      ["x-percent-literal", "%25"],
    ],
  },
];
scanCredentialLeaks(allowed, { secretLiterals: [marker, `${marker}.signature`] });
transcript +=
  "CONTROL_GREEN exact Cookie/Set-Cookie HttpOnly exception with scanned attributes and other cookies\n";
transcript += "CONTROL_GREEN bounded percent-encoded URL/form/header nonsecrets\n";
transcript += "CONTROL_GREEN safe encoded literal percent in URL/form/header values\n";
transcript += "CONTROL_GREEN raw and encoded nonsecret header names\n";
transcript += `E3_T02_WIRE_SENSITIVITY_OK mutations=${String(mutations.length + encodedMutations.length + mixedExpectedRed + alternateExpectedRed + encodedPathExpectedRed + normalizationRemovalExpectedRed + authorityExpectedRed)}\n`;
const path = resolve(
  ".eforest/tasks/epic-3-the-canopy/E3-T02-app-shell-browser-verify/evidence/e3-t02-wire-sensitivity.txt",
);
await mkdir(resolve(path, ".."), { recursive: true });
await writeFile(path, transcript);
process.stdout.write(transcript);
