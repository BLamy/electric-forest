import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { canonicalJson, sha256Hex } from "@eforest/protocol";

export const WORKSPACE_VERSION = 1 as const;
export type WorkspaceRole = "builder" | "critic";

export interface DiffManifestEntry {
  readonly path: string;
  readonly digest: string;
}

export interface EvidenceManifestEntry {
  readonly id: string;
  readonly digest: string;
}

/** The only inputs a fresh critic is allowed to receive. */
export interface CriticInputs {
  readonly taskSpec: string;
  readonly diffManifest: readonly DiffManifestEntry[];
  readonly claim: string;
  readonly evidenceManifest: readonly EvidenceManifestEntry[];
}

export interface BuilderInputs {
  readonly taskSpec: string;
  readonly branchStream: string;
  readonly branchHead: string;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface WorkspaceManifest {
  readonly v: typeof WORKSPACE_VERSION;
  readonly role: WorkspaceRole;
  readonly root: string;
  readonly files: readonly WorkspaceFile[];
  readonly inputsDigest: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface WorkspaceEnvironmentInput {
  readonly role: WorkspaceRole;
  readonly taskId: string;
  readonly runId: string;
  readonly branchStream: string;
}

export interface SecretScanFinding {
  readonly path: string;
  readonly pattern: string;
}

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["bearer-token", /Bearer\s+[A-Za-z0-9._~-]+/i],
  ["cli-token", /ef_cli_[A-Za-z0-9_-]+/],
  ["capability-token", /cap_v1\.[A-Za-z0-9_-]+\.[0-9]+/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["secret-assignment", /(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*[:=]\s*[^\s]{8,}/i],
];

function fileDigest(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return sha256Hex(bytes);
}

function safePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! === 0);
}

function safeText(value: string, max: number): boolean {
  return value.length <= max && !hasControlCharacter(value);
}

function inputsDigest(inputs: unknown): string {
  return fileDigest(canonicalJson(inputs));
}

function environment(input: WorkspaceEnvironmentInput): Readonly<Record<string, string>> {
  // Deliberately constructed from protocol inputs; no inherited process environment is copied.
  return {
    CI: "1",
    EF_AGENT_ROLE: input.role,
    EF_TASK_ID: input.taskId,
    EF_RUN_ID: input.runId,
    EF_BRANCH_STREAM: input.branchStream,
  };
}

function assertCriticInputs(inputs: CriticInputs): void {
  if (!safeText(inputs.taskSpec, 1_048_576) || !safeText(inputs.claim, 32_768)) {
    throw new TypeError("critic inputs exceed the frozen workspace limits");
  }
  for (const entry of inputs.diffManifest) {
    if (!safePath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.digest))
      throw new TypeError("invalid diff manifest");
  }
  for (const entry of inputs.evidenceManifest) {
    if (!safePath(entry.id) || !/^[a-f0-9]{64}$/.test(entry.digest))
      throw new TypeError("invalid evidence manifest");
  }
  const findings = scanSecrets(canonicalJson(inputs), "critic-inputs");
  if (findings.length > 0) throw new TypeError("critic inputs contain a secret");
}

async function writeWorkspaceFile(
  root: string,
  path: string,
  contents: string,
): Promise<WorkspaceFile> {
  if (!safePath(path)) throw new TypeError(`unsafe workspace path: ${path}`);
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, contents, { encoding: "utf8", flag: "wx" });
  return {
    path,
    digest: fileDigest(contents),
    size: new TextEncoder().encode(contents).byteLength,
  };
}

export function safeAgentEnvironment(
  input: WorkspaceEnvironmentInput,
): Readonly<Record<string, string>> {
  return environment(input);
}

export async function createCriticWorkspace(
  inputs: CriticInputs,
  options: { readonly baseDir?: string; readonly environment: WorkspaceEnvironmentInput },
): Promise<WorkspaceManifest> {
  assertCriticInputs(inputs);
  const base = options.baseDir ?? tmpdir();
  const root = await mkdtemp(join(base, "eforest-critic-"));
  const files: WorkspaceFile[] = [];
  files.push(await writeWorkspaceFile(root, "task/spec.md", inputs.taskSpec));
  files.push(await writeWorkspaceFile(root, "task/claim.txt", inputs.claim));
  files.push(
    await writeWorkspaceFile(root, "task/diff-manifest.json", canonicalJson(inputs.diffManifest)),
  );
  files.push(
    await writeWorkspaceFile(
      root,
      "task/evidence-manifest.json",
      canonicalJson(inputs.evidenceManifest),
    ),
  );
  return {
    v: WORKSPACE_VERSION,
    role: "critic",
    root,
    files,
    inputsDigest: inputsDigest(inputs),
    environment: environment({ ...options.environment, role: "critic" }),
  };
}

export async function createBuilderWorkspace(
  inputs: BuilderInputs,
  options: { readonly baseDir?: string; readonly environment: WorkspaceEnvironmentInput },
): Promise<WorkspaceManifest> {
  if (
    !safeText(inputs.taskSpec, 1_048_576) ||
    !safeText(inputs.branchStream, 512) ||
    !safeText(inputs.branchHead, 64)
  ) {
    throw new TypeError("invalid builder inputs");
  }
  const root = await mkdtemp(join(options.baseDir ?? tmpdir(), "eforest-builder-"));
  const files = [
    await writeWorkspaceFile(root, "task/spec.md", inputs.taskSpec),
    await writeWorkspaceFile(
      root,
      "branch.json",
      canonicalJson({ stream: inputs.branchStream, head: inputs.branchHead }),
    ),
  ];
  return {
    v: WORKSPACE_VERSION,
    role: "builder",
    root,
    files,
    inputsDigest: inputsDigest(inputs),
    environment: environment({ ...options.environment, role: "builder" }),
  };
}

export function scanSecrets(value: string, path = "value"): readonly SecretScanFinding[] {
  return SECRET_PATTERNS.flatMap(([pattern, expression]) =>
    expression.test(value) ? [{ path, pattern }] : [],
  );
}

export async function scanWorkspace(root: string): Promise<readonly SecretScanFinding[]> {
  const findings: SecretScanFinding[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const display = relative(root, full);
      if (entry.isSymbolicLink()) {
        findings.push({ path: display, pattern: "symlink" });
      } else if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const value = await readFile(full, "utf8");
        findings.push(...scanSecrets(value, display));
      }
    }
  };
  await visit(root);
  return findings;
}

export async function removeWorkspace(root: string): Promise<void> {
  if (root.length === 0 || root === "/")
    throw new TypeError("refusing to remove an unsafe workspace");
  await rm(root, { recursive: true, force: true });
}
