#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(scriptRoot, "..");
export const repositoryRoot = resolve(packageRoot, "../..");

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_ARCHIVE_PATH = /^package(?:\/[A-Za-z0-9._@+/-]+)?\/?$/;
const FORBIDDEN_BASENAME = /^(?:\.npmrc|npmrc|credentials?(?:\..*)?|secrets?(?:\..*)?|private[-_.]?key(?:\..*)?|seed[-_.]?phrase(?:\..*)?|mnemonic(?:\..*)?|wallet\.json|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function digestFile(path, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

export function sha512Integrity(path) {
  return `sha512-${digestFile(path, "sha512", "base64")}`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function git(root, args) {
  return run("git", ["-C", root, ...args]);
}

export function repositoryIdentity(root = repositoryRoot, { requireClean = true } = {}) {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (requireClean && status) {
    fail(`release source is not clean:\n${status}`);
  }
  return { commit, tree, clean: status.length === 0 };
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

function sameJson(actual, expected, label) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    fail(`${label} does not match the reviewed source`);
  }
}

export function verifyRootLock({
  repoRoot = repositoryRoot,
  pkgRoot = packageRoot,
  requireTracked = true,
} = {}) {
  const rootLock = resolve(repoRoot, "package-lock.json");
  const nestedLock = resolve(pkgRoot, "package-lock.json");
  if (lstatOrNull(nestedLock)) {
    fail("packages/mcp/package-lock.json is forbidden; npm ci uses the canonical root lock");
  }
  if (requireTracked) {
    try {
      git(repoRoot, ["ls-files", "--error-unmatch", "package-lock.json"]);
    } catch {
      fail("the canonical root package-lock.json is not tracked by Git");
    }
  }

  const rootPackage = readJson(resolve(repoRoot, "package.json"));
  const pkg = readJson(resolve(pkgRoot, "package.json"));
  const lock = readJson(rootLock);
  if (lock.lockfileVersion !== 3) fail("root lockfileVersion must be 3");
  sameJson(lock.packages?.[""]?.workspaces, rootPackage.workspaces, "root lock workspaces");
  const locked = lock.packages?.["packages/mcp"];
  if (!locked) fail("root lock omits packages/mcp");
  if (locked.name !== pkg.name || locked.version !== pkg.version) {
    fail("root lock package identity/version does not match packages/mcp/package.json");
  }
  sameJson(locked.dependencies, pkg.dependencies, "locked runtime dependencies");
  sameJson(locked.devDependencies, pkg.devDependencies, "locked build dependencies");
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!EXACT_VERSION.test(version)) fail(`${name} is not pinned exactly: ${version}`);
  }
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    if (!EXACT_VERSION.test(version)) fail(`${name} build dependency is not exact: ${version}`);
  }
  return {
    path: "package-lock.json",
    sha256: digestFile(rootLock),
    lockfileVersion: lock.lockfileVersion,
    packageCount: Object.keys(lock.packages ?? {}).length,
  };
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function archiveNames(tarball) {
  const raw = run("tar", ["-tzf", tarball, "--quoting-style=escape"]);
  const names = raw ? raw.split("\n") : [];
  const seen = new Set();
  for (const name of names) {
    if (!SAFE_ARCHIVE_PATH.test(name)) fail(`unsafe archive path: ${name}`);
    if (name.includes("//") || name.includes("\\") || name.includes("\0")) {
      fail(`unsafe archive path: ${name}`);
    }
    const parts = name.split("/");
    if (parts.includes("..") || parts.includes(".")) fail(`unsafe archive path: ${name}`);
    if (seen.has(name)) fail(`duplicate archive path: ${name}`);
    seen.add(name);
  }
  return names;
}

function archiveTypes(tarball, expectedCount) {
  const raw = run("tar", ["-tvzf", tarball, "--quoting-style=escape"]);
  const lines = raw ? raw.split("\n") : [];
  if (lines.length !== expectedCount) fail("archive verbose inventory count drifted");
  return lines.map((line) => {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      fail(`archive contains a link or special file (type ${type || "unknown"})`);
    }
    return type;
  });
}

function walk(root, current = root, files = [], directories = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) fail(`extracted package contains symlink: ${path}`);
    if (info.isDirectory()) {
      directories.push(path);
      walk(root, path, files, directories);
      continue;
    }
    if (!info.isFile()) fail(`extracted package contains special file: ${path}`);
    if (info.nlink !== 1) fail(`extracted package contains hard-linked file: ${path}`);
    files.push(path);
  }
  return { files, directories };
}

function relativePackagePath(path, extractedPackageRoot) {
  return relative(extractedPackageRoot, path).split(sep).join("/");
}

function forbiddenPublishedPath(path) {
  const parts = path.split("/");
  if (parts.some((part) => /^\.env(?:\.|$)/i.test(part))) return true;
  if (parts.some((part) => /^(?:\.git|\.github|node_modules)$/i.test(part))) return true;
  if (/\.map$/i.test(path)) return true;
  return FORBIDDEN_BASENAME.test(parts.at(-1));
}

function isDeclaredPath(path, manifest) {
  if (path === "package.json") return true;
  const entries = new Set([
    ...(manifest.files ?? []),
    ...Object.values(manifest.bin ?? {}),
  ]);
  for (const raw of entries) {
    const declared = String(raw).replace(/^\.\//, "").replace(/\/$/, "");
    if (path === declared || path.startsWith(`${declared}/`)) return true;
  }
  return false;
}

function assertPinnedDependencies(manifest) {
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!EXACT_VERSION.test(version)) fail(`${name} is not pinned exactly: ${version}`);
  }
}

export function inspectTarball(tarballPath, {
  sourcePackageRoot = null,
} = {}) {
  const tarball = realpathSync(tarballPath);
  const names = archiveNames(tarball);
  const types = archiveTypes(tarball, names.length);
  const regularArchiveNames = names
    .filter((_name, index) => types[index] === "-")
    .sort();
  const stage = mkdtempSync(join(tmpdir(), "opendexter-tarball-"));

  try {
    execFileSync("tar", ["-xzf", tarball, "-C", stage, "--no-same-owner"], {
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
    const extractedPackageRoot = resolve(stage, "package");
    const { files } = walk(extractedPackageRoot);
    const extractedNames = files
      .map((path) => `package/${relativePackagePath(path, extractedPackageRoot)}`)
      .sort();
    sameJson(extractedNames, regularArchiveNames, "archive and extracted file inventory");

    const manifest = readJson(resolve(extractedPackageRoot, "package.json"));
    if (manifest.name !== "@dexterai/opendexter") fail("unexpected package identity");
    if (!EXACT_VERSION.test(manifest.version)) fail("package version is not exact semver");
    assertPinnedDependencies(manifest);
    const declaredExecutables = new Set(
      Object.values(manifest.bin ?? {}).map((path) => String(path).replace(/^\.\//, "")),
    );

    const inventory = files.map((path) => {
      const relativePath = relativePackagePath(path, extractedPackageRoot);
      const info = statSync(path);
      if (forbiddenPublishedPath(relativePath)) {
        fail(`forbidden publish artifact: ${relativePath}`);
      }
      if (!isDeclaredPath(relativePath, manifest)) {
        fail(`undeclared publish artifact: ${relativePath}`);
      }
      const executable = (info.mode & 0o111) !== 0;
      if (executable && !declaredExecutables.has(relativePath)) {
        fail(`undeclared executable: ${relativePath}`);
      }
      if (declaredExecutables.has(relativePath) && !executable) {
        fail(`declared executable is not executable: ${relativePath}`);
      }
      const record = {
        path: relativePath,
        size: info.size,
        mode: (info.mode & 0o777).toString(8).padStart(3, "0"),
        sha256: digestFile(path),
        executable,
      };
      if (sourcePackageRoot) {
        const sourcePath = resolve(sourcePackageRoot, relativePath);
        const sourceInfo = lstatOrNull(sourcePath);
        if (!sourceInfo?.isFile()) fail(`packed file is absent from build root: ${relativePath}`);
        if (digestFile(sourcePath) !== record.sha256) {
          fail(`packed bytes differ from the reviewed build root: ${relativePath}`);
        }
      }
      return record;
    }).sort((left, right) => left.path.localeCompare(right.path));

    return {
      package: {
        name: manifest.name,
        version: manifest.version,
        dependencies: canonical(manifest.dependencies ?? {}),
        bin: canonical(manifest.bin ?? {}),
      },
      artifact: {
        fileName: basename(tarball),
        size: statSync(tarball).size,
        sha256: digestFile(tarball),
        shasum: digestFile(tarball, "sha1"),
        integrity: sha512Integrity(tarball),
      },
      inventory,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) fail(`${label} is required`);
  return value;
}

export function validateAttestationShape(attestation) {
  if (attestation?.schemaVersion !== 1) fail("unsupported release attestation schema");
  if (attestation?.kind !== "opendexter-coordinated-release/v1") {
    fail("unexpected release attestation kind");
  }
  requireString(attestation.package?.name, "attestation package name");
  requireString(attestation.package?.version, "attestation package version");
  requireString(attestation.package?.distTag, "attestation dist-tag");
  if (!["prerelease", "stable"].includes(attestation.package?.releaseChannel)) {
    fail("attestation release channel must be prerelease or stable");
  }
  requireString(attestation.source?.commit, "attestation source commit");
  requireString(attestation.source?.tree, "attestation source tree");
  requireString(attestation.source?.rootLockSha256, "attestation root lock digest");
  requireString(attestation.artifact?.sha256, "attestation tarball digest");
  requireString(attestation.artifact?.shasum, "attestation tarball shasum");
  requireString(attestation.artifact?.integrity, "attestation registry integrity");
  requireString(attestation.artifact?.fileName, "attestation tarball file name");
  if (!Number.isSafeInteger(attestation.artifact?.size) || attestation.artifact.size <= 0) {
    fail("attestation tarball size is invalid");
  }
  if (!Array.isArray(attestation.inventory) || attestation.inventory.length === 0) {
    fail("attestation file inventory is empty");
  }
  const inventoryPaths = new Set();
  for (const record of attestation.inventory) {
    requireString(record?.path, "attestation inventory path");
    requireString(record?.mode, `attestation inventory mode for ${record?.path ?? "unknown"}`);
    requireString(record?.sha256, `attestation inventory digest for ${record?.path ?? "unknown"}`);
    if (!Number.isSafeInteger(record?.size) || record.size < 0) {
      fail(`attestation inventory size is invalid for ${record?.path ?? "unknown"}`);
    }
    if (typeof record?.executable !== "boolean") {
      fail(`attestation executable flag is invalid for ${record?.path ?? "unknown"}`);
    }
    if (inventoryPaths.has(record.path)) fail(`duplicate attestation inventory path: ${record.path}`);
    inventoryPaths.add(record.path);
  }
  if (attestation.review?.decision !== "accepted") fail("release review is not accepted");
  requireString(attestation.review?.receiptSha256, "review receipt digest");
  if (attestation.noviceRoutingEvaluation?.status !== "passed") {
    fail("novice-language evaluation is not passed");
  }
  requireString(
    attestation.noviceRoutingEvaluation?.evidenceSha256,
    "novice evaluation evidence digest",
  );
  requireString(attestation.hostedContract?.contractSha256, "hosted contract digest");
  return attestation;
}

export function verifyAttestation({
  attestation,
  tarball,
  repoRoot = repositoryRoot,
  pkgRoot = packageRoot,
  reviewReceipt = null,
  noviceEvidence = null,
  requireClean = true,
  requireTrackedLock = true,
}) {
  validateAttestationShape(attestation);
  const identity = repositoryIdentity(repoRoot, { requireClean });
  const lock = verifyRootLock({ repoRoot, pkgRoot, requireTracked: requireTrackedLock });
  const manifest = readJson(resolve(pkgRoot, "package.json"));
  const contractPath = resolve(
    repoRoot,
    "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
  );
  const inspected = inspectTarball(tarball, { sourcePackageRoot: pkgRoot });

  if (attestation.package.name !== manifest.name) fail("attestation package name drifted");
  if (attestation.package.version !== manifest.version) fail("attestation package version drifted");
  if (attestation.source.commit !== identity.commit) fail("attestation source commit drifted");
  if (attestation.source.tree !== identity.tree) fail("attestation source tree drifted");
  if (attestation.source.rootLockSha256 !== lock.sha256) fail("attestation root lock drifted");
  if (attestation.hostedContract.contractSha256 !== digestFile(contractPath)) {
    fail("attestation hosted contract bytes drifted");
  }
  sameJson(attestation.artifact, inspected.artifact, "attested tarball identity");
  sameJson(attestation.inventory, inspected.inventory, "attested tarball inventory");
  if (reviewReceipt && digestFile(reviewReceipt) !== attestation.review.receiptSha256) {
    fail("review receipt bytes do not match the attestation");
  }
  if (noviceEvidence && digestFile(noviceEvidence) !== attestation.noviceRoutingEvaluation.evidenceSha256) {
    fail("novice evaluation bytes do not match the attestation");
  }
  return { identity, lock, inspected };
}

export function verifyRegistryMetadata(attestation, metadata) {
  validateAttestationShape(attestation);
  if (metadata?.name !== attestation.package.name) fail("registry package name mismatch");
  if (metadata?.version !== attestation.package.version) fail("registry version mismatch");
  if (metadata?.dist?.integrity !== attestation.artifact.integrity) {
    fail("registry dist.integrity does not match the reviewed tarball");
  }
  if (metadata?.dist?.shasum !== attestation.artifact.shasum) {
    fail("registry dist.shasum does not match the reviewed tarball");
  }
  return true;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return { command, values };
}

function commandMain() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "inspect") {
    const inspected = inspectTarball(requireString(values.tarball, "--tarball"), {
      sourcePackageRoot: values["package-root"]
        ? resolve(values["package-root"])
        : packageRoot,
    });
    process.stdout.write(`${JSON.stringify(inspected, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const attestationPath = resolve(requireString(values.attestation, "--attestation"));
    const attestation = readJson(attestationPath);
    const result = verifyAttestation({
      attestation,
      tarball: resolve(requireString(values.tarball, "--tarball")),
      reviewReceipt: values.review ? resolve(values.review) : null,
      noviceEvidence: values["novice-evidence"]
        ? resolve(values["novice-evidence"])
        : null,
    });
    process.stdout.write(
      `Verified ${attestation.package.name}@${attestation.package.version} `
        + `${result.inspected.artifact.integrity}\n`,
    );
    return;
  }
  if (command === "verify-registry") {
    const attestation = readJson(resolve(requireString(values.attestation, "--attestation")));
    const metadata = readJson(resolve(requireString(values.metadata, "--metadata")));
    verifyRegistryMetadata(attestation, metadata);
    process.stdout.write(
      `Registry integrity matches ${attestation.package.name}@${attestation.package.version}.\n`,
    );
    return;
  }
  fail("Usage: package-provenance.mjs inspect|verify|verify-registry ...");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    commandMain();
  } catch (error) {
    process.stderr.write(`OpenDexter provenance refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
