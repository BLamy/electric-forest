import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../../../..");
const efBinary = join(repoRoot, "packages/cli/dist/src/bin.js");
const expectedDirectory = process.env.E4_T04_EXPECTED_DIR ?? scriptDirectory;
const streamId = "fs:golden/status:main:meta";
const client = await import(
  pathToFileURL(join(repoRoot, "packages/client/dist/src/index.js")).href
);
const protocol = await import(
  pathToFileURL(join(repoRoot, "packages/protocol/dist/src/index.js")).href
);
const allocation = await import(
  pathToFileURL(join(repoRoot, "packages/protocol/dist/src/offset-allocation.js")).href
);
const serverModule = await import(
  pathToFileURL(join(repoRoot, "packages/server/dist/src/index.js")).href
);

function metadata(content: Buffer): { readonly contentSha256: string; readonly size: number } {
  return { contentSha256: protocol.sha256Hex(content), size: content.byteLength };
}

async function runStatus(root: string, serverUrl: string): Promise<string> {
  const environment = {
    ...process.env,
    EF_HOME: join(root, "home"),
    EF_STREAM_SERVER_URL: serverUrl,
  };
  delete environment.NODE_OPTIONS;
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(process.execPath, [efBinary, "status", "--json"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`ef status failed (${String(code ?? signal)}): ${stdout}${stderr}`));
      } else {
        resolveOutput(stdout);
      }
    });
  });
  const parsed: unknown = JSON.parse(output);
  if (`${protocol.canonicalJson(parsed)}\n` !== output) {
    throw new Error("status golden output was not one canonical JSON line");
  }
  return output;
}

async function appendRecord(
  serverUrl: string,
  targetStreamId: string,
  ordinal: number,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = `${serverUrl}/streams/${encodeURIComponent(targetStreamId)}`;
  const offset = allocation.offsetForOrdinal(ordinal);
  await client.appendDurableJson({ url }, { offset, type, payload, ts: ordinal }, offset);
}

async function runClone(root: string, serverUrl: string): Promise<void> {
  const environment = {
    ...process.env,
    EF_HOME: join(root, "home"),
    EF_SERVER: serverUrl,
    EF_STREAM_SERVER_URL: serverUrl,
  };
  delete environment.NODE_OPTIONS;
  await new Promise<void>((resolveClone, reject) => {
    const child = spawn(process.execPath, [efBinary, "clone", "golden/status", "main", root], {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`ef clone failed (${String(code ?? signal)}): ${stdout}${stderr}`));
      } else if (!stdout.startsWith("checkpoint ")) {
        reject(new Error(`ef clone produced unexpected stdout: ${stdout}${stderr}`));
      } else {
        resolveClone();
      }
    });
  });
}

async function main(): Promise<void> {
  const dataDirectory = await mkdtemp(join(repoRoot, ".eforest-status-server-"));
  const server = serverModule.createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dataDirectory,
  });
  const serverUrl = await server.start();
  const root = await mkdtemp(join(repoRoot, ".eforest-status-golden-workspace-"));
  const base = Buffer.from("base\n", "utf8");
  const dataBase = Buffer.from("data\n", "utf8");
  const contentStreamId = "fs:golden/status:main:file:1";
  const dataContentStreamId = "fs:golden/status:main:file:2";
  try {
    const streamUrl = `${serverUrl}/streams/${encodeURIComponent(streamId)}`;
    const contentUrl = `${serverUrl}/streams/${encodeURIComponent(contentStreamId)}`;
    const dataContentUrl = `${serverUrl}/streams/${encodeURIComponent(dataContentStreamId)}`;
    await client.createDurableJsonStream({ url: streamUrl });
    await client.createDurableJsonStream({ url: contentUrl });
    await client.createDurableJsonStream({ url: dataContentUrl });
    await appendRecord(serverUrl, streamId, 0, "fs.branch.genesis", { branch: "main", v: 1 });
    await appendRecord(serverUrl, streamId, 1, "fs.file.create", {
      contentStreamId,
      path: "README.md",
      v: 2,
    });
    await appendRecord(serverUrl, streamId, 2, "fs.file.write", {
      base: "BASE_NONE",
      contentSha256: metadata(base).contentSha256,
      path: "README.md",
      size: base.byteLength,
      v: 2,
    });
    await appendRecord(serverUrl, contentStreamId, 0, "fs.file.content", {
      contentBase64: base.toString("base64"),
      contentStreamId,
      v: 2,
    });
    await appendRecord(serverUrl, streamId, 3, "fs.file.create", {
      contentStreamId: dataContentStreamId,
      path: "data.bin",
      v: 2,
    });
    await appendRecord(serverUrl, streamId, 4, "fs.file.write", {
      base: "BASE_NONE",
      contentSha256: metadata(dataBase).contentSha256,
      path: "data.bin",
      size: dataBase.byteLength,
      v: 2,
    });
    await appendRecord(serverUrl, dataContentStreamId, 0, "fs.file.content", {
      contentBase64: dataBase.toString("base64"),
      contentStreamId: dataContentStreamId,
      v: 2,
    });
    await runClone(root, serverUrl);

    const steps: Array<[string, string]> = [];
    const capture = async (name: string): Promise<void> => {
      const output = await runStatus(root, serverUrl);
      steps.push([name, output]);
    };

    await capture("step-01-pristine");
    const flipped = Buffer.from(base);
    flipped[0] = flipped[0]! ^ 1;
    await writeFile(join(root, "README.md"), flipped);
    await capture("step-02-same-size-modified");
    await writeFile(
      join(root, "data.bin"),
      Buffer.concat([dataBase, Buffer.from("append\n", "utf8")]),
    );
    await capture("step-03-appended");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "é.txt"), Buffer.from("unicode\n", "utf8"));
    await capture("step-04-unicode-added");
    await unlink(join(root, "README.md"));
    await capture("step-05-delete");
    await writeFile(join(root, "README.md"), base);
    await writeFile(join(root, "data.bin"), dataBase);
    await rm(join(root, "nested"), { recursive: true, force: true });
    await utimes(
      join(root, "README.md"),
      new Date("2001-01-01T00:00:00.000Z"),
      new Date("2001-01-01T00:00:00.000Z"),
    );
    await capture("step-06-mtime-clean");
    await appendRecord(serverUrl, streamId, 5, "fs.branch.genesis", { branch: "main", v: 1 });
    await appendRecord(serverUrl, streamId, 6, "fs.branch.genesis", { branch: "main", v: 1 });
    await capture("step-07-behind-by-two");

    for (const [name, output] of steps) {
      const path = join(expectedDirectory, `${name}.json`);
      const expected = await readFile(path, "utf8");
      if (expected !== output) {
        throw new Error(`${name}: output differs from frozen ${path}`);
      }
    }
    console.log(`E4-T04 status goldens: ${steps.length} steps verified`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await server.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

await main();
