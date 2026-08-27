#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { TextEncoder } from "node:util";
import { bootWorld } from "../../../../packages/browser-verify/dist/src/index.js";
import {
  OfficialStreamAdapter,
  RepositoryHomeStore,
} from "../../../../packages/platform/dist/src/index.js";
import { offsetForOrdinal } from "../../../../packages/protocol/dist/src/offset-allocation.js";
import { digestBytes } from "../../../../packages/streamfs/dist/src/index.js";

const root = resolve(import.meta.dirname, "../../../..");
const work = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone/work");
const proofReceiptPath = resolve(work, "empty-proof-receipt.json");
const subject = {
  id: "e5-t14-preview",
  email: "brett@electric-forest.test",
  password: "E5T14Preview1234!",
  name: "Brett Lamy",
};
const org = "maple";
const project = "canopy";
const repo = "reading-room";
const mainStream = `fs:${org}/${repo}:main:meta`;
const featureStream = `fs:${org}/${repo}:feature-product-shell:meta`;
const wikiStream = `fs:${org}/${repo}:wiki:meta`;
const encoder = new TextEncoder();

function fileCreate(path, contentStreamId, ts) {
  return { type: "fs.file.create", payload: { v: 2, path, contentStreamId }, ts };
}

function fileWrite(path, bytes, ts) {
  return {
    type: "fs.file.write",
    payload: {
      v: 2,
      path,
      base: "BASE_NONE",
      contentSha256: digestBytes(bytes),
      size: bytes.byteLength,
    },
    ts,
  };
}

function fileContent(contentStreamId, bytes, ts) {
  return {
    type: "fs.file.content",
    payload: {
      v: 2,
      contentStreamId,
      contentBase64: Buffer.from(bytes).toString("base64"),
    },
    ts,
  };
}

function appEvent(type, payload, ts) {
  return { type, payload, ts };
}

await mkdir(work, { recursive: true });
await writeFile(proofReceiptPath, "{}\n");
const world = await bootWorld({ root, subject, fixtureLogin: true, proofReceiptPath });
const streams = new OfficialStreamAdapter({ baseUrl: world.streamUrl });
const homes = new RepositoryHomeStore(streams, () => 1_780_000_000_000);
const rawAppendApplication = world.appendApplication.bind(world);
const knownStreams = new Set([mainStream]);
world.appendApplication = async (streamId, event) => {
  if (!knownStreams.has(streamId)) {
    await streams.create(streamId);
    knownStreams.add(streamId);
  }
  return rawAppendApplication(streamId, event);
};

async function appendContent(streamId, event) {
  if (!knownStreams.has(streamId)) {
    await streams.create(streamId);
    knownStreams.add(streamId);
  }
  return streams.append(streamId, event);
}

const readmeContent = `fs:${org}/${repo}:main:file:readme`;
const packageContent = `fs:${org}/${repo}:main:file:package`;
const appContent = `fs:${org}/${repo}:main:file:app`;
const readmeBytes = encoder.encode(
  "# Electric Forest Reading Room\n\nA durable, replayable repository where every issue, review, and merge is an event.\n\n## Product surfaces\n\n- Repository code and history\n- Pull requests with evidence\n- Live issues and wiki pages\n",
);
const packageBytes = encoder.encode(
  '{\n  "name": "@maple/reading-room",\n  "private": true,\n  "scripts": { "verify": "pnpm test" }\n}\n',
);
const appBytes = encoder.encode(
  'export const product = {\n  name: "Electric Forest",\n  durable: true,\n  tabs: ["Code", "Pull Requests", "Issues", "Wiki", "Settings"],\n};\n',
);
const mainEvents = [
  appEvent("fs.dir.create", { v: 2, path: "apps" }, 10),
  appEvent("fs.dir.create", { v: 2, path: "apps/web" }, 11),
  appEvent("fs.dir.create", { v: 2, path: "packages" }, 12),
  fileCreate("README.md", readmeContent, 13),
  fileWrite("README.md", readmeBytes, 14),
  fileCreate("package.json", packageContent, 15),
  fileWrite("package.json", packageBytes, 16),
  fileCreate("apps/web/product.ts", appContent, 17),
  fileWrite("apps/web/product.ts", appBytes, 18),
];
await world.seedPublicRepo({ org, project, repo, branch: "main", events: mainEvents });
await homes.ensureRepository(org, repo, project);
await appendContent(readmeContent, fileContent(readmeContent, readmeBytes, 14));
await appendContent(packageContent, fileContent(packageContent, packageBytes, 16));
await appendContent(appContent, fileContent(appContent, appBytes, 18));

for (const [index, name] of [
  "stream-lab",
  "docstream-demo",
  "forest-cli",
  "mobile-kit",
].entries()) {
  await world.dispatchNamespace(
    `ns:org:${org}`,
    appEvent("ns.repo.create", { v: 1, name, project, visibility: "public" }, 30 + index),
  );
  const streamId = `fs:${org}/${name}:main:meta`;
  const contentId = `fs:${org}/${name}:main:file:readme`;
  const bytes = encoder.encode(`# ${name}\n\nDurable stream workspace.\n`);
  await world.appendApplication(streamId, fileCreate("README.md", contentId, 40 + index * 2));
  await world.appendApplication(streamId, fileWrite("README.md", bytes, 41 + index * 2));
  await appendContent(contentId, fileContent(contentId, bytes, 41 + index * 2));
  await homes.ensureRepository(org, name, project);
}

const forkOffset = offsetForOrdinal(mainEvents.length - 1);
const featureReadmeContent = `fs:${org}/${repo}:feature-product-shell:file:readme`;
const featureShellContent = `fs:${org}/${repo}:feature-product-shell:file:shell`;
const featureReadmeBytes = encoder.encode(
  "# Electric Forest Reading Room\n\nThe visual capstone brings repository code, pull requests, issues, wiki, and settings into one quiet dark product shell.\n\n## Evidence\n\nEvery rendered state still exposes its durable stream offset and digest.\n",
);
const featureShellBytes = encoder.encode(
  'export function ProductShell() {\n  return { rail: "fixed", tabs: 5, theme: "dark", mobile: "TouchKit" };\n}\n',
);
await streams.create(featureStream);
knownStreams.add(featureStream);
await streams.append(
  featureStream,
  appEvent("fs.branch.fork", { v: 1, parentStreamId: mainStream, forkOffset }, 60),
  { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
);
await world.appendApplication(
  featureStream,
  appEvent("fs.file.delete", { v: 2, path: "README.md" }, 61),
);
await world.appendApplication(featureStream, fileCreate("README.md", featureReadmeContent, 62));
await world.appendApplication(featureStream, fileWrite("README.md", featureReadmeBytes, 63));
await world.appendApplication(
  featureStream,
  fileCreate("apps/web/ProductShell.tsx", featureShellContent, 64),
);
await world.appendApplication(
  featureStream,
  fileWrite("apps/web/ProductShell.tsx", featureShellBytes, 65),
);
await appendContent(
  featureReadmeContent,
  fileContent(featureReadmeContent, featureReadmeBytes, 63),
);
await appendContent(featureShellContent, fileContent(featureShellContent, featureShellBytes, 65));
await homes.registerNativeBranch(org, repo, "feature-product-shell");

const wikiHomeContent = `fs:${org}/${repo}:wiki:file:home`;
const wikiArchitectureContent = `fs:${org}/${repo}:wiki:file:architecture`;
const wikiHomeBytes = encoder.encode(
  "# Reading Room Wiki\n\nWelcome to the **Electric Forest** product guide. Markdown is rendered by Docstream from the canonical wiki stream.\n\n## Start here\n\n1. Open a pull request.\n2. Attach deterministic evidence.\n3. Review and merge.\n",
);
const wikiArchitectureBytes = encoder.encode(
  "# Architecture\n\nThe web application projects append-only streams into repository, issue, pull-request, and wiki views.\n",
);
await streams.create(wikiStream);
knownStreams.add(wikiStream);
await streams.append(
  wikiStream,
  appEvent("fs.branch.fork", { v: 1, parentStreamId: mainStream, forkOffset }, 70),
  { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
);
await world.appendApplication(wikiStream, fileCreate("home.md", wikiHomeContent, 71));
await world.appendApplication(wikiStream, fileWrite("home.md", wikiHomeBytes, 72));
await world.appendApplication(
  wikiStream,
  fileCreate("architecture.md", wikiArchitectureContent, 73),
);
await world.appendApplication(wikiStream, fileWrite("architecture.md", wikiArchitectureBytes, 74));
await appendContent(wikiHomeContent, fileContent(wikiHomeContent, wikiHomeBytes, 72));
await appendContent(
  wikiArchitectureContent,
  fileContent(wikiArchitectureContent, wikiArchitectureBytes, 74),
);
await homes.registerNativeBranch(org, repo, "wiki");

const issueIds = ["visual-capstone", "mobile-navigation", "docstream-policy"];
for (const [index, issueId] of issueIds.entries()) {
  const streamId = `issue:${org}/${repo}/${issueId}`;
  await world.appendApplication(
    streamId,
    appEvent(
      "issue.opened",
      {
        v: 1,
        title:
          index === 0
            ? "Finish the visual product capstone"
            : index === 1
              ? "Polish mobile repository navigation"
              : "Route every Markdown surface through Docstream",
        body:
          index === 0
            ? "Match the supplied product references while preserving stream truth."
            : "Keep the interaction reachable and keyboard accessible.",
      },
      90 + index * 10,
    ),
  );
  await world.appendApplication(
    streamId,
    appEvent(
      "issue.commented",
      {
        v: 1,
        commentId: `comment-${String(index + 1)}`,
        body: "The focused implementation is ready for a visual review.",
      },
      91 + index * 10,
    ),
  );
  await appendContent(
    `repo-issues:${org}/${repo}`,
    appEvent(
      "repo.issue-observed",
      { v: 1, issueStreamId: streamId, sourceOffset: offsetForOrdinal(0) },
      92 + index * 10,
    ),
  );
}

const prCatalog = `pr-catalog:${org}/${repo}`;
const prDefinitions = [
  ["60", "E5-T14: finish the visual product capstone"],
  ["59", "E5-T13: prove issue-to-merge convergence"],
  ["58", "E5-T12: replay the negotiation session"],
  ["57", "E5-T11: attach durable evidence"],
  ["56", "E5-T10: freeze evidence references"],
];
for (const [index, [prId, title]] of prDefinitions.entries()) {
  const streamId = `pr:${org}/${repo}/${prId}`;
  await world.appendApplication(
    streamId,
    appEvent(
      "pr.opened",
      {
        v: 1,
        sourceBranch: featureStream,
        targetBranch: mainStream,
        forkOffset,
        title,
        body:
          index === 0
            ? "## Summary\n\n- match the supplied dark repository product\n- render Markdown through Docstream\n- use Pierre for diffs and file trees\n- compose the mobile experience with `@brett_lamy/ui`\n"
            : "Focused Epic 5 delivery with durable evidence.",
        author: index === 0 ? "Brett Lamy" : "Electric Forest",
        closes:
          index === 0 ? [{ entity: "issue", stream: `issue:${org}/${repo}/visual-capstone` }] : [],
      },
      150 + index * 10,
    ),
  );
  if (index < 3) {
    await world.appendApplication(
      streamId,
      appEvent(
        "pr.review-comment",
        {
          v: 2,
          author: "Sol Reviewer",
          body:
            index === 0
              ? "The hierarchy now matches the reference set."
              : "Focused evidence reviewed.",
          path: "apps/web/ProductShell.tsx",
          line: 2,
        },
        151 + index * 10,
      ),
    );
    await world.appendApplication(
      streamId,
      appEvent("pr.approved", { v: 1, reviewer: "Sol Reviewer" }, 152 + index * 10),
    );
  }
  if (index === 4) {
    await world.appendApplication(
      streamId,
      appEvent("pr.closed", { v: 1, closedBy: "Brett Lamy", reason: "superseded" }, 153),
    );
  }
  await world.appendApplication(
    prCatalog,
    appEvent(
      "pr-catalog.registered",
      { v: 1, prStream: streamId, sourceOffset: offsetForOrdinal(0) },
      180 + index,
    ),
  );
}

let stop;
const stopped = new Promise((resolveStop) => {
  stop = resolveStop;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop());
process.stdout.write(
  `E5_T14_READY ${JSON.stringify({
    url: world.platformUrl,
    repoUrl: `${world.platformUrl}/${org}/${repo}`,
    treeUrl: `${world.platformUrl}/${org}/${repo}/tree/main/`,
    fileUrl: `${world.platformUrl}/${org}/${repo}/blob/main/README.md`,
    pullsUrl: `${world.platformUrl}/orgs/${org}/repos/${repo}/pulls`,
    prUrl: `${world.platformUrl}/orgs/${org}/repos/${repo}/pulls/60`,
    issuesUrl: `${world.platformUrl}/orgs/${org}/repos/${repo}/issues`,
    wikiUrl: `${world.platformUrl}/orgs/${org}/repos/${repo}/wiki/home`,
    subject: subject.email,
  })}\n`,
);

try {
  await stopped;
} finally {
  await world.close();
}
