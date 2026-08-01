#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "../../..");
const contractPath = resolve(
  repositoryRoot,
  "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
);
const DESCRIPTOR_PATH = "release/open-tool-descriptors.json";
const DESCRIPTOR_MATERIALIZER_PATH = "scripts/materialize-open-tool-descriptors.mjs";
export const EXPECTED_HOSTED_SOURCE_REPOSITORY =
  "https://github.com/Dexter-DAO/dexter-mcp";

function fail(message) {
  throw new Error(message);
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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
    fail(`${label} differs from the final hosted source descriptor`);
  }
}

function requireNonemptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
}

function validateJsonSchema(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a materialized JSON Schema object`);
  }
  if (typeof value.type !== "string" && typeof value.$ref !== "string" && !Array.isArray(value.anyOf)) {
    fail(`${label} lacks a materialized type, $ref, or anyOf`);
  }
}

function requireUniqueStringArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} is required`);
  for (const item of value) requireNonemptyString(item, `${label} entry`);
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
  return value;
}

function schemeTypes(tool) {
  return new Set(tool.securitySchemes.map((scheme) => scheme?.type));
}

function canonicalGithubRepository(value) {
  requireNonemptyString(value, "hosted source origin");
  const trimmed = value.trim();
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed)
    ?? /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed)
    ?? /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match) fail("hosted source origin is not a canonical GitHub repository");
  return `https://github.com/${match[1]}/${match[2]}`;
}

export function verifyHostedRepositoryIdentity(origin) {
  const canonicalOrigin = canonicalGithubRepository(origin);
  if (
    canonicalOrigin.toLowerCase()
    !== EXPECTED_HOSTED_SOURCE_REPOSITORY.toLowerCase()
  ) {
    fail(
      `hosted source repository is ${canonicalOrigin}, expected `
      + EXPECTED_HOSTED_SOURCE_REPOSITORY,
    );
  }
  return EXPECTED_HOSTED_SOURCE_REPOSITORY;
}

export function validateHostedDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1) fail("unsupported hosted descriptor schema");
  if (descriptor?.kind !== "opendexter-hosted-tool-descriptors/v1") {
    fail("unexpected hosted descriptor kind");
  }
  for (const field of [
    "anonymousToolNames",
    "oauthPromotedToolNames",
    "connectedToolNames",
    "optionalOAuthToolNames",
  ]) {
    requireUniqueStringArray(descriptor[field], `hosted descriptor ${field}`);
  }
  if (!Array.isArray(descriptor.tools)) fail("hosted descriptor tools is required");
  const names = descriptor.tools.map((tool) => tool?.name);
  for (const name of names) requireNonemptyString(name, "hosted tool name");
  if (new Set(names).size !== names.length) fail("hosted descriptor has duplicate tools");
  same(names, descriptor.connectedToolNames, "hosted descriptor connected roster order");
  same(
    [...new Set([...descriptor.anonymousToolNames, ...descriptor.oauthPromotedToolNames])].sort(),
    [...descriptor.connectedToolNames].sort(),
    "hosted descriptor anonymous/OAuth roster union",
  );
  const connected = new Set(descriptor.connectedToolNames);
  for (const [label, roster] of [
    ["anonymous", descriptor.anonymousToolNames],
    ["OAuth-promoted", descriptor.oauthPromotedToolNames],
    ["optional-OAuth", descriptor.optionalOAuthToolNames],
  ]) {
    if (roster.some((name) => !connected.has(name))) {
      fail(`hosted descriptor ${label} roster is not a connected-tool subset`);
    }
  }
  if (
    descriptor.anonymousToolNames.some((name) =>
      descriptor.oauthPromotedToolNames.includes(name),
    )
  ) {
    fail("hosted descriptor anonymous and OAuth-promoted rosters overlap");
  }
  for (const tool of descriptor.tools) {
    requireNonemptyString(tool?.title, `${tool?.name ?? "unknown"} title`);
    requireNonemptyString(tool?.description, `${tool?.name ?? "unknown"} description`);
    validateJsonSchema(tool?.inputSchema, `${tool.name} inputSchema`);
    if (tool.inputSchema.type !== "object") {
      fail(`${tool.name} inputSchema must have top-level type object`);
    }
    validateJsonSchema(tool?.outputSchema, `${tool.name} outputSchema`);
    if (!Array.isArray(tool.securitySchemes) || tool.securitySchemes.length === 0) {
      fail(`${tool.name} securitySchemes are required`);
    }
    for (const scheme of tool.securitySchemes) {
      if (!scheme || typeof scheme !== "object" || Array.isArray(scheme)) {
        fail(`${tool.name} security scheme is invalid`);
      }
      if (scheme.type !== "noauth" && scheme.type !== "oauth2") {
        fail(`${tool.name} security scheme type is invalid`);
      }
    }
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      if (typeof tool.annotations?.[hint] !== "boolean") fail(`${tool.name} ${hint} is required`);
    }
    if (!Array.isArray(tool.visibility) || tool.visibility.length === 0) {
      fail(`${tool.name} visibility is required`);
    }
    if (typeof tool.widgetAccessible !== "boolean") {
      fail(`${tool.name} widgetAccessible is required`);
    }
  }
  const actualOptionalOAuth = descriptor.tools
    .filter((tool) => {
      const types = schemeTypes(tool);
      return types.has("noauth") && types.has("oauth2");
    })
    .map((tool) => tool.name);
  same(
    descriptor.optionalOAuthToolNames,
    actualOptionalOAuth,
    "hosted descriptor optional-OAuth roster",
  );
  return descriptor;
}

export function verifyMaterializedHostedDescriptor(descriptor, materialized) {
  const committed = validateHostedDescriptor(descriptor);
  const actual = validateHostedDescriptor(materialized);
  same(
    committed,
    actual,
    "committed hosted descriptor and finalized source materialization",
  );
  return committed;
}

function buildContract({ descriptor, sourceRoot, commit, tree }) {
  const previous = readJson(contractPath);
  return {
    ...previous,
    schemaVersion: 2,
    contractId: "opendexter-hosted-full-descriptor-v2",
    source: {
      repository: EXPECTED_HOSTED_SOURCE_REPOSITORY,
      commit,
      tree,
      descriptorPath: DESCRIPTOR_PATH,
      descriptorMaterializerPath: DESCRIPTOR_MATERIALIZER_PATH,
      toolContractPath: "lib/open-tool-contracts.mjs",
      authContractPath: "lib/open-tool-auth.mjs",
    },
    anonymousToolNames: descriptor.anonymousToolNames,
    oauthPromotedToolNames: descriptor.oauthPromotedToolNames,
    connectedToolNames: descriptor.connectedToolNames,
    optionalOAuthToolNames: descriptor.optionalOAuthToolNames,
    tools: descriptor.tools,
  };
}

export async function verifyHostedSource({ sourceRoot, mode = "check" }) {
  const root = realpathSync(sourceRoot);
  verifyHostedRepositoryIdentity(git(root, ["remote", "get-url", "origin"]));
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail(`hosted source is not clean:\n${status}`);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  try {
    git(root, ["ls-files", "--error-unmatch", DESCRIPTOR_PATH]);
  } catch {
    fail(`${DESCRIPTOR_PATH} is not committed in the final hosted source`);
  }
  try {
    git(root, ["ls-files", "--error-unmatch", DESCRIPTOR_MATERIALIZER_PATH]);
  } catch {
    fail(`${DESCRIPTOR_MATERIALIZER_PATH} is not committed in the final hosted source`);
  }
  const committedDescriptor = readJson(resolve(root, DESCRIPTOR_PATH));
  const materializer = await import(
    `${pathToFileURL(resolve(root, DESCRIPTOR_MATERIALIZER_PATH)).href}?commit=${commit}`
  );
  if (typeof materializer.materializeOpenToolDescriptors !== "function") {
    fail(
      `${DESCRIPTOR_MATERIALIZER_PATH} must export materializeOpenToolDescriptors()`,
    );
  }
  const descriptor = verifyMaterializedHostedDescriptor(
    committedDescriptor,
    await materializer.materializeOpenToolDescriptors(),
  );
  const contracts = await import(
    `${pathToFileURL(resolve(root, "lib/open-tool-contracts.mjs")).href}?commit=${commit}`
  );
  same(contracts.OPEN_ANONYMOUS_TOOL_NAMES, descriptor.anonymousToolNames, "anonymous roster");
  same(contracts.OPEN_OAUTH_PROMOTED_TOOL_NAMES, descriptor.oauthPromotedToolNames, "OAuth roster");
  same(contracts.OPEN_TOOL_NAMES, descriptor.connectedToolNames, "connected roster");
  const sourceOptionalOAuth = contracts.OPEN_TOOL_NAMES.filter((name) => {
    const types = schemeTypes(contracts.OPEN_TOOL_CONTRACTS?.[name]);
    return types.has("noauth") && types.has("oauth2");
  });
  same(
    sourceOptionalOAuth,
    descriptor.optionalOAuthToolNames,
    "source optional-OAuth roster",
  );
  for (const expected of descriptor.tools) {
    const actual = contracts.OPEN_TOOL_CONTRACTS?.[expected.name];
    if (!actual) fail(`OPEN_TOOL_CONTRACTS omits ${expected.name}`);
    for (const field of [
      "title",
      "description",
      "securitySchemes",
      "annotations",
      "visibility",
      "widgetAccessible",
    ]) {
      same(actual[field], expected[field], `${expected.name} ${field}`);
    }
  }

  const nextContract = buildContract({ descriptor, sourceRoot: root, commit, tree });
  if (mode === "write") {
    writeFileSync(contractPath, `${JSON.stringify(nextContract, null, 2)}\n`);
  } else if (mode === "check") {
    same(readJson(contractPath), nextContract, "pinned IDE hosted contract");
  } else {
    fail(`unknown hosted-source verification mode: ${mode}`);
  }
  return { commit, tree, descriptorPath: DESCRIPTOR_PATH, contract: nextContract };
}

function parseArgs(argv) {
  const mode = argv.includes("--write") ? "write" : "check";
  const sourceIndex = argv.indexOf("--source");
  const source = sourceIndex >= 0 ? argv[sourceIndex + 1] : process.env.OPENDXTER_HOSTED_SOURCE_ROOT;
  if (!source) fail("--source or OPENDXTER_HOSTED_SOURCE_ROOT is required");
  if (!isAbsolute(source)) fail("hosted source root must be absolute");
  return { mode, source };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { mode, source } = parseArgs(process.argv.slice(2));
    const result = await verifyHostedSource({ sourceRoot: source, mode });
    process.stdout.write(
      `${mode === "write" ? "Pinned" : "Verified"} hosted descriptors at `
        + `${result.commit}/${result.tree}.\n`,
    );
  } catch (error) {
    process.stderr.write(`OpenDexter hosted-source gate refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
