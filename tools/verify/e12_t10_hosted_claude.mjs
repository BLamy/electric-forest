#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  agentBranchName,
  agentPullRequestId,
  agentReplyId,
  linkedRun,
} from "../../packages/platform/dist/src/index.js";
import { createHostedFixture, readJson, task } from "./e12_t10_fixture.mjs";

const output = resolve(process.argv[2] ?? resolve(task, "work/hosted-claude"));
await mkdir(output, { recursive: true });
const token = `synthetic-${"x".repeat(40)}`;
const command = resolve(output, "claude-fixture.sh");
await writeFile(
  command,
  `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '2.1.312 (Claude Code)\\n'
  exit 0
fi
if [ -d .ef ]; then
  printf 'Synthetic hosted edit\\n' > README.md
  result='Edited README.md on the agent branch.'
else
  result='Hello from hosted Claude.'
fi
printf '%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN" >&2
printf '{"type":"result","is_error":false,"subtype":"success","result":"%s"}\\n' "$result"
`,
);
await chmod(command, 0o700);
const world = await createHostedFixture(output, {
  agentResponder: "restricted-claude",
  claudeToken: token,
  claudeCommand: command,
});
const checks = [];
let browser;
const browserErrors = [];
async function request(path, init = {}) {
  return fetch(`${world.baseUrl}${path}`, { redirect: "manual", ...init });
}
async function dispatch(cookie, streamId, type, payload) {
  const response = await request("/api/dispatch", {
    method: "POST",
    headers: { cookie, origin: world.origin, "content-type": "application/json" },
    body: JSON.stringify({ streamId, event: { type, payload, ts: world.now() } }),
  });
  assert.equal(response.status, 202, `${type}: ${await response.clone().text()}`);
}
async function reply(cookie, id, expectedId) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const response = await request(
      "/api/chat/claude-test/welcome?projection=1&reducer=chat-channel",
      { headers: { cookie } },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const event = body.events.find(
      (item) => item.type === "chat.message.post" && item.payload?.id === expectedId,
    );
    if (event !== undefined) return event;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`agent reply ${id} did not arrive`);
}
async function mention(body) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const event = (await world.events("chat:claude-test/welcome")).find(
      (item) =>
        item.type === "chat.message.post" && item.payload?.body.replaceAll("\\@", "@") === body,
    );
    if (event !== undefined) return event;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`browser did not post ${body}`);
}
try {
  const build = await readJson(await request("/api/build"), 200);
  assert.equal(build.agents, "restricted-claude");
  assert.equal(build.integrations, "off");
  assert.equal(build.auth, "auth0");
  checks.push({ name: "hosted-mode", revision: build.revision, agents: build.agents });
  const denied = await request("/api/dispatch", {
    method: "POST",
    headers: { origin: world.origin, "content-type": "application/json" },
    body: JSON.stringify({
      streamId: "agents:claude-test",
      event: {
        type: "agent.register",
        payload: {
          v: 1,
          handle: "intruder",
          config: {
            name: "Intruder",
            harness: "claude-code",
            model: "claude-sonnet-5",
            effort: "medium",
            systemPrompt: "",
            tools: [],
            mcpServers: [],
          },
        },
        ts: world.now(),
      },
    }),
  });
  assert.notEqual(denied.status, 202);
  checks.push({ name: "anonymous-agent-registration-refused", status: denied.status });
  const user = await world.login("ada");
  await dispatch(user.cookie, "ns:root", "ns.org.create", { v: 1, name: "claude-test" });
  await dispatch(user.cookie, "ns:org:claude-test", "ns.project.create", {
    v: 1,
    name: "notes",
  });
  await dispatch(user.cookie, "ns:org:claude-test", "ns.repo.create", {
    v: 1,
    name: "notebook",
    project: "notes",
    visibility: "private",
  });
  await dispatch(user.cookie, "fs:claude-test/notebook:main:meta", "fs.branch.genesis", {
    v: 1,
    branch: "main",
  });
  for (const headers of [{}, { authorization: "Bearer invalid-agent-capability" }]) {
    const response = await request("/api/repos/claude-test/notebook/home/branches", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: "unauthorized-branch" }),
    });
    assert.equal(response.status, 403);
  }
  checks.push({ name: "branch-registration-stays-private" });
  await dispatch(user.cookie, "chat:claude-test", "chat.channel.create", {
    v: 1,
    name: "welcome",
    topic: "Synthetic Claude fixture",
  });
  const historicalId = "hosted-before-registration";
  const historical = await request("/api/dispatch", {
    method: "POST",
    headers: { cookie: user.cookie, origin: world.origin, "content-type": "application/json" },
    body: JSON.stringify({
      streamId: "chat:claude-test/welcome",
      event: {
        type: "chat.message.post",
        payload: { v: 1, id: historicalId, body: "@claude old request" },
        ts: Number.MAX_SAFE_INTEGER,
      },
    }),
  });
  assert.equal(historical.status, 202);
  const page = await request("/orgs/claude-test/members", { headers: { cookie: user.cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /name="ef-agents" content="restricted-claude"/);
  browser = await chromium.launch({
    executablePath:
      process.env.AGENT_BROWSER_EXECUTABLE_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const [cookieName, cookieValue] = user.cookie.split("=");
  await context.addCookies([{ name: cookieName, value: cookieValue, url: world.origin }]);
  const tab = await context.newPage();
  tab.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  tab.on("pageerror", (error) => browserErrors.push(error.message));
  await tab.goto(`${world.origin}/members/claude-test`);
  await tab.getByTestId("members-page").waitFor();
  assert.equal(await tab.getByTestId("hosted-agents-off").count(), 0);
  await tab.getByTestId("add-member").click();
  await tab.getByText("Agent", { exact: true }).click();
  const form = tab.getByTestId("agent-form");
  await form.getByLabel("Handle").fill("claude");
  await form.getByLabel("Display name").fill("Claude");
  assert.deepEqual(await form.locator("select").first().locator("option").allTextContents(), [
    "claude-code",
  ]);
  assert.equal(await form.getByText(/shell, web and MCP tools are unavailable/).count(), 1);
  await form.getByRole("button", { name: "Register agent" }).click();
  await tab.getByTestId("members-agents").getByText("@claude").waitFor();
  const registeredAt = (await world.events("agents:claude-test")).find(
    (event) => event.type === "agent.register" && event.payload?.handle === "claude",
  )?.ts;
  const historicalEvent = (await world.events("chat:claude-test/welcome")).find(
    (event) => event.payload?.id === historicalId,
  );
  assert.ok(
    historicalEvent.payload.serverReceivedAt < registeredAt,
    JSON.stringify({ receivedAt: historicalEvent.payload.serverReceivedAt, registeredAt }),
  );
  checks.push({ name: "browser-agent-registration" });
  await tab.goto(`${world.origin}/chat/claude-test/welcome`);
  await tab.getByTestId("chat-composer").waitFor();
  const editor = tab.getByTestId("chat-composer").locator('[contenteditable="true"]');
  await editor.click();
  await editor.fill("@claude say hello");
  await tab.getByTestId("chat-send").click();
  const helloMessage = await mention("@claude say hello");
  const hello = await reply(
    user.cookie,
    helloMessage.payload.id,
    agentReplyId(helloMessage.payload.id, "claude"),
  );
  assert.match(hello.payload.body, /Hello from hosted Claude/);
  assert.ok(linkedRun(hello.payload.body));
  assert.ok(helloMessage.payload.serverReceivedAt >= registeredAt);
  assert.ok(
    !(await world.events("chat:claude-test/welcome")).some(
      (event) => event.payload?.id === agentReplyId(historicalId, "claude"),
    ),
  );
  const helloEvents = await world.events("chat:claude-test/welcome");
  await tab.waitForFunction(
    (offset) =>
      globalThis.document
        .querySelector('[data-testid="chat-channel"]')
        ?.getAttribute("data-ef-offset") === offset,
    helloEvents.at(-1)?.offset,
  );
  checks.push({
    name: "chat-reply-and-historical-cutoff",
    runStream: linkedRun(hello.payload.body),
  });
  await dispatch(user.cookie, "chat:claude-test/welcome", "chat.message.post", {
    v: 1,
    id: "hosted-edit",
    body: "@claude edit $notebook README.md",
  });
  const editMessage = await mention("@claude edit $notebook README.md");
  const edited = await reply(
    user.cookie,
    editMessage.payload.id,
    agentReplyId(editMessage.payload.id, "claude"),
  );
  assert.match(edited.payload.body, /Edited README\.md/);
  assert.match(edited.payload.body, /pull request/);
  const branch = agentBranchName("claude", editMessage.payload.id);
  const branchEvents = await world.events(`fs:claude-test/notebook:${branch}:meta`);
  assert.ok(branchEvents.some((event) => event.type === "fs.file.create"));
  const pullEvents = await world.events(
    `pr:claude-test/notebook/${agentPullRequestId("claude", editMessage.payload.id, "notebook")}`,
  );
  assert.ok(pullEvents.some((event) => event.type === "pr.opened"));
  checks.push({ name: "repository-edit-and-pr", branch, branchEvents: branchEvents.length });
  const runStreams = [linkedRun(hello.payload.body), linkedRun(edited.payload.body)];
  for (const streamId of runStreams) {
    const events = await world.events(streamId);
    assert.ok(events.some((event) => event.type === "agent.run.finished"));
    assert.ok(!JSON.stringify(events).includes(token));
  }
  assert.ok(!JSON.stringify(await world.events("chat:claude-test/welcome")).includes(token));
  assert.deepEqual(browserErrors, []);
  checks.push({ name: "secret-redacted-from-streams-and-zero-browser-errors" });
  const identity = await world.dumpIdentity("hosted-claude-identity");
  await writeFile(
    resolve(output, "proof.json"),
    `${JSON.stringify({ sourceRevision: build.revision, checks, identity }, null, 2)}\n`,
  );
  assert.ok(!JSON.stringify(checks).includes(token));
  console.log(`hosted Claude fixture passed ${checks.length} checks revision=${build.revision}`);
} finally {
  await browser?.close();
  await world.close();
}
