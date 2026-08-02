#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTreePureArchive,
  listCanonicalRemoteRefs,
} from "./verify-hosted-source.mjs";
import {
  loadReviewedToolchainPin,
  REVIEWED_RELEASE_NPM_VERSION,
  reviewedNpm,
  reviewedRuntimeIdentity,
  validateReviewedToolchainRuntime,
} from "./reviewed-toolchain.mjs";

export {
  REVIEWED_RELEASE_NPM_VERSION,
  reviewedNpm,
  reviewedRuntimeIdentity,
} from "./reviewed-toolchain.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(scriptRoot, "..");
export const repositoryRoot = resolve(packageRoot, "../..");

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_ARCHIVE_PATH = /^package(?:\/[A-Za-z0-9._@+/-]+)?\/?$/;
const FORBIDDEN_BASENAME = /^(?:\.npmrc|npmrc|credentials?(?:\..*)?|secrets?(?:\..*)?|private[-_.]?key(?:\..*)?|seed[-_.]?phrase(?:\..*)?|mnemonic(?:\..*)?|wallet\.json|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
export const EXPECTED_RELEASE_SOURCE_REPOSITORY =
  "https://github.com/Dexter-DAO/opendexter-ide";
const EXPECTED_RELEASE_SOURCE_ORIGIN = `${EXPECTED_RELEASE_SOURCE_REPOSITORY}.git`;
export const RELEASE_BUILD_RECIPE =
  "pinned-private-node-npm-toolchain+sterile-bare-git-archive+npm-ci-ignore-scripts+workspace-build+immutable-hosted-widgets+npm-pack-once/v3";
export const RELEASE_REGISTRY = "https://registry.npmjs.org/";
export const RELEASE_WIDGET_FILES = Object.freeze([
  "x402-marketplace-search.html",
  "x402-fetch-result.html",
  "x402-pricing.html",
  "x402-wallet.html",
]);

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

function git(root, args, options = {}) {
  return run("git", ["--no-replace-objects", "-C", root, ...args], options);
}

function canonicalGithubRepository(value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("release source origin is required");
  }
  const trimmed = value.trim();
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed)
    ?? /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed)
    ?? /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match) fail("release source origin is not a canonical GitHub repository");
  return `https://github.com/${match[1]}/${match[2]}`;
}

export function verifyReleaseRepositoryIdentity(origin) {
  const canonicalOrigin = canonicalGithubRepository(origin);
  if (
    canonicalOrigin.toLowerCase()
    !== EXPECTED_RELEASE_SOURCE_REPOSITORY.toLowerCase()
  ) {
    fail(
      `release source repository is ${canonicalOrigin}, expected `
      + EXPECTED_RELEASE_SOURCE_REPOSITORY,
    );
  }
  return EXPECTED_RELEASE_SOURCE_REPOSITORY;
}

export function reviewedReleaseEnvironment({ npmCache, home, nodeBin } = {}) {
  const forbidden = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "TAR_OPTIONS",
    ...Object.keys(process.env).filter((key) => key.startsWith("LD_")),
  ];
  for (const key of new Set(forbidden)) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) {
      fail(`release environment contains ${key}`);
    }
  }
  const reviewedNodeBin = nodeBin
    ? realpathSync(nodeBin)
    : dirname(realpathSync(process.execPath));
  return Object.fromEntries(Object.entries({
    PATH: [
      reviewedNodeBin,
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ].filter((entry, index, entries) => entries.indexOf(entry) === index)
      .join(delimiter),
    HOME: home ?? process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null.opendexter-release-global-npmrc",
    npm_config_cache: npmCache,
  }).filter(([, value]) => value !== undefined));
}

function requirePublishTag(tag) {
  if (typeof tag !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag)) {
    fail("reviewed npm publish tag is invalid");
  }
  return tag;
}

export function reviewedNpmPublishInvocation({
  tarball,
  tag,
  dryRun = false,
  toolchain,
}) {
  const exactTarball = realpathSync(tarball);
  const args = ["publish"];
  if (dryRun) args.push("--dry-run", "--json");
  args.push(
    "--ignore-scripts",
    "--provenance",
    "--access",
    "public",
    "--registry",
    RELEASE_REGISTRY,
    "--tag",
    requirePublishTag(tag),
    exactTarball,
  );
  return { ...reviewedNpm(args, { toolchain }), tarball: exactTarball };
}

export function canonicalReleaseRemoteRefs({
  environment = reviewedReleaseEnvironment(),
  listRefs = listCanonicalRemoteRefs,
} = {}) {
  return listRefs(EXPECTED_RELEASE_SOURCE_ORIGIN, {
    cwd: tmpdir(),
    environment,
  });
}

function remoteAdvertisesCommit(remoteRefs, commit) {
  return remoteRefs.split(/\r?\n/).some((line) => {
    const [remoteCommit, refname, extra] = line.trim().split(/\s+/);
    return remoteCommit === commit && Boolean(refname) && extra === undefined;
  });
}

export function repositoryIdentity(
  root = repositoryRoot,
  {
    requireClean = true,
    advertisedRefs = null,
    environment = reviewedReleaseEnvironment(),
  } = {},
) {
  const resolvedRoot = realpathSync(root);
  const topLevel = realpathSync(git(
    resolvedRoot,
    ["rev-parse", "--show-toplevel"],
    { env: environment },
  ));
  if (topLevel !== resolvedRoot) fail("release source root is not the Git toplevel");
  verifyReleaseRepositoryIdentity(git(
    resolvedRoot,
    ["remote", "get-url", "origin"],
    { env: environment },
  ));
  const status = git(resolvedRoot, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ], { env: environment });
  if (requireClean && status) {
    fail(`release source is not clean:\n${status}`);
  }
  const hidden = git(resolvedRoot, ["ls-files", "-v", "-z"], {
    env: environment,
  }).split("\0").filter((entry) => /^[a-zS] /.test(entry));
  if (hidden.length > 0) {
    fail("release source contains assume-unchanged or skip-worktree state");
  }
  const replaceRefs = git(
    resolvedRoot,
    ["for-each-ref", "--format=%(refname)", "refs/replace"],
    { env: environment },
  );
  if (replaceRefs) fail("release source contains Git replace refs");
  const commit = git(resolvedRoot, ["rev-parse", "HEAD^{commit}"], {
    env: environment,
  });
  const tree = git(resolvedRoot, ["rev-parse", "HEAD^{tree}"], {
    env: environment,
  });
  const remoteRefs = advertisedRefs ?? canonicalReleaseRemoteRefs({ environment });
  if (!remoteAdvertisesCommit(remoteRefs, commit)) {
    fail("canonical release source does not advertise HEAD");
  }
  return {
    repository: EXPECTED_RELEASE_SOURCE_REPOSITORY,
    commit,
    tree,
    clean: status.length === 0,
  };
}

export function createReviewedSourceArchive({
  root,
  commit,
  tree,
  output,
  disposableRoot,
  environment = reviewedReleaseEnvironment(),
}) {
  createTreePureArchive({
    root,
    commit,
    tree,
    output,
    disposableRoot,
    cleanEnvironment: environment,
  });
  return digestFile(output);
}

export function reviewedSourceArchiveDigest({
  root,
  commit,
  tree,
  environment = reviewedReleaseEnvironment(),
}) {
  const disposableRoot = mkdtempSync(join(tmpdir(), "opendexter-release-source-"));
  const archive = resolve(disposableRoot, "source.tar");
  const gitStage = resolve(disposableRoot, "git");
  try {
    // createTreePureArchive requires one dedicated Git staging directory.
    mkdirSync(gitStage);
    return createReviewedSourceArchive({
      root,
      commit,
      tree,
      output: archive,
      disposableRoot: gitStage,
      environment,
    });
  } finally {
    rmSync(disposableRoot, { recursive: true, force: true });
  }
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

export function canonicalJsonDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function reviewedWidgetInventory(widgetRoot) {
  const rootInfo = lstatSync(widgetRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("reviewed hosted widget root is not one real directory");
  }
  const root = realpathSync(widgetRoot);
  const inventory = RELEASE_WIDGET_FILES.map((path) => {
    const source = resolve(root, path);
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail(`reviewed hosted widget is not one regular file: ${path}`);
    }
    return {
      path,
      size: info.size,
      sha256: digestFile(source),
    };
  });
  return {
    inventory,
    digest: canonicalJsonDigest(inventory),
  };
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
  if (rootPackage.packageManager !== `npm@${REVIEWED_RELEASE_NPM_VERSION}`) {
    fail("root packageManager does not pin the reviewed npm version");
  }
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

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} is not one SHA-256 digest`);
  }
  return value;
}

export function validateAttestationShape(attestation) {
  if (attestation?.schemaVersion !== 3) fail("unsupported release attestation schema");
  if (attestation?.kind !== "opendexter-coordinated-release/v3") {
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
  if (attestation.source?.repository !== EXPECTED_RELEASE_SOURCE_REPOSITORY) {
    fail("attestation source repository is unexpected");
  }
  requireSha256(attestation.source?.archiveSha256, "attestation source archive digest");
  requireSha256(attestation.source?.rootLockSha256, "attestation root lock digest");
  if (attestation.build?.sourceMaterial !== "archive") {
    fail("attestation source material is unsupported");
  }
  if (attestation.build?.recipe !== RELEASE_BUILD_RECIPE) {
    fail("attestation build recipe is unsupported");
  }
  const attestedRuntime = attestedRuntimeIdentity(attestation);
  validateReviewedToolchainRuntime(attestedRuntime);
  sameJson(
    attestedRuntime,
    loadReviewedToolchainPin(),
    "attested Node/npm toolchain source pin",
  );
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
  if (
    attestation.hostedContract?.sourceRepository
    !== "https://github.com/Dexter-DAO/dexter-mcp"
  ) {
    fail("attestation hosted source repository is unexpected");
  }
  requireString(attestation.hostedContract?.sourceCommit, "hosted source commit");
  requireString(attestation.hostedContract?.sourceTree, "hosted source tree");
  if (attestation.hostedContract?.descriptorPath !== "release/open-tool-descriptors.json") {
    fail("attestation hosted descriptor path is unexpected");
  }
  if (attestation.hostedContract?.widgetSourcePath !== "public/apps-sdk") {
    fail("attestation hosted widget source path is unexpected");
  }
  requireSha256(
    attestation.hostedContract?.sourceArchiveSha256,
    "hosted source archive digest",
  );
  requireSha256(
    attestation.hostedContract?.widgetSourceDigest,
    "hosted widget source digest",
  );
  if (
    !Array.isArray(attestation.hostedContract?.widgetInventory)
    || attestation.hostedContract.widgetInventory.length !== RELEASE_WIDGET_FILES.length
  ) {
    fail("attestation hosted widget inventory is incomplete");
  }
  const widgetPaths = [];
  for (const record of attestation.hostedContract.widgetInventory) {
    requireString(record?.path, "attestation hosted widget path");
    if (!Number.isSafeInteger(record?.size) || record.size < 0) {
      fail(`attestation hosted widget size is invalid for ${record?.path ?? "unknown"}`);
    }
    requireSha256(
      record?.sha256,
      `attestation hosted widget digest for ${record?.path ?? "unknown"}`,
    );
    widgetPaths.push(record.path);
  }
  sameJson(widgetPaths, RELEASE_WIDGET_FILES, "attestation hosted widget paths");
  if (
    canonicalJsonDigest(attestation.hostedContract.widgetInventory)
    !== attestation.hostedContract.widgetSourceDigest
  ) {
    fail("attestation hosted widget inventory digest is inconsistent");
  }
  return attestation;
}

export function attestedRuntimeIdentity(attestation) {
  return {
    node: attestation?.build?.node,
    nodeExecutableSha256: attestation?.build?.nodeExecutableSha256,
    npm: attestation?.build?.npm,
    npmCliSha256: attestation?.build?.npmCliSha256,
    toolchainInventorySha256: attestation?.build?.toolchainInventorySha256,
    toolchainInventory: attestation?.build?.toolchainInventory,
  };
}

export function verifyAttestation({
  attestation,
  tarball,
  rebuilt,
  reviewReceipt = null,
  noviceEvidence = null,
}) {
  validateAttestationShape(attestation);
  if (!rebuilt?.inspected || !rebuilt?.identity || !rebuilt?.hosted) {
    fail("attestation verification requires one deterministic sterile rebuild");
  }
  const inspected = inspectTarball(tarball);

  if (attestation.package.name !== rebuilt.manifest.name) {
    fail("attestation package name drifted");
  }
  if (attestation.package.version !== rebuilt.manifest.version) {
    fail("attestation package version drifted");
  }
  if (attestation.source.commit !== rebuilt.identity.commit) {
    fail("attestation source commit drifted");
  }
  if (attestation.source.tree !== rebuilt.identity.tree) {
    fail("attestation source tree drifted");
  }
  if (attestation.source.archiveSha256 !== rebuilt.sourceArchiveSha256) {
    fail("attestation source archive drifted");
  }
  if (attestation.source.rootLockSha256 !== rebuilt.lock.sha256) {
    fail("attestation root lock drifted");
  }
  sameJson(
    attestedRuntimeIdentity(attestation),
    rebuilt.runtime,
    "attested build runtime identity",
  );
  if (attestation.hostedContract.sourceCommit !== rebuilt.hosted.commit) {
    fail("attestation hosted source commit drifted");
  }
  if (attestation.hostedContract.sourceTree !== rebuilt.hosted.tree) {
    fail("attestation hosted source tree drifted");
  }
  if (attestation.hostedContract.descriptorPath !== rebuilt.hosted.descriptorPath) {
    fail("attestation hosted descriptor path drifted");
  }
  if (
    attestation.hostedContract.sourceArchiveSha256
    !== rebuilt.hosted.sourceArchiveSha256
  ) {
    fail("attestation hosted source archive drifted");
  }
  if (attestation.hostedContract.contractSha256 !== rebuilt.hosted.contractSha256) {
    fail("attestation hosted contract bytes drifted");
  }
  sameJson(
    attestation.hostedContract.widgetInventory,
    rebuilt.hosted.widgetInventory,
    "attested hosted widget inventory",
  );
  if (
    attestation.hostedContract.widgetSourceDigest
    !== rebuilt.hosted.widgetSourceDigest
  ) {
    fail("attestation hosted widget source digest drifted");
  }
  sameJson(inspected.artifact, rebuilt.inspected.artifact, "candidate and rebuilt tarball identity");
  sameJson(inspected.inventory, rebuilt.inspected.inventory, "candidate and rebuilt full inventory");
  sameJson(attestation.artifact, inspected.artifact, "attested tarball identity");
  sameJson(attestation.inventory, inspected.inventory, "attested tarball inventory");
  if (reviewReceipt && digestFile(reviewReceipt) !== attestation.review.receiptSha256) {
    fail("review receipt bytes do not match the attestation");
  }
  if (noviceEvidence && digestFile(noviceEvidence) !== attestation.noviceRoutingEvaluation.evidenceSha256) {
    fail("novice evaluation bytes do not match the attestation");
  }
  return { identity: rebuilt.identity, lock: rebuilt.lock, inspected, rebuilt };
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

async function commandMain() {
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
    const { verifyRebuiltReleaseCandidate } = await import(
      "./build-release-candidate.mjs"
    );
    const result = await verifyRebuiltReleaseCandidate({
      attestationPath,
      expectedAttestationSha256: digestFile(attestationPath),
      candidateTarball: resolve(requireString(values.tarball, "--tarball")),
      reviewReceipt: resolve(requireString(values.review, "--review")),
      noviceEvidence: resolve(
        requireString(values["novice-evidence"], "--novice-evidence"),
      ),
      hostedSource: resolve(
        requireString(values["hosted-source"], "--hosted-source"),
      ),
    });
    process.stdout.write(
      `Verified ${result.attestation.package.name}@${result.attestation.package.version} `
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
    await commandMain();
  } catch (error) {
    process.stderr.write(`OpenDexter provenance refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
