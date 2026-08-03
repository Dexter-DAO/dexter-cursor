#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildReviewedReleaseArtifact,
  installExactArtifact,
} from "./build-release-candidate.mjs";
import {
  canonicalJsonDigest,
  digestFile,
  inspectTarball,
  packageRoot,
  RELEASE_BUILD_RECIPE,
  RELEASE_WIDGET_FILES,
  repositoryIdentity,
  repositoryRoot,
  sha512Integrity,
  verifyRootLock,
} from "./package-provenance.mjs";
import {
  disposeReviewedToolchain,
  loadReviewedToolchainPin,
  validateReviewedToolchainRuntime,
} from "./reviewed-toolchain.mjs";
import { releaseChannel } from "./release-policy.mjs";
import {
  EXPECTED_PUBLIC_HOSTED_REPOSITORY,
  PUBLIC_HOSTED_CONTRACT_PATH,
  PUBLIC_HOSTED_CONTRACT_RELATIVE_PATH,
  validatePublicHostedContract,
  verifyFrozenPublicHostedSource,
} from "./public-hosted-release.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(
  packageRoot,
  "release/github-hosted-release.json",
);
const hostedContractPath = PUBLIC_HOSTED_CONTRACT_PATH;
const releaseWorkflowPath = ".github/workflows/publish-opendexter.yml";

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
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
    fail(`${label} differs`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  same(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required`);
  }
  return value;
}

function requireSha(value, length, label) {
  if (
    typeof value !== "string"
    || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function git(root, args) {
  return run("/usr/bin/git", ["--no-replace-objects", "-C", root, ...args], {
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: process.env.HOME,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
}

function npmEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null.opendexter-github-release",
    ...extra,
  };
}

export function validateHostedReleaseConfig(config) {
  exactKeys(config, [
    "schemaVersion",
    "kind",
    "repository",
    "package",
    "runner",
    "publisher",
    "actions",
  ], "release config");
  if (
    config.schemaVersion !== 3
    || config.kind !== "opendexter-github-release/v3"
  ) {
    fail("release config schema is unsupported");
  }
  if (config.repository !== "Dexter-DAO/opendexter-ide") {
    fail("release repository is not canonical");
  }
  same(config.package, {
    name: "@dexterai/opendexter",
    root: "packages/mcp",
    distTag: "next",
    tagPrefix: "opendexter-v",
  }, "package policy");
  same(config.runner, {
    label: "ubuntu-24.04",
    containerImage: "node:22.19.0-bookworm@sha256:"
      + "f2bf1588ef7e8dd183d9e4cb4330a0d952204b7348ead42afb1aab11f9c4911b",
    node: "v22.19.0",
    npm: "10.9.3",
  }, "builder policy");
  same(config.publisher, {
    environment: "opendexter-npm-production",
    workflowPath: releaseWorkflowPath,
    npm: "11.5.1",
    npmPackageIntegrity:
      "sha512-Iy5vXZ55m8tIaSCz6bqQf9+W5XbPfoyURsgWLjOkFglqHTep6RDZqRj2sfYGeRyZvGu2HuJWm0lux0rxPQ29lQ==",
    npmPackageShasum: "83b06a00dae2a8e5d72dc951ddf56a2e0dbf2cc1",
    registry: "https://registry.npmjs.org/",
    provenancePredicate: "https://slsa.dev/provenance/v1",
  }, "publisher policy");
  same(config.actions, {
    checkout: "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    uploadArtifact:
      "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4",
    downloadArtifact:
      "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0",
  }, "action pins");
  return config;
}

function loadConfig(path = defaultConfigPath) {
  return validateHostedReleaseConfig(readJson(realpathSync(path)));
}

function validateHostedContract(contract) {
  return validatePublicHostedContract(contract);
}

export function validateReleaseInvocation({
  config,
  repository,
  ref,
  refType,
  refName,
  sha,
  eventName,
  tagObjectSha,
  tagCommitSha,
  identity,
  containerImage,
  packageManifest,
  hostedContract,
}) {
  validateHostedReleaseConfig(config);
  if (repository !== config.repository) fail("workflow repository differs");
  if (refType !== "tag") fail("release workflow must run from a tag");
  const expectedTag = `${config.package.tagPrefix}${packageManifest?.version ?? ""}`;
  if (refName !== expectedTag || ref !== `refs/tags/${expectedTag}`) {
    fail("release tag does not exactly match package version");
  }
  requireSha(sha, 40, "GITHUB_SHA");
  requireSha(tagObjectSha, 40, "release tag object");
  requireSha(tagCommitSha, 40, "release tag commit");
  if (!["push", "workflow_dispatch"].includes(eventName)) {
    fail("release workflow event is unsupported");
  }
  if (sha !== tagObjectSha && sha !== tagCommitSha) {
    fail("GITHUB_SHA is neither the tag object nor its resolved commit");
  }
  if (tagCommitSha !== identity?.commit) {
    fail("release tag does not resolve to the checked-out commit");
  }
  requireSha(identity?.tree, 40, "checked-out tree");
  if (containerImage !== config.runner.containerImage) {
    fail("workflow container differs from the pinned image");
  }
  if (process.env.GITHUB_ACTIONS === "true" && process.version !== config.runner.node) {
    fail("workflow Node version differs from the pinned runtime");
  }
  if (packageManifest?.name !== config.package.name) fail("package name differs");
  if (packageManifest?.publishConfig?.tag !== config.package.distTag) {
    fail("package dist-tag differs");
  }
  const channel = releaseChannel(packageManifest.version);
  if (
    (channel === "prerelease" && config.package.distTag === "latest")
    || (channel === "stable" && config.package.distTag !== "latest")
  ) {
    fail("package version and dist-tag channel differ");
  }
  const hosted = validateHostedContract(hostedContract);
  return {
    schemaVersion: 3,
    kind: "opendexter-release-context/v3",
    repository,
    releaseTag: expectedTag,
    tag: {
      ref: `refs/tags/${expectedTag}`,
      name: expectedTag,
      objectSha: tagObjectSha,
      commitSha: tagCommitSha,
    },
    commit: identity.commit,
    tree: identity.tree,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
      releaseChannel: channel,
      distTag: config.package.distTag,
    },
    runner: config.runner,
    hosted: {
      ...hosted.release,
      contractSha256: canonicalJsonDigest(hosted),
    },
  };
}

function validateHostedReleaseIdentity(source, label) {
  exactKeys(source, [
    "repository",
    "commit",
    "tree",
    "artifactManifestSha256",
    "descriptorSha256",
    "packageVersion",
    "contractSha256",
  ], label);
  if (source.repository !== EXPECTED_PUBLIC_HOSTED_REPOSITORY) {
    fail(`${label} repository differs`);
  }
  requireSha(source.commit, 40, `${label} commit`);
  requireSha(source.tree, 40, `${label} tree`);
  requireSha(
    source.artifactManifestSha256,
    64,
    `${label} artifact manifest digest`,
  );
  requireSha(source.descriptorSha256, 64, `${label} descriptor digest`);
  requireSha(source.contractSha256, 64, `${label} contract digest`);
  requireString(source.packageVersion, `${label} package version`);
  return source;
}

export function validateContext(context, config = loadConfig()) {
  if (
    context?.schemaVersion !== 3
    || context?.kind !== "opendexter-release-context/v3"
  ) {
    fail("release context schema is unsupported");
  }
  exactKeys(context, [
    "schemaVersion",
    "kind",
    "repository",
    "releaseTag",
    "tag",
    "commit",
    "tree",
    "package",
    "runner",
    "hosted",
  ], "release context");
  if (context.repository !== config.repository) fail("context repository differs");
  exactKeys(context.package, [
    "name",
    "version",
    "releaseChannel",
    "distTag",
  ], "context package");
  if (
    context.releaseTag
      !== `${config.package.tagPrefix}${context.package?.version ?? ""}`
    || context.package?.name !== config.package.name
    || context.package?.distTag !== config.package.distTag
  ) {
    fail("release context package identity differs");
  }
  if (releaseChannel(context.package.version) !== context.package.releaseChannel) {
    fail("context package release channel differs");
  }
  requireSha(context.commit, 40, "context commit");
  requireSha(context.tree, 40, "context tree");
  exactKeys(
    context.tag,
    ["ref", "name", "objectSha", "commitSha"],
    "context tag",
  );
  if (
    context.tag.name !== context.releaseTag
    || context.tag.ref !== `refs/tags/${context.releaseTag}`
    || context.tag.commitSha !== context.commit
  ) {
    fail("context tag identity differs");
  }
  requireSha(context.tag.objectSha, 40, "context tag object");
  requireSha(context.tag.commitSha, 40, "context tag commit");
  same(context.runner, config.runner, "context runner");
  validateHostedReleaseIdentity(context.hosted, "context hosted release");
  return context;
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

function absolute(values, key) {
  const value = requireString(values[key], `--${key}`);
  if (!isAbsolute(value)) fail(`--${key} must be absolute`);
  return realpathSync(value);
}

function outputPath(values, key) {
  const value = requireString(values[key], `--${key}`);
  if (!isAbsolute(value)) fail(`--${key} must be absolute`);
  return value;
}

function githubOutput(values, entries) {
  if (!values["github-output"]) return;
  const output = values["github-output"];
  if (!isAbsolute(output)) fail("--github-output must be absolute");
  writeFileSync(
    output,
    `${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    { flag: "a" },
  );
}

function assertExactTagOnMain(context) {
  const tagObject = git(repositoryRoot, [
    "rev-parse",
    `refs/tags/${context.releaseTag}^{object}`,
  ]);
  const tagCommit = git(repositoryRoot, [
    "rev-parse",
    `refs/tags/${context.releaseTag}^{commit}`,
  ]);
  if (tagObject !== context.tag.objectSha) fail("tag object differs from context");
  if (tagCommit !== context.tag.commitSha) fail("tag commit differs from context");
  try {
    git(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      context.commit,
      "refs/remotes/origin/main",
    ]);
  } catch {
    fail("release tag commit is not on origin/main");
  }
}

function validatePublishCheckout(context) {
  const identity = repositoryIdentity(repositoryRoot, { requireClean: true });
  if (identity.commit !== context.commit || identity.tree !== context.tree) {
    fail("publish checkout differs from the frozen release source");
  }
  const objectSha = git(repositoryRoot, [
    "rev-parse",
    `${context.tag.ref}^{object}`,
  ]);
  const commitSha = git(repositoryRoot, [
    "rev-parse",
    `${context.tag.ref}^{commit}`,
  ]);
  if (
    objectSha !== context.tag.objectSha
    || commitSha !== context.tag.commitSha
  ) {
    fail("publish checkout tag differs from the frozen tag identity");
  }
}

function commandContext(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const manifest = readJson(resolve(packageRoot, "package.json"));
  const identity = repositoryIdentity(repositoryRoot, { requireClean: true });
  const releaseTag = process.env.GITHUB_REF_NAME;
  const context = validateReleaseInvocation({
    config,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    sha: process.env.GITHUB_SHA,
    eventName: process.env.GITHUB_EVENT_NAME,
    tagObjectSha: git(repositoryRoot, [
      "rev-parse",
      `refs/tags/${releaseTag}^{object}`,
    ]),
    tagCommitSha: git(repositoryRoot, [
      "rev-parse",
      `refs/tags/${releaseTag}^{commit}`,
    ]),
    identity,
    containerImage: process.env.OPENDXTER_RELEASE_CONTAINER_IMAGE,
    packageManifest: manifest,
    hostedContract: readJson(hostedContractPath),
  });
  assertExactTagOnMain(context);
  writeJson(outputPath(values, "output"), context);
  githubOutput(values, {
    version: context.package.version,
    dist_tag: context.package.distTag,
    release_tag: context.releaseTag,
    mcp_commit: context.hosted.commit,
    artifact_name: `opendexter-package-${context.commit}`,
  });
  return context;
}

function validatePackInventory(inventory) {
  const paths = inventory.map(({ path }) => path).sort();
  const expectedWidgets = ["assets/widgets", "dist/widgets"]
    .flatMap((root) => RELEASE_WIDGET_FILES.map((name) => `${root}/${name}`))
    .sort();
  const actualWidgets = paths
    .filter((path) => /^(?:assets|dist)\/widgets\/[^/]+\.html$/.test(path))
    .sort();
  same(actualWidgets, expectedWidgets, "published widget inventory");
  if (paths.some((path) => path.endsWith(".map"))) {
    fail("published package contains source maps");
  }
  if (paths.some((path) => /(?:^|\/)(?:compose-cards|card-widget-meta)\.d\.ts$|(?:^|\/)tools\/cards\//.test(path))) {
    fail("published package contains retired card registrar declarations");
  }
}

async function commandBuild(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const context = validateContext(readJson(absolute(values, "context")), config);
  const identity = repositoryIdentity(repositoryRoot, { requireClean: true });
  if (identity.commit !== context.commit || identity.tree !== context.tree) {
    fail("build source differs from the frozen context");
  }
  assertExactTagOnMain(context);
  const mcpRoot = absolute(values, "mcp-root");
  const frozenHostedContract = validateHostedContract(readJson(hostedContractPath));
  if (canonicalJsonDigest(frozenHostedContract) !== context.hosted.contractSha256) {
    fail("tagged hosted contract differs from the frozen context");
  }
  const hosted = await verifyFrozenPublicHostedSource({
    sourceRoot: mcpRoot,
    contract: frozenHostedContract,
  });
  if (
    hosted.commit !== context.hosted.commit
    || hosted.tree !== context.hosted.tree
    || hosted.descriptorSha256 !== context.hosted.descriptorSha256
    || hosted.artifactManifestSha256
      !== context.hosted.artifactManifestSha256
  ) {
    fail("verified hosted source differs from the frozen context");
  }
  const rootLock = verifyRootLock({ requireTracked: true });
  const bundle = outputPath(values, "output");
  if (existsSync(bundle)) fail("release bundle output already exists");
  mkdirSync(bundle);
  const stage = mkdtempSync(resolve(tmpdir(), "opendexter-release-once-"));
  let built = null;
  try {
    built = buildReviewedReleaseArtifact({
      sourceRoot: repositoryRoot,
      identity,
      expectedLockSha256: rootLock.sha256,
      hostedSource: mcpRoot,
      hosted,
      hostedContractRelativePath: PUBLIC_HOSTED_CONTRACT_RELATIVE_PATH,
      stageRoot: stage,
      outputRoot: bundle,
      runValidation: true,
    });
    if (
      built.manifest.name !== context.package.name
      || built.manifest.version !== context.package.version
    ) {
      fail("built package identity differs from the frozen context");
    }
    validatePackInventory(built.inspected.inventory);
    const exactTarballInstall = installExactArtifact({
      tarball: built.tarball,
      ignoreScripts: true,
      toolchain: built.toolchain,
    });
    same(exactTarballInstall, {
      package: context.package.name,
      version: context.package.version,
      ignoredScripts: true,
      cliHelpVerified: true,
    }, "fresh exact-tarball install");
    const receipt = {
      schemaVersion: 3,
      kind: "opendexter-npm-release/v3",
      context,
      sourceContract: {
        schemaVersion: 2,
        kind: "opendexter-hosted-release-pin/v2",
        hostedContractSha256: canonicalJsonDigest(hosted.contract),
        hosted: context.hosted,
      },
      build: {
        recipe: RELEASE_BUILD_RECIPE,
        sourceArchiveSha256: built.sourceArchiveSha256,
        rootLockSha256: built.lock.sha256,
        runtime: built.runtime,
        validation: [
          "test",
          "typecheck",
          "build",
          "pack-inventory",
          "fresh-install-exact-tarball",
          "opendexter-help",
        ],
        exactTarballInstall,
      },
      artifact: built.inspected.artifact,
      inventory: built.inspected.inventory,
      inventoryDigest: canonicalJsonDigest(built.inspected.inventory),
      provenance: {
        repository: `https://github.com/${config.repository}`,
        workflowPath: config.publisher.workflowPath,
        ref: `refs/tags/${context.releaseTag}`,
        predicateType: config.publisher.provenancePredicate,
      },
    };
    writeJson(resolve(bundle, "release.json"), receipt);
    githubOutput(values, {
      bundle,
      tarball_sha256: receipt.artifact.sha256,
      release_sha256: digestFile(resolve(bundle, "release.json")),
      version: context.package.version,
    });
    return receipt;
  } finally {
    disposeReviewedToolchain(built?.toolchain);
    rmSync(stage, { recursive: true, force: true });
  }
}

function exactBundle(root) {
  const entries = readdirSync(root).sort();
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1 || !entries.includes("release.json") || entries.length !== 2) {
    fail("release bundle must contain exactly one tarball and release.json");
  }
  for (const entry of entries) {
    const info = lstatSync(resolve(root, entry));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail(`release bundle entry is not one regular file: ${entry}`);
    }
  }
  return {
    tarball: resolve(root, tarballs[0]),
    receipt: resolve(root, "release.json"),
  };
}

export function validateReleaseReceipt(receipt, config = loadConfig()) {
  if (
    receipt?.schemaVersion !== 3
    || receipt?.kind !== "opendexter-npm-release/v3"
  ) {
    fail("release receipt schema is unsupported");
  }
  exactKeys(receipt, [
    "schemaVersion",
    "kind",
    "context",
    "sourceContract",
    "build",
    "artifact",
    "inventory",
    "inventoryDigest",
    "provenance",
  ], "release receipt");
  const context = validateContext(receipt.context, config);

  exactKeys(receipt.sourceContract, [
    "schemaVersion",
    "kind",
    "hostedContractSha256",
    "hosted",
  ], "source contract receipt");
  if (
    receipt.sourceContract.schemaVersion !== 2
    || receipt.sourceContract.kind !== "opendexter-hosted-release-pin/v2"
  ) {
    fail("source contract receipt schema is unsupported");
  }
  const hosted = validateHostedReleaseIdentity(
    receipt.sourceContract.hosted,
    "receipt hosted release",
  );
  same(hosted, context.hosted, "receipt hosted release and context");
  requireSha(
    receipt.sourceContract.hostedContractSha256,
    64,
    "hosted contract digest",
  );
  if (
    receipt.sourceContract.hostedContractSha256
      !== context.hosted.contractSha256
  ) {
    fail("hosted contract receipt digest differs from the frozen context");
  }

  exactKeys(receipt.build, [
    "recipe",
    "sourceArchiveSha256",
    "rootLockSha256",
    "runtime",
    "validation",
    "exactTarballInstall",
  ], "release build receipt");
  if (receipt.build.recipe !== RELEASE_BUILD_RECIPE) {
    fail("release build recipe differs");
  }
  requireSha(receipt.build.sourceArchiveSha256, 64, "source archive digest");
  requireSha(receipt.build.rootLockSha256, 64, "root lock digest");
  validateReviewedToolchainRuntime(receipt.build.runtime);
  same(receipt.build.runtime, loadReviewedToolchainPin(), "release build runtime");
  same(receipt.build.validation, [
    "test",
    "typecheck",
    "build",
    "pack-inventory",
    "fresh-install-exact-tarball",
    "opendexter-help",
  ], "release validations");
  same(receipt.build.exactTarballInstall, {
    package: context.package.name,
    version: context.package.version,
    ignoredScripts: true,
    cliHelpVerified: true,
  }, "exact-tarball install receipt");

  exactKeys(receipt.artifact, [
    "fileName",
    "size",
    "sha256",
    "shasum",
    "integrity",
  ], "release artifact");
  requireSha(receipt.artifact.sha256, 64, "release artifact SHA-256");
  requireSha(receipt.artifact.shasum, 40, "release artifact shasum");
  requireString(receipt.artifact.integrity, "release artifact integrity");
  if (!Number.isSafeInteger(receipt.artifact.size) || receipt.artifact.size <= 0) {
    fail("release artifact size is invalid");
  }
  if (!Array.isArray(receipt.inventory) || receipt.inventory.length === 0) {
    fail("release artifact inventory is empty");
  }
  requireSha(receipt.inventoryDigest, 64, "release inventory digest");

  exactKeys(receipt.provenance, [
    "repository",
    "workflowPath",
    "ref",
    "predicateType",
  ], "release provenance");
  same(receipt.provenance, {
    repository: `https://github.com/${config.repository}`,
    workflowPath: config.publisher.workflowPath,
    ref: context.tag.ref,
    predicateType: config.publisher.provenancePredicate,
  }, "canonical release provenance");
  return receipt;
}

export function validatePublishBundle({
  root,
  expectedTarballSha256,
  expectedReleaseSha256,
  config,
  environment = process.env,
}) {
  const files = exactBundle(root);
  const receipt = validateReleaseReceipt(readJson(files.receipt), config);
  const context = receipt.context;
  requireSha(expectedTarballSha256, 64, "expected tarball SHA-256");
  requireSha(expectedReleaseSha256, 64, "expected release receipt SHA-256");
  if (
    digestFile(files.tarball) !== expectedTarballSha256
    || receipt.artifact?.sha256 !== expectedTarballSha256
  ) {
    fail("downloaded tarball SHA-256 differs from the build job");
  }
  if (digestFile(files.receipt) !== expectedReleaseSha256) {
    fail("downloaded release receipt SHA-256 differs from the build job");
  }
  const inspected = inspectTarball(files.tarball);
  same(inspected.artifact, receipt.artifact, "downloaded artifact identity");
  same(inspected.inventory, receipt.inventory, "downloaded artifact inventory");
  if (canonicalJsonDigest(receipt.inventory) !== receipt.inventoryDigest) {
    fail("downloaded artifact inventory digest differs");
  }
  validatePackInventory(receipt.inventory);
  if (
    environment.GITHUB_REPOSITORY !== config.repository
    || environment.GITHUB_REF !== context.tag.ref
    || environment.GITHUB_REF_TYPE !== "tag"
    || environment.GITHUB_REF_NAME !== context.tag.name
    || !["push", "workflow_dispatch"].includes(environment.GITHUB_EVENT_NAME)
    || (
      environment.GITHUB_SHA !== context.tag.objectSha
      && environment.GITHUB_SHA !== context.tag.commitSha
    )
    || environment.OPENDXTER_RELEASE_CONTAINER_IMAGE
      !== config.runner.containerImage
  ) {
    fail("publish job context differs from the frozen release");
  }
  return { files, receipt };
}

function commandPublishInput(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const root = absolute(values, "bundle");
  const result = validatePublishBundle({
    root,
    expectedTarballSha256: values["tarball-sha256"],
    expectedReleaseSha256: values["release-sha256"],
    config,
  });
  validatePublishCheckout(result.receipt.context);
  githubOutput(values, {
    tarball: result.files.tarball,
    version: result.receipt.context.package.version,
    package_name: result.receipt.context.package.name,
    dist_tag: result.receipt.context.package.distTag,
    integrity: result.receipt.artifact.integrity,
    shasum: result.receipt.artifact.shasum,
  });
  return result;
}

function commandPublisherNpm(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  for (const name of [
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "OPENDXTER_RELEASE_NPM_TOKEN",
  ]) {
    if (process.env[name]) fail(`${name} must be absent from OIDC publish`);
  }
  if (
    process.env.GITHUB_ACTIONS !== "true"
    || process.env.OPENDXTER_RELEASE_ENVIRONMENT
      !== config.publisher.environment
    || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    fail("publisher is not inside the protected GitHub OIDC environment");
  }
  if (process.version !== config.runner.node) fail("publisher Node version drifted");
  const output = outputPath(values, "output");
  if (existsSync(output)) fail("npm publisher output already exists");
  mkdirSync(output);
  const npmVersion = run("npm", ["--version"], { env: npmEnvironment() });
  if (npmVersion !== config.runner.npm) fail("bootstrap npm version drifted");
  const raw = run("npm", [
    "pack",
    `npm@${config.publisher.npm}`,
    "--json",
    "--ignore-scripts",
    `--pack-destination=${output}`,
    `--registry=${config.publisher.registry}`,
  ], { cwd: output, env: npmEnvironment() });
  const [packed] = JSON.parse(raw);
  const tarball = resolve(output, packed.filename);
  if (
    sha512Integrity(tarball) !== config.publisher.npmPackageIntegrity
    || digestFile(tarball, "sha1") !== config.publisher.npmPackageShasum
  ) {
    fail("downloaded npm publisher bytes differ from the pinned CLI");
  }
  const extracted = resolve(output, "npm");
  mkdirSync(extracted);
  run("/usr/bin/tar", ["-xzf", tarball, "-C", extracted, "--no-same-owner"]);
  const npmRoot = resolve(extracted, "package");
  const manifest = readJson(resolve(npmRoot, "package.json"));
  if (manifest.name !== "npm" || manifest.version !== config.publisher.npm) {
    fail("pinned npm publisher package identity differs");
  }
  const npmCli = realpathSync(resolve(npmRoot, "bin/npm-cli.js"));
  githubOutput(values, { npm_cli: npmCli });
  return { npmCli, tarball };
}

function integritySha512Hex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) fail("release integrity is not SHA-512 SRI");
  return Buffer.from(match[1], "base64").toString("hex");
}

export function validateProvenanceStatement({ statement, receipt }) {
  if (
    statement?._type !== "https://in-toto.io/Statement/v1"
    || statement?.predicateType !== receipt.provenance.predicateType
  ) {
    fail("registry provenance statement type differs");
  }
  const expectedSubject = `pkg:npm/${receipt.context.package.name.replace("@", "%40")}`
    + `@${receipt.context.package.version}`;
  const subject = statement.subject?.find((entry) => entry?.name === expectedSubject);
  if (
    !subject
    || subject.digest?.sha512 !== integritySha512Hex(receipt.artifact.integrity)
  ) {
    fail("registry provenance subject differs from the exact tarball");
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (
    workflow?.repository !== receipt.provenance.repository
    || workflow?.path !== receipt.provenance.workflowPath
    || workflow?.ref !== receipt.provenance.ref
  ) {
    fail("registry provenance workflow identity differs");
  }
  const builder = statement.predicate?.runDetails?.builder?.id;
  if (builder !== "https://github.com/actions/runner/github-hosted") {
    fail("registry provenance builder differs");
  }
  return true;
}

async function verifyRegistryProvenance(metadata, receipt) {
  const config = loadConfig();
  const attestations = metadata?.dist?.attestations;
  if (
    attestations?.provenance?.predicateType
      !== config.publisher.provenancePredicate
  ) {
    fail("registry metadata lacks SLSA provenance");
  }
  const url = new URL(requireString(attestations.url, "attestation URL"));
  if (
    url.protocol !== "https:"
    || url.hostname !== "registry.npmjs.org"
    || !url.pathname.startsWith("/-/npm/v1/attestations/")
  ) {
    fail("registry attestation URL is not canonical");
  }
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) fail(`registry attestation endpoint returned HTTP ${response.status}`);
  const body = await response.json();
  const provenance = body?.attestations?.find(
    (entry) => entry?.predicateType === config.publisher.provenancePredicate,
  );
  const payload = provenance?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") fail("registry provenance bundle is incomplete");
  let statement;
  try {
    statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    fail("registry provenance payload is invalid");
  }
  validateProvenanceStatement({ statement, receipt });
  return { url: url.href, predicateType: provenance.predicateType };
}

export function validateRegistryIdentity({
  receipt,
  metadata,
  packument,
  requireDistTag,
}) {
  if (
    metadata?.name !== receipt.context.package.name
    || metadata?.version !== receipt.context.package.version
    || metadata?.dist?.integrity !== receipt.artifact.integrity
    || metadata?.dist?.shasum !== receipt.artifact.shasum
  ) {
    fail("published version exists with different immutable bytes");
  }
  const currentDistTag = packument?.["dist-tags"]?.[receipt.context.package.distTag];
  if (requireDistTag && currentDistTag !== receipt.context.package.version) {
    fail("registry dist-tag does not resolve to the published version");
  }
  return { currentDistTag: currentDistTag ?? null };
}

export function registryPublishDecision(state) {
  if (state === "absent") return true;
  if (state === "same") return false;
  fail("registry state is unsupported");
}

async function fetchRegistryState(receipt, { requireDistTag }) {
  const config = loadConfig();
  const encodedName = encodeURIComponent(receipt.context.package.name);
  const encodedVersion = encodeURIComponent(receipt.context.package.version);
  const [versionResponse, packumentResponse] = await Promise.all([
    fetch(`${config.publisher.registry}${encodedName}/${encodedVersion}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    }),
    fetch(`${config.publisher.registry}${encodedName}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    }),
  ]);
  if (versionResponse.status === 404) return { state: "absent" };
  if (!versionResponse.ok || !packumentResponse.ok) {
    fail(`registry returned HTTP ${versionResponse.status}/${packumentResponse.status}`);
  }
  const [metadata, packument] = await Promise.all([
    versionResponse.json(),
    packumentResponse.json(),
  ]);
  const { currentDistTag } = validateRegistryIdentity({
    receipt,
    metadata,
    packument,
    requireDistTag,
  });
  const provenance = await verifyRegistryProvenance(metadata, receipt);
  return {
    state: "same",
    integrity: metadata.dist.integrity,
    shasum: metadata.dist.shasum,
    currentDistTag: currentDistTag ?? null,
    provenance,
  };
}

async function commandRegistry(values) {
  const config = loadConfig(values.config ?? defaultConfigPath);
  const root = absolute(values, "bundle");
  const { receipt } = validatePublishBundle({
    root,
    expectedTarballSha256: values["tarball-sha256"],
    expectedReleaseSha256: values["release-sha256"],
    config,
  });
  const mode = values.mode;
  if (!new Set(["preflight", "reconcile"]).has(mode)) {
    fail("--mode must be preflight or reconcile");
  }
  const requireDistTag = values["require-dist-tag"] === "true";
  const attempts = mode === "reconcile" ? 15 : 1;
  let state;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      state = await fetchRegistryState(receipt, { requireDistTag });
      if (state.state === "same" || mode === "preflight") break;
      lastError = new Error("published version is not visible yet");
    } catch (error) {
      lastError = error;
      if (mode === "preflight") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 4_000));
  }
  if (!state || (mode === "reconcile" && state.state !== "same")) {
    throw lastError ?? new Error("registry reconciliation timed out");
  }
  if (values.output) writeJson(outputPath(values, "output"), {
    schemaVersion: 1,
    kind: "opendexter-registry-reconciliation/v1",
    package: receipt.context.package,
    artifact: receipt.artifact,
    registry: state,
  });
  githubOutput(values, {
    state: state.state,
    should_publish: registryPublishDecision(state.state) ? "true" : "false",
  });
  return state;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  if (command === "context") return commandContext(values);
  if (command === "build") return commandBuild(values);
  if (command === "publish-input") return commandPublishInput(values);
  if (command === "publisher-npm") return commandPublisherNpm(values);
  if (command === "registry") return commandRegistry(values);
  fail(
    "Usage: github-hosted-release.mjs "
      + "context|build|publish-input|publisher-npm|registry",
  );
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`OpenDexter release refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
