import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const replayCliIdentity = Object.freeze({
  name: "replayio",
  version: "1.8.2",
  bin: "./bin.js",
  integrity:
    "sha512-0LwdJmtI/HZMFIuXkkuWIBHM9MJpQ/Tmh5OZJek9L7JFiny0cOGtfyv49IhZ3FRP2I17fPZePf0GLG3wGamOFg==",
  target: "darwin-arm64",
  closurePackages: 281,
  closureFiles: 16475,
  closureMissing: 20,
  closureSha256: "eddbbbace5c6807b5ce329cd8ef7bf82040682dd226d6b78fc2598aba0b3f8b0",
});

function contractFailure(message) {
  throw new Error(`E3-T02 Replay CLI contract: ${message}`);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function computePackageTreeDigest(packageRoot) {
  const root = realpathSync(packageRoot);
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      // pnpm generates dependency shims containing checkout-absolute paths. They are
      // neither part of the replayio tarball payload nor used by our absolute bin.js
      // execution path, so exclude the complete nested dependency tree.
      if (name === "node_modules") continue;
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        const relativePath = relative(root, path).split(sep).join("/");
        const fileSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
        entries.push(`${relativePath}\0${fileSha256}`);
      }
    }
  }
  visit(root);
  entries.sort();
  return {
    files: entries.length,
    sha256: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

function resolvedDependencyRoot(packageRoot, dependencyName, expectedPackageName) {
  let nodeModules = packageRoot;
  while (nodeModules !== dirname(nodeModules) && nodeModules.split(sep).at(-1) !== "node_modules") {
    nodeModules = dirname(nodeModules);
  }
  for (const candidate of [
    resolve(packageRoot, "node_modules", dependencyName),
    resolve(nodeModules, dependencyName),
  ]) {
    try {
      const root = realpathSync(candidate);
      const identity = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      if (identity.name === expectedPackageName) return root;
    } catch {
      // Missing optional and peer dependencies are recorded by the closure caller.
    }
  }
  try {
    const resolvedEntry = createRequire(resolve(packageRoot, "package.json")).resolve(
      dependencyName,
    );
    let candidate = dirname(realpathSync(resolvedEntry));
    while (candidate !== dirname(candidate)) {
      try {
        const identity = JSON.parse(readFileSync(resolve(candidate, "package.json"), "utf8"));
        if (identity.name === expectedPackageName) return realpathSync(candidate);
      } catch {
        // Continue toward the package root selected by Node.
      }
      candidate = dirname(candidate);
    }
  } catch {
    // Missing optional and peer dependencies are recorded by the closure caller.
  }
  return undefined;
}

export function computeInstalledDependencyClosure(entryPackageRoot, pnpmStore) {
  const store = realpathSync(pnpmStore);
  const pending = [realpathSync(entryPackageRoot)];
  const seen = new Set();
  const packages = [];
  const missing = [];
  while (pending.length > 0) {
    const packageRoot = pending.pop();
    if (seen.has(packageRoot)) continue;
    seen.add(packageRoot);
    if (!isWithin(store, packageRoot)) {
      contractFailure("Replay CLI dependency resolves outside the pnpm store");
    }
    const identity = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    if (typeof identity.name !== "string" || typeof identity.version !== "string") {
      contractFailure("Replay CLI dependency has no package identity");
    }
    const storeIdentity = relative(store, packageRoot).split(sep).join("/");
    const payload = computePackageTreeDigest(packageRoot);
    packages.push({
      name: identity.name,
      version: identity.version,
      storeIdentity,
      files: payload.files,
      payloadSha256: payload.sha256,
    });

    const dependencies = new Map();
    for (const [name, specifier] of Object.entries(identity.dependencies ?? {})) {
      dependencies.set(name, { kind: "dependency", specifier });
    }
    for (const [name, specifier] of Object.entries(identity.optionalDependencies ?? {})) {
      dependencies.set(name, { kind: "optionalDependency", specifier });
    }
    for (const [name, specifier] of Object.entries(identity.peerDependencies ?? {})) {
      dependencies.set(name, {
        kind: identity.peerDependenciesMeta?.[name]?.optional
          ? "optionalPeerDependency"
          : "peerDependency",
        specifier,
      });
    }
    for (const [name, descriptor] of [...dependencies].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const alias = /^npm:(@[^/]+\/[^@]+|[^@]+)@/.exec(descriptor.specifier);
      const expectedPackageName = alias?.[1] ?? name;
      const dependencyRoot = resolvedDependencyRoot(packageRoot, name, expectedPackageName);
      if (dependencyRoot === undefined) {
        if (descriptor.kind === "dependency") {
          contractFailure(`${identity.name} has an unresolved required dependency ${name}`);
        }
        missing.push(`${storeIdentity}\0${descriptor.kind}\0${name}`);
      } else {
        pending.push(dependencyRoot);
      }
    }
  }
  packages.sort((left, right) => left.storeIdentity.localeCompare(right.storeIdentity));
  missing.sort();
  const target = `${process.platform}-${process.arch}`;
  const records = [
    `target\0${target}`,
    ...packages.map(
      (entry) =>
        `package\0${entry.storeIdentity}\0${entry.name}\0${entry.version}\0${String(entry.files)}\0${entry.payloadSha256}`,
    ),
    ...missing.map((entry) => `missing\0${entry}`),
  ];
  return {
    target,
    packages: packages.length,
    files: packages.reduce((total, entry) => total + entry.files, 0),
    missing: missing.length,
    sha256: createHash("sha256").update(records.join("\n")).digest("hex"),
    entries: packages,
    missingEntries: missing,
  };
}

export function resolvePinnedReplayCli(projectRoot) {
  const root = realpathSync(projectRoot);
  const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (rootPackage.devDependencies?.replayio !== replayCliIdentity.version) {
    contractFailure("root devDependency is not the exact pinned version");
  }
  const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  if (
    !/^\s{6}replayio:\n\s{8}specifier: 1\.8\.2\n\s{8}version: 1\.8\.2(?:\(|\n)/m.test(lock) ||
    !lock.includes(`replayio@1.8.2:\n    resolution: {integrity: ${replayCliIdentity.integrity}}`)
  ) {
    contractFailure("lockfile importer does not bind replayio 1.8.2");
  }

  const shimPath = resolve(root, "node_modules/.bin/replayio");
  const shimStat = lstatSync(shimPath);
  if (!shimStat.isFile() || shimStat.isSymbolicLink()) {
    contractFailure("workspace replayio shim is not a real file");
  }
  const shimRealPath = realpathSync(shimPath);
  if (!isWithin(realpathSync(resolve(root, "node_modules/.bin")), shimRealPath)) {
    contractFailure("workspace replayio shim resolves outside node_modules/.bin");
  }
  const packageRoot = realpathSync(resolve(root, "node_modules/replayio"));
  const pnpmStore = realpathSync(resolve(root, "node_modules/.pnpm"));
  if (
    !isWithin(pnpmStore, packageRoot) ||
    !packageRoot.includes(`${sep}replayio@1.8.2_`) ||
    !packageRoot.endsWith(`${sep}node_modules${sep}replayio`)
  ) {
    contractFailure("resolved replayio package is outside the pinned pnpm package path");
  }
  const packageIdentity = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  if (
    packageIdentity.name !== replayCliIdentity.name ||
    packageIdentity.version !== replayCliIdentity.version ||
    packageIdentity.bin !== replayCliIdentity.bin
  ) {
    contractFailure("installed replayio package identity does not match the lock");
  }
  const binPath = realpathSync(resolve(packageRoot, replayCliIdentity.bin));
  if (!isWithin(packageRoot, binPath) || !lstatSync(binPath).isFile()) {
    contractFailure("resolved Replay CLI entrypoint escapes its package");
  }
  const closure = computeInstalledDependencyClosure(packageRoot, pnpmStore);
  if (
    closure.target !== replayCliIdentity.target ||
    closure.packages !== replayCliIdentity.closurePackages ||
    closure.files !== replayCliIdentity.closureFiles ||
    closure.missing !== replayCliIdentity.closureMissing ||
    closure.sha256 !== replayCliIdentity.closureSha256
  ) {
    contractFailure("installed Replay CLI dependency closure does not match the pinned digest");
  }
  return { root, shimPath, shimRealPath, packageRoot, pnpmStore, binPath, closure };
}

const allowedEnvironment = Object.freeze([
  "RECORD_REPLAY_API_KEY",
  "RECORD_REPLAY_SERVER",
  "REPLAY_API_KEY",
  "REPLAY_API_SERVER",
  "REPLAY_APP_SERVER",
  "REPLAY_AUTH_CLIENT_ID",
  "REPLAY_AUTH_HOST",
  "REPLAY_SERVER",
  "REPLAY_TELEMETRY_DISABLED",
]);

export function buildTrustedReplayEnvironment(source, recordingDirectory) {
  const identity = userInfo();
  const env = {
    HOME: identity.homedir,
    LOGNAME: identity.username,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tmpdir(),
    USER: identity.username,
  };
  for (const name of allowedEnvironment) {
    if (typeof source[name] === "string" && source[name] !== "") env[name] = source[name];
  }
  if (recordingDirectory !== undefined) {
    env.RECORD_REPLAY_DIRECTORY = recordingDirectory;
  }
  return env;
}
