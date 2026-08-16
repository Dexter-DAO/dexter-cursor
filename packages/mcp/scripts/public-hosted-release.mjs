#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_HOSTED_SOURCE_REPOSITORY,
  buildHostedContract,
  cloneCanonicalHostedSourceAt,
  inspectArchivedHostedSourceEvidence,
  inspectHostedSourceCheckout,
  materializeArchivedPublicHostedSource,
  PUBLIC_HOSTED_MATERIALIZATION_RECIPE,
  validatePublicHostedDescriptor,
  verifyMaterializedHostedDescriptor,
} from "./verify-hosted-source.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "../../..");
export const PUBLIC_HOSTED_HEALTH_URL = "https://open.dexter.cash/health";
export const PUBLIC_HOSTED_CONTRACT_RELATIVE_PATH = "packages/mcp/release/hosted-public-release.json";
export const PUBLIC_HOSTED_CONTRACT_PATH = resolve(
  repositoryRoot,
  PUBLIC_HOSTED_CONTRACT_RELATIVE_PATH,
);
export const PUBLIC_HOSTED_PLUGIN_CONTRACT_RELATIVE_PATH =
  "plugins/opendexter/skills/opendexter/references/hosted-contract.json";
export const PUBLIC_HOSTED_PLUGIN_CONTRACT_PATH = resolve(
  repositoryRoot,
  PUBLIC_HOSTED_PLUGIN_CONTRACT_RELATIVE_PATH,
);
export const EXPECTED_PUBLIC_HOSTED_REPOSITORY = EXPECTED_HOSTED_SOURCE_REPOSITORY;
const PUBLIC_MATERIALIZATION_RECIPE = PUBLIC_HOSTED_MATERIALIZATION_RECIPE;
const DESCRIPTOR_PATH = "release/open-tool-descriptors.json";
const DESCRIPTOR_MATERIALIZER_PATH = "scripts/materialize-open-tool-descriptors.mjs";
const WIDGET_SOURCE_PATH = "public/apps-sdk";
const HEALTH_SERVICE = "dexter-open-mcp";

function fail(message) { throw new Error(message); }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
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
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value;
}

function requireHex(value, length, label) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

export function validatePublicHostedHealth(document) {
  if (
    document?.ok !== true
    || document?.service !== HEALTH_SERVICE
    || document?.release?.service !== HEALTH_SERVICE
  ) fail("public hosted health does not identify the accepted MCP service");
  const release = document.release;
  requireHex(release.commit, 40, "hosted release commit");
  requireHex(release.tree, 40, "hosted release tree");
  requireHex(release.artifactManifestSha256, 64, "hosted artifact manifest digest");
  requireHex(release.descriptorSha256, 64, "hosted descriptor digest");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.packageVersion ?? "")) {
    fail("hosted release package version is invalid");
  }
  return Object.freeze({
    healthUrl: PUBLIC_HOSTED_HEALTH_URL,
    service: HEALTH_SERVICE,
    repository: EXPECTED_PUBLIC_HOSTED_REPOSITORY,
    commit: release.commit,
    tree: release.tree,
    artifactManifestSha256: release.artifactManifestSha256,
    descriptorSha256: release.descriptorSha256,
    packageVersion: release.packageVersion,
  });
}

async function fetchPublicHostedHealth(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") fail("public hosted health fetch is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetchImpl(PUBLIC_HOSTED_HEALTH_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    fail(`public hosted health returned HTTP ${response?.status ?? "unknown"}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 128 * 1024) {
    fail("public hosted health body size is invalid");
  }
  try {
    return validatePublicHostedHealth(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) fail("public hosted health body is invalid JSON");
    throw error;
  }
}

function buildPublicHostedContract({ release, descriptor, materialization }) {
  const { sourceContracts, ...projection } = descriptor;
  if (!sourceContracts || typeof sourceContracts !== "object" || Array.isArray(sourceContracts)) {
    fail("public MCP descriptor lacks source-owned provenance");
  }
  const publicDescriptor = validatePublicHostedDescriptor(projection);
  return {
    schemaVersion: 1,
    kind: "opendexter-public-hosted-release/v1",
    health: { url: release.healthUrl, service: release.service },
    release: {
      repository: release.repository,
      commit: release.commit,
      tree: release.tree,
      artifactManifestSha256: release.artifactManifestSha256,
      descriptorSha256: release.descriptorSha256,
      packageVersion: release.packageVersion,
    },
    source: {
      descriptorPath: DESCRIPTOR_PATH,
      descriptorMaterializerPath: DESCRIPTOR_MATERIALIZER_PATH,
      widgetSourcePath: WIDGET_SOURCE_PATH,
    },
    materialization: {
      recipe: PUBLIC_MATERIALIZATION_RECIPE,
      node: materialization.node,
      npm: materialization.npm,
      packageLockSha256: materialization.packageLockSha256,
      sourceArchiveSha256: materialization.sourceArchiveSha256,
    },
    publicDescriptor,
  };
}

export function validatePublicHostedContract(contract) {
  exactKeys(contract, [
    "schemaVersion", "kind", "health", "release", "source",
    "materialization", "publicDescriptor",
  ], "public hosted release contract");
  if (
    contract.schemaVersion !== 1
    || contract.kind !== "opendexter-public-hosted-release/v1"
  ) fail("public hosted release contract schema is unsupported");
  same(contract.health, {
    url: PUBLIC_HOSTED_HEALTH_URL,
    service: HEALTH_SERVICE,
  }, "public hosted health identity");
  exactKeys(contract.release, [
    "repository", "commit", "tree", "artifactManifestSha256",
    "descriptorSha256", "packageVersion",
  ], "public hosted release identity");
  if (contract.release.repository !== EXPECTED_PUBLIC_HOSTED_REPOSITORY) {
    fail("public hosted release repository differs");
  }
  requireHex(contract.release.commit, 40, "public hosted release commit");
  requireHex(contract.release.tree, 40, "public hosted release tree");
  requireHex(contract.release.artifactManifestSha256, 64, "artifact manifest digest");
  requireHex(contract.release.descriptorSha256, 64, "descriptor digest");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(contract.release.packageVersion ?? "")) {
    fail("public hosted package version is invalid");
  }
  same(contract.source, {
    descriptorPath: DESCRIPTOR_PATH,
    descriptorMaterializerPath: DESCRIPTOR_MATERIALIZER_PATH,
    widgetSourcePath: WIDGET_SOURCE_PATH,
  }, "public hosted source paths");
  exactKeys(contract.materialization, [
    "recipe", "node", "npm", "packageLockSha256", "sourceArchiveSha256",
  ], "public hosted materialization");
  if (contract.materialization.recipe !== PUBLIC_MATERIALIZATION_RECIPE) {
    fail("public hosted materialization recipe differs");
  }
  requireString(contract.materialization.node, "public hosted Node version");
  requireString(contract.materialization.npm, "public hosted npm version");
  requireHex(contract.materialization.packageLockSha256, 64, "package lock digest");
  requireHex(contract.materialization.sourceArchiveSha256, 64, "source archive digest");
  validatePublicHostedDescriptor(contract.publicDescriptor);
  return contract;
}

async function inspectAcceptedPublicHostedSource({
  sourceRoot,
  release,
  verifyCanonicalAdvertisement = true,
  reconstructDescriptor = true,
}) {
  const checkout = inspectHostedSourceCheckout({
    sourceRoot,
    verifyCanonicalAdvertisement,
  });
  if (checkout.commit !== release.commit || checkout.tree !== release.tree) {
    fail("public hosted checkout differs from the accepted release");
  }
  const archived = await (reconstructDescriptor
    ? materializeArchivedPublicHostedSource
    : inspectArchivedHostedSourceEvidence)({
      ...checkout,
      recipe: PUBLIC_MATERIALIZATION_RECIPE,
    });
  if (reconstructDescriptor) {
    verifyMaterializedHostedDescriptor(
      archived.committedDescriptor,
      archived.materializedDescriptor,
    );
  }
  if (archived.materialization.descriptorSha256 !== release.descriptorSha256) {
    fail("public descriptor differs from the accepted release");
  }
  if (readJson(resolve(checkout.root, "package.json")).version !== release.packageVersion) {
    fail("public MCP package version differs from the accepted release");
  }
  return { checkout, archived, descriptor: archived.committedDescriptor };
}

async function inspectPublicHostedSource(options) {
  const { archived, descriptor } = await inspectAcceptedPublicHostedSource(options);
  return buildPublicHostedContract({
    release: options.release,
    descriptor,
    materialization: archived.materialization,
  });
}

async function inspectPublicHostedPluginSource(options) {
  const { checkout, archived, descriptor } = await inspectAcceptedPublicHostedSource({
    ...options,
    reconstructDescriptor: true,
  });
  return buildHostedContract({
    descriptor,
    commit: checkout.commit,
    tree: checkout.tree,
    materialization: archived.materialization,
    manifestVersion: options.release.packageVersion,
  });
}

export async function verifyFrozenPublicHostedSource({ sourceRoot, contract } = {}) {
  const expected = validatePublicHostedContract(
    contract ?? readJson(PUBLIC_HOSTED_CONTRACT_PATH),
  );
  const actual = await inspectPublicHostedSource({
    sourceRoot,
    release: {
      healthUrl: expected.health.url,
      service: expected.health.service,
      ...expected.release,
    },
    verifyCanonicalAdvertisement: false,
    reconstructDescriptor: false,
  });
  same(actual, expected, "frozen public hosted release contract");
  return {
    commit: expected.release.commit,
    tree: expected.release.tree,
    descriptorPath: expected.source.descriptorPath,
    descriptorSha256: expected.release.descriptorSha256,
    artifactManifestSha256: expected.release.artifactManifestSha256,
    packageVersion: expected.release.packageVersion,
    contract: expected,
  };
}

function writeContract(path, contract) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.hosted-public-release-${process.pid}.tmp`);
  if (existsSync(temporary)) fail("public hosted contract temporary file exists");
  try {
    writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function prepareAcceptedHostedContract({
  sourceRoot,
  outputPath,
  fetchImpl = globalThis.fetch,
  inspectSource,
  releaseIdentity,
  writeOutput = writeContract,
}) {
  if (!isAbsolute(outputPath)) fail("public hosted contract output must be absolute");
  const release = await fetchPublicHostedHealth(fetchImpl);
  const workspace = sourceRoot
    ? null
    : mkdtempSync(resolve(tmpdir(), "opendexter-public-hosted-prep-"));
  try {
    const exactRoot = sourceRoot
      ? realpathSync(sourceRoot)
      : cloneCanonicalHostedSourceAt({ commit: release.commit, workspace });
    const contract = await inspectSource({ sourceRoot: exactRoot, release });
    const identity = releaseIdentity(contract);
    if (identity?.commit !== release.commit || identity?.tree !== release.tree) {
      fail("prepared hosted contract differs from the accepted release identity");
    }
    writeOutput(outputPath, contract);
    return { outputPath, sourceRoot: exactRoot, contract };
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
}

export async function preparePublicHostedContract(options = {}) {
  return prepareAcceptedHostedContract({
    ...options,
    outputPath: options.outputPath ?? PUBLIC_HOSTED_CONTRACT_PATH,
    inspectSource: options.inspectSource ?? inspectPublicHostedSource,
    releaseIdentity: (contract) => contract?.release,
  });
}

export async function preparePublicHostedPluginContract(options = {}) {
  return prepareAcceptedHostedContract({
    ...options,
    outputPath: options.outputPath ?? PUBLIC_HOSTED_PLUGIN_CONTRACT_PATH,
    inspectSource: options.inspectSource ?? inspectPublicHostedPluginSource,
    releaseIdentity: (contract) => contract?.source,
  });
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!["prepare", "prepare-plugin"].includes(command)) {
    fail(
      "Usage: public-hosted-release.mjs <prepare|prepare-plugin> "
        + "[--mcp-root /absolute/path] [--output /absolute/path]",
    );
  }
  const values = {};
  while (argv.length > 0) {
    const key = argv.shift();
    const value = argv.shift();
    if (!["--mcp-root", "--output"].includes(key) || !value) {
      fail(`invalid preparation argument: ${key ?? "missing"}`);
    }
    if (!isAbsolute(value)) fail(`${key} must be absolute`);
    values[key.slice(2)] = value;
  }
  return { command, ...values };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parseArgs(process.argv.slice(2));
    const prepare = values.command === "prepare-plugin"
      ? preparePublicHostedPluginContract
      : preparePublicHostedContract;
    const result = await prepare({
      sourceRoot: values["mcp-root"],
      outputPath: values.output,
    });
    const identity = values.command === "prepare-plugin"
      ? result.contract.source
      : result.contract.release;
    process.stdout.write(
      `Prepared ${result.outputPath} from accepted hosted MCP `
        + `${identity.commit}/${identity.tree}.\n`,
    );
  } catch (error) {
    process.stderr.write(`OpenDexter hosted preparation refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
