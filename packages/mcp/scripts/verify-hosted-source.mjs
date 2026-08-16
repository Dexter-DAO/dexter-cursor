#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REVIEWED_RELEASE_NPM_VERSION,
} from "./reviewed-toolchain.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "../../..");
const contractPath = resolve(
  repositoryRoot,
  "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
);
const DESCRIPTOR_PATH = "release/open-tool-descriptors.json";
const DESCRIPTOR_MATERIALIZER_PATH = "scripts/materialize-open-tool-descriptors.mjs";
const REVIEWED_NPM_VERSION = REVIEWED_RELEASE_NPM_VERSION;
const DESCRIPTOR_KIND = "opendexter-hosted-tool-descriptors/v2";
const SOURCE_CONTRACTS_KIND = "opendexter-source-contracts/v3";
const EXPECTED_API_REPOSITORY = "https://github.com/Dexter-DAO/dexter-api";
const EXPECTED_FACILITATOR_REPOSITORY =
  "https://github.com/Dexter-DAO/dexter-facilitator";
const PORTFOLIO_PROJECTION_SOURCE_PATHS = Object.freeze([
  "src/portfolio/approvedActionTargets.ts",
  "src/routes/passkeyMcpBinding.ts",
  "src/routes/defaultGovernedDelegatedAssetActions.ts",
]);
const MATERIALIZATION_RECIPE =
  "mcp-source-owned-outer-receipt+sterile-bare-git-archive+npm-ci-ignore-scripts+workspace-build+source-materializer/v3";
export const PUBLIC_HOSTED_MATERIALIZATION_RECIPE =
  "accepted-public-health+canonical-mcp-git+sterile-source-materializer/v1";
const FORBIDDEN_HOSTED_TOOL_NAMES = Object.freeze([
  "x402_pay",
  "x402_compose_skill",
  "promote_skill",
  "dexter_passkey_probe",
  "dexter_passkey",
  "dexter_authorize_asset_action",
]);
const FORBIDDEN_HOSTED_TOOL_PATTERNS = Object.freeze(["^card_"]);
const FORBIDDEN_GUIDANCE_PATTERNS = Object.freeze([
  "pairing_url",
  "/mcp/dlt_",
  "personalized MCP URL",
]);
export const EXPECTED_HOSTED_SOURCE_REPOSITORY =
  "https://github.com/Dexter-DAO/dexter-mcp";
const EXPECTED_HOSTED_SOURCE_ORIGIN = `${EXPECTED_HOSTED_SOURCE_REPOSITORY}.git`;

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

function git(root, args, options = {}) {
  return run("git", ["--no-replace-objects", "-C", root, ...args], options);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  same(Object.keys(value).sort(), [...expected].sort(), `${label} fields`);
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

function requireHex(value, length, label) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    fail(`${label} is invalid`);
  }
}

function validateSourceContracts(sourceContracts) {
  exactKeys(sourceContracts, [
    "schemaVersion",
    "kind",
    "api",
    "integratedApiRelease",
    "portfolioProjection",
    "facilitator",
    "mcp",
  ], "sourceContracts");
  if (
    sourceContracts.schemaVersion !== 3
    || sourceContracts.kind !== SOURCE_CONTRACTS_KIND
  ) {
    fail("hosted descriptor sourceContracts is unsupported");
  }
  exactKeys(
    sourceContracts.api,
    ["repository", "commit", "tree", "consumerFixture"],
    "sourceContracts api",
  );
  exactKeys(
    sourceContracts.api.consumerFixture,
    ["path", "sha256", "canonicalBodyDigest"],
    "sourceContracts api fixture",
  );
  exactKeys(
    sourceContracts.integratedApiRelease,
    [
      "repository",
      "commit",
      "tree",
      "governedContractCommit",
      "governedContractTree",
    ],
    "sourceContracts integrated API release",
  );
  exactKeys(
    sourceContracts.portfolioProjection,
    ["repository", "commit", "tree", "sourcePaths", "fixture"],
    "sourceContracts portfolio projection",
  );
  exactKeys(
    sourceContracts.portfolioProjection.fixture,
    ["consumerPath", "apiPath", "sha256", "canonicalDigest"],
    "sourceContracts portfolio projection fixture",
  );
  exactKeys(
    sourceContracts.facilitator,
    ["repository", "commit", "tree", "bindingFixture"],
    "sourceContracts facilitator",
  );
  exactKeys(
    sourceContracts.facilitator.bindingFixture,
    ["consumerPath", "apiPath", "facilitatorPath", "sha256"],
    "sourceContracts facilitator fixture",
  );
  exactKeys(
    sourceContracts.mcp,
    ["repository", "commit", "tree", "toolContractPath", "authContractPath"],
    "sourceContracts mcp",
  );
  if (sourceContracts.api.repository !== EXPECTED_API_REPOSITORY) {
    fail("hosted descriptor API source repository is unexpected");
  }
  if (
    sourceContracts.integratedApiRelease.repository !== EXPECTED_API_REPOSITORY
    || sourceContracts.portfolioProjection.repository !== EXPECTED_API_REPOSITORY
    || sourceContracts.facilitator.repository !== EXPECTED_FACILITATOR_REPOSITORY
  ) {
    fail("hosted descriptor paired source repository is unexpected");
  }
  if (sourceContracts.mcp.repository !== EXPECTED_HOSTED_SOURCE_REPOSITORY) {
    fail("hosted descriptor MCP source repository is unexpected");
  }
  if (
    sourceContracts.api.consumerFixture.path
      !== "tests/fixtures/governed-agent-reconcile-advanced-final-c3e32885.json"
    || sourceContracts.integratedApiRelease.governedContractCommit
      !== sourceContracts.api.commit
    || sourceContracts.integratedApiRelease.governedContractTree
      !== sourceContracts.api.tree
    || sourceContracts.portfolioProjection.commit
      !== sourceContracts.integratedApiRelease.commit
    || sourceContracts.portfolioProjection.tree
      !== sourceContracts.integratedApiRelease.tree
    || JSON.stringify(sourceContracts.portfolioProjection.sourcePaths)
      !== JSON.stringify(PORTFOLIO_PROJECTION_SOURCE_PATHS)
    || sourceContracts.portfolioProjection.fixture.consumerPath
      !== "tests/fixtures/opendexter-portfolio-v1-zero-holding-approved-action-targets.json"
    || sourceContracts.portfolioProjection.fixture.apiPath
      !== "tests/fixtures/opendexter-portfolio-v1-zero-holding-approved-action-targets.json"
    || sourceContracts.facilitator.bindingFixture.consumerPath
      !== "tests/fixtures/governed-agent-trade-api-facilitator-binding-v1.json"
    || sourceContracts.facilitator.bindingFixture.apiPath
      !== "tests/fixtures/governed-agent-trade-api-facilitator-binding-v1.json"
    || sourceContracts.facilitator.bindingFixture.facilitatorPath
      !== "test/fixtures/governed-agent-trade-api-facilitator-binding-v1.json"
    || sourceContracts.mcp.toolContractPath !== "lib/open-tool-contracts.mjs"
    || sourceContracts.mcp.authContractPath !== "lib/open-tool-auth.mjs"
  ) {
    fail("hosted descriptor source contract paths are unexpected");
  }
  for (const [label, source] of [
    ["API", sourceContracts.api],
    ["integrated API", sourceContracts.integratedApiRelease],
    ["portfolio projection", sourceContracts.portfolioProjection],
    ["facilitator", sourceContracts.facilitator],
    ["MCP", sourceContracts.mcp],
  ]) {
    requireHex(source.commit, 40, `sourceContracts ${label} commit`);
    requireHex(source.tree, 40, `sourceContracts ${label} tree`);
  }
  requireHex(
    sourceContracts.api.consumerFixture.sha256,
    64,
    "sourceContracts API fixture digest",
  );
  requireHex(
    sourceContracts.api.consumerFixture.canonicalBodyDigest,
    64,
    "sourceContracts API body digest",
  );
  requireHex(
    sourceContracts.portfolioProjection.fixture.sha256,
    64,
    "sourceContracts portfolio fixture digest",
  );
  requireHex(
    sourceContracts.portfolioProjection.fixture.canonicalDigest,
    64,
    "sourceContracts portfolio canonical digest",
  );
  requireHex(
    sourceContracts.facilitator.bindingFixture.sha256,
    64,
    "sourceContracts facilitator fixture digest",
  );
}

function validateOAuth(oauth) {
  exactKeys(oauth, [
    "mode",
    "resource",
    "protectedResourceMetadata",
    "protectedResourcePaths",
    "authorizationServer",
    "authorizationServerMetadata",
    "tokenIssuer",
    "scopesSupported",
    "challengeRequiredParameters",
  ], "hosted descriptor oauth");
  same(oauth, {
    mode: "mixed",
    resource: "https://open.dexter.cash/mcp",
    protectedResourceMetadata:
      "https://open.dexter.cash/.well-known/oauth-protected-resource/mcp",
    protectedResourcePaths: [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
    authorizationServer: "https://mcp.dexter.cash/mcp",
    authorizationServerMetadata:
      "https://mcp.dexter.cash/.well-known/oauth-authorization-server/mcp",
    tokenIssuer: "https://dexter.cash",
    scopesSupported: ["vault"],
    challengeRequiredParameters: [
      "resource_metadata",
      "scope",
      "error",
      "error_description",
    ],
  }, "hosted descriptor OAuth contract");
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

export function validatePublicHostedDescriptor(descriptor) {
  exactKeys(descriptor, [
    "schemaVersion",
    "kind",
    "oauth",
    "anonymousToolNames",
    "oauthPromotedToolNames",
    "connectedToolNames",
    "optionalOAuthToolNames",
    "tools",
  ], "hosted descriptor");
  if (descriptor?.schemaVersion !== 2) fail("unsupported hosted descriptor schema");
  if (descriptor?.kind !== DESCRIPTOR_KIND) {
    fail("unexpected hosted descriptor kind");
  }
  validateOAuth(descriptor.oauth);
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
    exactKeys(tool, [
      "name",
      "title",
      "description",
      "inputSchema",
      "outputSchema",
      "annotations",
      "securitySchemes",
      "_meta",
    ], `${tool?.name ?? "unknown"} tool`);
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
    if (!tool._meta || typeof tool._meta !== "object" || Array.isArray(tool._meta)) {
      fail(`${tool.name} _meta is required`);
    }
    if (!Array.isArray(tool._meta.ui?.visibility) || tool._meta.ui.visibility.length === 0) {
      fail(`${tool.name} _meta.ui.visibility is required`);
    }
    if (typeof tool._meta["openai/widgetAccessible"] !== "boolean") {
      fail(`${tool.name} _meta openai/widgetAccessible is required`);
    }
    same(
      tool._meta.securitySchemes,
      tool.securitySchemes,
      `${tool.name} _meta securitySchemes`,
    );
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

export function validateHostedDescriptor(descriptor) {
  exactKeys(descriptor, [
    "schemaVersion",
    "kind",
    "sourceContracts",
    "oauth",
    "anonymousToolNames",
    "oauthPromotedToolNames",
    "connectedToolNames",
    "optionalOAuthToolNames",
    "tools",
  ], "hosted descriptor");
  if (descriptor?.schemaVersion !== 2) fail("unsupported hosted descriptor schema");
  if (descriptor?.kind !== DESCRIPTOR_KIND) fail("unexpected hosted descriptor kind");
  validateSourceContracts(descriptor.sourceContracts);
  const { sourceContracts: _sourceContracts, ...publicDescriptor } = descriptor;
  validatePublicHostedDescriptor(publicDescriptor);
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

export function reviewedEnvironment({ npmCache, production = false, nodeBin } = {}) {
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
      fail(`hosted source release environment contains ${key}`);
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
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: production ? "production" : undefined,
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

export function listCanonicalRemoteRefs(
  remote,
  {
    cwd = tmpdir(),
    environment = reviewedEnvironment(),
  } = {},
) {
  requireNonemptyString(remote, "canonical source remote");
  return run("git", [
    "--no-replace-objects",
      "--git-dir=/dev/null",
      "ls-remote",
      "--refs",
      remote,
      "refs/heads/*",
      "refs/tags/*",
  ], {
    cwd,
    env: environment,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function hasCanonicalHostedAdvertisement(remoteRefs, commit) {
  requireHex(commit, 40, "canonical hosted source commit");
  return String(remoteRefs).split(/\r?\n/).some((line) => {
    const [remoteCommit, refname, extra] = line.trim().split(/\s+/);
    return remoteCommit === commit
      && /^refs\/(?:heads|tags)\/.+/.test(refname ?? "")
      && extra === undefined;
  });
}

export function inspectHostedSourceCheckout({
  sourceRoot,
  verifyCanonicalAdvertisement = true,
}) {
  const root = realpathSync(sourceRoot);
  const cleanEnvironment = reviewedEnvironment();
  const topLevel = realpathSync(git(
    root,
    ["rev-parse", "--show-toplevel"],
    { env: cleanEnvironment },
  ));
  if (topLevel !== root) fail("hosted source root is not the Git toplevel");
  verifyHostedRepositoryIdentity(git(
    root,
    ["remote", "get-url", "origin"],
    { env: cleanEnvironment },
  ));
  const status = git(
    root,
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { env: cleanEnvironment },
  );
  if (status) fail(`hosted source is not clean:\n${status}`);
  const hidden = git(root, ["ls-files", "-v", "-z"], {
    env: cleanEnvironment,
  }).split("\0").filter((entry) => /^[a-zS] /.test(entry));
  if (hidden.length > 0) {
    fail("hosted source contains assume-unchanged or skip-worktree state");
  }
  const replaceRefs = git(
    root,
    ["for-each-ref", "--format=%(refname)", "refs/replace"],
    { env: cleanEnvironment },
  );
  if (replaceRefs) fail("hosted source contains Git replace refs");
  const commit = git(root, ["rev-parse", "HEAD^{commit}"], {
    env: cleanEnvironment,
  });
  const tree = git(root, ["rev-parse", "HEAD^{tree}"], {
    env: cleanEnvironment,
  });
  if (verifyCanonicalAdvertisement) {
    const remoteRefs = listCanonicalRemoteRefs(EXPECTED_HOSTED_SOURCE_ORIGIN, {
      environment: cleanEnvironment,
    });
    if (!hasCanonicalHostedAdvertisement(remoteRefs, commit)) {
      fail("canonical hosted source does not advertise HEAD");
    }
  }
  return { root, commit, tree, cleanEnvironment };
}

export function cloneCanonicalHostedSourceAt({ commit, workspace }) {
  requireHex(commit, 40, "canonical hosted source commit");
  const root = resolve(workspace, "dexter-mcp");
  const environment = reviewedEnvironment();
  run("git", [
    "clone",
    "--quiet",
    "--no-checkout",
    EXPECTED_HOSTED_SOURCE_ORIGIN,
    root,
  ], { cwd: workspace, env: environment, timeout: 60_000 });
  git(root, ["checkout", "--detach", "--quiet", commit], {
    env: environment,
  });
  return root;
}

function sterileGitEnvironment(cleanEnvironment, disposableRoot) {
  const home = resolve(disposableRoot, "git-home");
  const xdg = resolve(disposableRoot, "git-xdg");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  return {
    ...cleanEnvironment,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

export function createTreePureArchive({
  root,
  commit,
  tree,
  output,
  disposableRoot,
  cleanEnvironment = reviewedEnvironment(),
}) {
  const objectRepository = resolve(disposableRoot, "objects.git");
  const environment = sterileGitEnvironment(cleanEnvironment, disposableRoot);
  run("git", ["init", "--bare", "--quiet", objectRepository], {
    cwd: disposableRoot,
    env: environment,
  });
  run("git", [
    "--no-replace-objects",
    `--git-dir=${objectRepository}`,
    "fetch",
    "--no-tags",
    "--quiet",
    root,
    `${commit}:refs/opendexter/source`,
  ], {
    cwd: disposableRoot,
    env: environment,
  });
  const copiedCommit = run("git", [
    "--no-replace-objects",
    `--git-dir=${objectRepository}`,
    "rev-parse",
    "refs/opendexter/source^{commit}",
  ], {
    cwd: disposableRoot,
    env: environment,
  });
  const copiedTree = run("git", [
    "--no-replace-objects",
    `--git-dir=${objectRepository}`,
    "rev-parse",
    "refs/opendexter/source^{tree}",
  ], {
    cwd: disposableRoot,
    env: environment,
  });
  if (copiedCommit !== commit || copiedTree !== tree) {
    fail("sterile object copy differs from the reviewed source identity");
  }
  run("git", [
    "--no-replace-objects",
    `--git-dir=${objectRepository}`,
    "-c",
    "core.attributesFile=/dev/null",
    "archive",
    "--format=tar",
    `--output=${output}`,
    "refs/opendexter/source",
  ], {
    cwd: disposableRoot,
    env: environment,
  });
}

async function materializeArchivedDescriptor({
  root,
  commit,
  tree,
  cleanEnvironment,
  recipe,
  prepareMaterialization,
}) {
  const disposableRoot = mkdtempSync(resolve(tmpdir(), "opendexter-hosted-source-"));
  const sourceArchive = resolve(disposableRoot, "source.tar");
  const archivedRoot = resolve(disposableRoot, "source");
  try {
    mkdirSync(archivedRoot);
    createTreePureArchive({
      root,
      commit,
      tree,
      output: sourceArchive,
      disposableRoot,
      cleanEnvironment,
    });
    run("tar", ["-xf", sourceArchive, "-C", archivedRoot], {
      env: cleanEnvironment,
    });
    for (const relativePath of [
      DESCRIPTOR_PATH,
      DESCRIPTOR_MATERIALIZER_PATH,
      "package.json",
      "package-lock.json",
    ]) {
      const stat = lstatSync(resolve(archivedRoot, relativePath));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail(`${relativePath} is not one archived regular file`);
      }
    }
    const manifest = readJson(resolve(archivedRoot, "package.json"));
    if (manifest.packageManager !== `npm@${REVIEWED_NPM_VERSION}`) {
      fail("hosted source does not pin the reviewed npm version");
    }
    if (process.version !== "v22.19.0") {
      fail("hosted source materializer Node version drifted");
    }
    const npmCli = realpathSync(resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ));
    const npmVersion = run(process.execPath, [npmCli, "--version"], {
      env: cleanEnvironment,
    });
    if (npmVersion !== REVIEWED_RELEASE_NPM_VERSION) {
      fail("hosted source materializer npm version drifted");
    }
    let materializedDescriptor;
    if (prepareMaterialization) {
      const materializeArguments = prepareMaterialization(cleanEnvironment);
      const materializerModule = await import(
        `${pathToFileURL(resolve(
          archivedRoot,
          DESCRIPTOR_MATERIALIZER_PATH,
        )).href}?source=${commit}`
      );
      if (typeof materializerModule.materializeOpenToolDescriptorsFromGit !== "function") {
        fail("hosted source lacks the reviewed outer materializer export");
      }
      materializedDescriptor =
        await materializerModule.materializeOpenToolDescriptorsFromGit(
          materializeArguments,
        );
    }
    const committedDescriptorBytes = readFileSync(
      resolve(archivedRoot, DESCRIPTOR_PATH),
    );
    return {
      committedDescriptor: JSON.parse(committedDescriptorBytes.toString("utf8")),
      materializedDescriptor,
      materialization: {
        recipe,
        node: process.version,
        npm: npmVersion,
        packageLockSha256: sha256(readFileSync(resolve(archivedRoot, "package-lock.json"))),
        sourceArchiveSha256: sha256(readFileSync(sourceArchive)),
        descriptorSha256: sha256(committedDescriptorBytes),
      },
    };
  } finally {
    rmSync(disposableRoot, { recursive: true, force: true });
  }
}

export async function inspectArchivedHostedSourceEvidence({
  root,
  commit,
  tree,
  cleanEnvironment = reviewedEnvironment(),
  recipe,
}) {
  requireNonemptyString(recipe, "public hosted materialization recipe");
  return materializeArchivedDescriptor({
    root,
    commit,
    tree,
    cleanEnvironment,
    recipe,
  });
}

async function materializeArchivedHostedSource({
  root,
  commit,
  tree,
  cleanEnvironment,
  apiSourceRoot,
  facilitatorSourceRoot,
  outerEnvironment,
}) {
  return materializeArchivedDescriptor({
    root,
    commit,
    tree,
    cleanEnvironment,
    recipe: MATERIALIZATION_RECIPE,
    prepareMaterialization: (environment) => {
      const token = outerEnvironment?.GH_TOKEN;
      if (
        typeof token !== "string"
        || token.length === 0
        || token.length > 4096
        || /[\0\r\n]/.test(token)
      ) {
        fail("hosted private source token is absent or malformed");
      }
      if (outerEnvironment?.GITHUB_PERSONAL_ACCESS_TOKEN) {
        fail("hosted source refuses a reusable personal-access token");
      }
      return {
        sourceRoot: root,
        apiSourceRoot,
        facilitatorSourceRoot,
        verifyCrossRepositorySources: true,
        environment: { ...environment, GH_TOKEN: token },
      };
    },
  });
}

export async function materializeArchivedPublicHostedSource({
  root,
  commit,
  tree,
  cleanEnvironment = reviewedEnvironment(),
  recipe,
}) {
  requireNonemptyString(recipe, "public hosted materialization recipe");
  return materializeArchivedDescriptor({
    root,
    commit,
    tree,
    cleanEnvironment,
    recipe,
    prepareMaterialization: (environment) => ({
      sourceRoot: root,
      verifyCrossRepositorySources: false,
      environment,
    }),
  });
}

export function buildHostedContract({
  descriptor,
  commit,
  tree,
  materialization,
  manifestVersion,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifestVersion ?? "")) {
    fail("hosted manifest version is invalid");
  }
  return {
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
    sourceContracts: descriptor.sourceContracts,
    oauth: descriptor.oauth,
    materialization,
    mcp: {
      url: descriptor.oauth.resource,
      manifestVersion,
      resource: descriptor.oauth.resource,
      protectedResourceMetadata: descriptor.oauth.protectedResourceMetadata,
      protectedResourcePaths: descriptor.oauth.protectedResourcePaths,
      authorizationServer: descriptor.oauth.authorizationServer,
      authorizationServerMetadata:
        descriptor.oauth.authorizationServerMetadata,
      tokenIssuer: descriptor.oauth.tokenIssuer,
      scope: descriptor.oauth.scopesSupported[0],
      challengeRequiredParameters:
        descriptor.oauth.challengeRequiredParameters,
    },
    anonymousToolNames: descriptor.anonymousToolNames,
    oauthPromotedToolNames: descriptor.oauthPromotedToolNames,
    connectedToolNames: descriptor.connectedToolNames,
    optionalOAuthToolNames: descriptor.optionalOAuthToolNames,
    tools: descriptor.tools,
    forbiddenHostedToolNames: [...FORBIDDEN_HOSTED_TOOL_NAMES],
    forbiddenHostedToolPatterns: [...FORBIDDEN_HOSTED_TOOL_PATTERNS],
    forbiddenGuidancePatterns: [...FORBIDDEN_GUIDANCE_PATTERNS],
  };
}

export function verifyEquivalentHostedContracts(pinned, privateVerified) {
  if (pinned?.materialization?.recipe !== PUBLIC_HOSTED_MATERIALIZATION_RECIPE) {
    fail("pinned hosted contract lacks the accepted public materialization receipt");
  }
  if (privateVerified?.materialization?.recipe !== MATERIALIZATION_RECIPE) {
    fail("private hosted source verification recipe differs");
  }
  const pinnedComparable = structuredClone(pinned);
  const privateComparable = structuredClone(privateVerified);
  delete pinnedComparable.materialization.recipe;
  delete privateComparable.materialization.recipe;
  same(
    pinnedComparable,
    privateComparable,
    "publicly pinned and privately verified hosted contracts",
  );
  return pinned;
}

export async function verifyHostedSource({
  sourceRoot,
  apiSourceRoot,
  facilitatorSourceRoot,
  mode = "check",
  outerEnvironment = process.env,
}) {
  if (mode !== "check") {
    fail("private hosted-source verification is check-only; use release:prepare-plugin");
  }
  const { root, commit, tree, cleanEnvironment } = inspectHostedSourceCheckout({
    sourceRoot,
  });
  const exactApiSourceRoot = realpathSync(apiSourceRoot);
  const exactFacilitatorSourceRoot = realpathSync(facilitatorSourceRoot);
  const archived = await materializeArchivedHostedSource({
    root,
    commit,
    tree,
    cleanEnvironment,
    apiSourceRoot: exactApiSourceRoot,
    facilitatorSourceRoot: exactFacilitatorSourceRoot,
    outerEnvironment,
  });
  const descriptor = verifyMaterializedHostedDescriptor(
    archived.committedDescriptor,
    archived.materializedDescriptor,
  );
  const nextContract = buildHostedContract({
    descriptor,
    commit,
    tree,
    materialization: archived.materialization,
    manifestVersion: readJson(resolve(root, "package.json")).version,
  });
  const pinnedContract = verifyEquivalentHostedContracts(
    readJson(contractPath),
    nextContract,
  );
  return {
    commit,
    tree,
    descriptorPath: DESCRIPTOR_PATH,
    contract: pinnedContract,
  };
}

function parseArgs(argv) {
  if (argv.includes("--write")) {
    fail("private hosted-source verification is check-only; use release:prepare-plugin");
  }
  const mode = "check";
  const sourceIndex = argv.indexOf("--source");
  const apiSourceIndex = argv.indexOf("--api-source");
  const facilitatorSourceIndex = argv.indexOf("--facilitator-source");
  const source = sourceIndex >= 0 ? argv[sourceIndex + 1] : process.env.OPENDXTER_HOSTED_SOURCE_ROOT;
  const apiSource = apiSourceIndex >= 0
    ? argv[apiSourceIndex + 1]
    : process.env.OPENDXTER_API_SOURCE_ROOT;
  const facilitatorSource = facilitatorSourceIndex >= 0
    ? argv[facilitatorSourceIndex + 1]
    : process.env.OPENDXTER_FACILITATOR_SOURCE_ROOT;
  if (!source) fail("--source or OPENDXTER_HOSTED_SOURCE_ROOT is required");
  if (!apiSource) fail("--api-source or OPENDXTER_API_SOURCE_ROOT is required");
  if (!facilitatorSource) {
    fail("--facilitator-source or OPENDXTER_FACILITATOR_SOURCE_ROOT is required");
  }
  if (![source, apiSource, facilitatorSource].every(isAbsolute)) {
    fail("hosted paired source roots must be absolute");
  }
  return { mode, source, apiSource, facilitatorSource };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { mode, source, apiSource, facilitatorSource } = parseArgs(
      process.argv.slice(2),
    );
    const result = await verifyHostedSource({
      sourceRoot: source,
      apiSourceRoot: apiSource,
      facilitatorSourceRoot: facilitatorSource,
      mode,
    });
    process.stdout.write(
      `Verified hosted descriptors at ${result.commit}/${result.tree}.\n`,
    );
  } catch (error) {
    process.stderr.write(`OpenDexter hosted-source gate refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
