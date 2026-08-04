#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");

export const REVIEWED_RELEASE_NPM_VERSION = "10.9.3";
export const REVIEWED_TOOLCHAIN_PIN_PATH = resolve(
  packageRoot,
  "release/reviewed-node-npm-toolchain.json",
);

const TOOLCHAIN_KIND = "opendexter-reviewed-node-npm-toolchain/v1";
const SAFE_INVENTORY_PATH = /^(?:bin\/node|lib\/node_modules\/npm\/[A-Za-z0-9._@+/-]+)$/;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function same(actual, expected, label) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    fail(`${label} differs from the reviewed source pin`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} is not one SHA-256 digest`);
  }
}

function requireSafeInventoryPath(path) {
  if (
    typeof path !== "string"
    || !SAFE_INVENTORY_PATH.test(path)
    || path.includes("//")
    || path.split("/").some((part) => part === "." || part === "..")
  ) {
    fail(`reviewed toolchain inventory path is unsafe: ${path ?? "unknown"}`);
  }
  return path;
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateReviewedToolchainRuntime(runtime) {
  if (typeof runtime?.node !== "string" || !/^v\d+\.\d+\.\d+$/.test(runtime.node)) {
    fail("reviewed toolchain Node version is invalid");
  }
  if (runtime?.npm !== REVIEWED_RELEASE_NPM_VERSION) {
    fail("reviewed toolchain npm version is invalid");
  }
  requireSha256(runtime.nodeExecutableSha256, "reviewed Node executable digest");
  requireSha256(runtime.npmCliSha256, "reviewed npm CLI digest");
  requireSha256(runtime.toolchainInventorySha256, "reviewed toolchain inventory digest");
  if (!Array.isArray(runtime.toolchainInventory) || runtime.toolchainInventory.length < 3) {
    fail("reviewed toolchain inventory is incomplete");
  }
  const paths = new Set();
  let priorPath = null;
  for (const record of runtime.toolchainInventory) {
    requireSafeInventoryPath(record?.path);
    if (!Number.isSafeInteger(record?.size) || record.size < 0) {
      fail(`reviewed toolchain size is invalid for ${record?.path ?? "unknown"}`);
    }
    requireSha256(record?.sha256, `reviewed toolchain digest for ${record?.path ?? "unknown"}`);
    if (typeof record?.executable !== "boolean") {
      fail(`reviewed toolchain executable flag is invalid for ${record?.path ?? "unknown"}`);
    }
    if (paths.has(record.path)) {
      fail(`duplicate reviewed toolchain inventory path: ${record.path}`);
    }
    if (priorPath !== null && comparePath(priorPath, record.path) >= 0) {
      fail("reviewed toolchain inventory is not canonically sorted");
    }
    paths.add(record.path);
    priorPath = record.path;
  }
  const node = runtime.toolchainInventory.find((record) => record.path === "bin/node");
  const npmCli = runtime.toolchainInventory.find(
    (record) => record.path === "lib/node_modules/npm/bin/npm-cli.js",
  );
  const npmLibrary = runtime.toolchainInventory.find(
    (record) => record.path === "lib/node_modules/npm/lib/cli.js",
  );
  if (!node?.executable || !npmCli?.executable || !npmLibrary) {
    fail("reviewed toolchain inventory omits Node, npm CLI, or npm library entrypoints");
  }
  if (node.sha256 !== runtime.nodeExecutableSha256) {
    fail("reviewed Node executable digest is inconsistent with its inventory");
  }
  if (npmCli.sha256 !== runtime.npmCliSha256) {
    fail("reviewed npm CLI digest is inconsistent with its inventory");
  }
  if (sha256(JSON.stringify(canonical(runtime.toolchainInventory)))
      !== runtime.toolchainInventorySha256) {
    fail("reviewed toolchain inventory digest is inconsistent");
  }
  return runtime;
}

export function loadReviewedToolchainPin(path = REVIEWED_TOOLCHAIN_PIN_PATH) {
  const pin = JSON.parse(readFileSync(path, "utf8"));
  if (pin?.schemaVersion !== 1 || pin?.kind !== TOOLCHAIN_KIND) {
    fail("reviewed Node/npm toolchain pin has an unsupported schema");
  }
  validateReviewedToolchainRuntime(pin.runtime);
  return pin.runtime;
}

function resolveToolchainSource({ nodePath, npmRoot } = {}) {
  const requestedNode = resolve(nodePath ?? process.execPath);
  const nodeInfo = lstatSync(requestedNode);
  if (nodeInfo.isSymbolicLink()) {
    fail("reviewed Node source path must not be a symbolic link");
  }
  const node = realpathSync(requestedNode);
  const resolvedNpmRoot = realpathSync(resolve(
    npmRoot ?? resolve(dirname(node), "../lib/node_modules/npm"),
  ));
  return { node, npmRoot: resolvedNpmRoot };
}

function requireSourceDirectory(path, { immutable = false } = {}) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`reviewed toolchain source contains a link or non-directory: ${path}`);
  }
  if (immutable && (info.mode & 0o022) !== 0) {
    fail(`reviewed toolchain source directory is group/world writable: ${path}`);
  }
  if (immutable && (info.mode & 0o222) !== 0) {
    fail(`reviewed toolchain snapshot directory is writable: ${path}`);
  }
}

function regularFileRecord(path, inventoryPath, { immutable = false, allowHardlink = false } = {}) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`reviewed toolchain source contains a link or special file: ${inventoryPath}`);
  }
  if (!allowHardlink && info.nlink !== 1) {
    fail(`reviewed toolchain source contains a hard-linked file: ${inventoryPath}`);
  }
  if (immutable && (info.mode & 0o022) !== 0) {
    fail(`reviewed toolchain source file is group/world writable: ${inventoryPath}`);
  }
  if (immutable && (info.mode & 0o222) !== 0) {
    fail(`reviewed toolchain snapshot file is writable: ${inventoryPath}`);
  }
  return {
    path: requireSafeInventoryPath(inventoryPath),
    size: info.size,
    sha256: sha256File(path),
    executable: (info.mode & 0o111) !== 0,
  };
}

function npmInventory(root, { immutable = false } = {}) {
  const inventory = [];
  function validateIgnoredCache(directory) {
    requireSourceDirectory(directory, { immutable });
    for (const name of readdirSync(directory).sort(comparePath)) {
      const path = resolve(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        validateIgnoredCache(path);
        continue;
      }
      const relativePath = relative(root, path).split(sep).join("/");
      regularFileRecord(
        path,
        `lib/node_modules/npm/${relativePath}`,
        { immutable },
      );
    }
  }
  function walk(directory) {
    requireSourceDirectory(directory, { immutable });
    for (const name of readdirSync(directory).sort(comparePath)) {
      const path = resolve(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (name === "__pycache__") {
          validateIgnoredCache(path);
          continue;
        }
        walk(path);
        continue;
      }
      if (
        info.isFile()
        && !info.isSymbolicLink()
        && info.nlink === 1
        && name.endsWith(".pyc")
      ) {
        continue;
      }
      const relativePath = relative(root, path).split(sep).join("/");
      inventory.push(regularFileRecord(
        path,
        `lib/node_modules/npm/${relativePath}`,
        { immutable },
      ));
    }
  }
  walk(root);
  return inventory;
}

export function inspectReviewedToolchainSource({
  nodePath = process.execPath,
  npmRoot,
  nodeVersion = process.version,
  immutable = false,
} = {}) {
  const source = resolveToolchainSource({ nodePath, npmRoot });
  const node = regularFileRecord(source.node, "bin/node", {
    immutable,
    // NVM's reviewed Node binary can be hard-linked. The private snapshot is not.
    allowHardlink: !immutable,
  });
  if (!node.executable) fail("reviewed Node source is not executable");
  const inventory = [node, ...npmInventory(source.npmRoot, { immutable })]
    .sort((left, right) => comparePath(left.path, right.path));
  const npmManifest = JSON.parse(readFileSync(resolve(source.npmRoot, "package.json"), "utf8"));
  const runtime = {
    node: nodeVersion,
    nodeExecutableSha256: node.sha256,
    npm: npmManifest.version,
    npmCliSha256: inventory.find(
      (record) => record.path === "lib/node_modules/npm/bin/npm-cli.js",
    )?.sha256,
    toolchainInventorySha256: sha256(JSON.stringify(canonical(inventory))),
    toolchainInventory: inventory,
  };
  validateReviewedToolchainRuntime(runtime);
  return runtime;
}

function sourcePathForRecord(source, record) {
  if (record.path === "bin/node") return source.node;
  const prefix = "lib/node_modules/npm/";
  if (!record.path.startsWith(prefix)) fail("reviewed toolchain record is outside npm");
  const relativePath = record.path.slice(prefix.length);
  const path = resolve(source.npmRoot, relativePath);
  if (path !== source.npmRoot && !path.startsWith(`${source.npmRoot}${sep}`)) {
    fail("reviewed toolchain record escapes npm source");
  }
  return path;
}

function lockSnapshot(root) {
  const directories = [];
  function collect(path) {
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      directories.push(path);
      for (const name of readdirSync(path)) collect(resolve(path, name));
    }
  }
  collect(root);
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) chmodSync(directory, 0o500);
}

function unlockSnapshot(root) {
  function unlock(path) {
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) unlock(resolve(path, name));
    } else if (info.isFile() && !info.isSymbolicLink()) {
      chmodSync(path, 0o600);
    }
  }
  unlock(root);
}

export function stageReviewedToolchain({
  stageRoot,
  sourceNode = process.execPath,
  sourceNpmRoot,
  sourceNodeVersion = process.version,
  expectedRuntime = loadReviewedToolchainPin(),
} = {}) {
  if (!stageRoot) fail("reviewed toolchain stage root is required");
  validateReviewedToolchainRuntime(expectedRuntime);
  const source = resolveToolchainSource({ nodePath: sourceNode, npmRoot: sourceNpmRoot });
  const sourceBefore = inspectReviewedToolchainSource({
    nodePath: source.node,
    npmRoot: source.npmRoot,
    nodeVersion: sourceNodeVersion,
  });
  same(sourceBefore, expectedRuntime, "reviewed Node/npm toolchain source");

  const root = resolve(stageRoot);
  mkdirSync(root, { mode: 0o700 });
  try {
    for (const record of expectedRuntime.toolchainInventory) {
      const sourcePath = sourcePathForRecord(source, record);
      const bytes = readFileSync(sourcePath);
      if (bytes.length !== record.size || sha256(bytes) !== record.sha256) {
        fail(`reviewed toolchain source changed while staging: ${record.path}`);
      }
      const destination = resolve(root, record.path);
      if (!destination.startsWith(`${root}${sep}`)) {
        fail("reviewed toolchain destination escapes its private root");
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, {
        flag: "wx",
        mode: record.executable ? 0o500 : 0o400,
      });
    }
    lockSnapshot(root);
    const sourceAfter = inspectReviewedToolchainSource({
      nodePath: source.node,
      npmRoot: source.npmRoot,
      nodeVersion: sourceNodeVersion,
    });
    same(sourceAfter, expectedRuntime, "reviewed Node/npm toolchain source after staging");
    const snapshotRuntime = inspectReviewedToolchainSource({
      nodePath: resolve(root, "bin/node"),
      npmRoot: resolve(root, "lib/node_modules/npm"),
      nodeVersion: expectedRuntime.node,
      immutable: true,
    });
    same(snapshotRuntime, expectedRuntime, "private reviewed Node/npm toolchain snapshot");
    return {
      root,
      command: resolve(root, "bin/node"),
      cli: resolve(root, "lib/node_modules/npm/bin/npm-cli.js"),
      runtime: snapshotRuntime,
    };
  } catch (error) {
    try {
      unlockSnapshot(root);
    } catch {
      // Preserve the original staging error.
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function verifyReviewedToolchain(toolchain) {
  if (!toolchain?.root || !toolchain?.runtime) {
    fail("one staged reviewed Node/npm toolchain is required");
  }
  const rootInfo = lstatSync(toolchain.root);
  if (
    !rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || (rootInfo.mode & 0o277) !== 0
  ) {
    fail("private reviewed Node/npm toolchain root is mutable or shared");
  }
  const runtime = inspectReviewedToolchainSource({
    nodePath: resolve(toolchain.root, "bin/node"),
    npmRoot: resolve(toolchain.root, "lib/node_modules/npm"),
    nodeVersion: toolchain.runtime.node,
    immutable: true,
  });
  same(runtime, toolchain.runtime, "private reviewed Node/npm toolchain snapshot");
  return runtime;
}

export function reviewedRuntimeIdentity({ toolchain } = {}) {
  return structuredClone(verifyReviewedToolchain(toolchain));
}

export function reviewedNpm(args = [], { toolchain } = {}) {
  verifyReviewedToolchain(toolchain);
  return {
    command: toolchain.command,
    cli: toolchain.cli,
    args: [toolchain.cli, ...args],
  };
}

export function disposeReviewedToolchain(toolchain) {
  if (!toolchain?.root) return;
  try {
    unlockSnapshot(toolchain.root);
  } finally {
    rmSync(toolchain.root, { recursive: true, force: true });
  }
}

export function writeCurrentReviewedToolchainPin(
  path = REVIEWED_TOOLCHAIN_PIN_PATH,
) {
  const runtime = inspectReviewedToolchainSource();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion: 1, kind: TOOLCHAIN_KIND, runtime }, null, 2)}\n`,
    { flag: "wx", mode: 0o644 },
  );
  return runtime;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--write-pin") {
      fail("Usage: reviewed-toolchain.mjs --write-pin");
    }
    const runtime = writeCurrentReviewedToolchainPin();
    process.stdout.write(
      `Pinned Node ${runtime.node} and npm ${runtime.npm} toolchain `
        + `${runtime.toolchainInventorySha256}.\n`,
    );
  } catch (error) {
    process.stderr.write(`OpenDexter reviewed toolchain refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
