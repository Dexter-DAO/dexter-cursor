import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildHostedContract,
  createTreePureArchive,
  hasCanonicalHostedAdvertisement,
  listCanonicalRemoteRefs,
  validateHostedDescriptor,
  verifyHostedRepositoryIdentity,
  verifyMaterializedHostedDescriptor,
  verifyHostedSource,
} from "../packages/mcp/scripts/verify-hosted-source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const codexRoot = resolve(repoRoot, "plugins/opendexter");
const claudeRoot = resolve(repoRoot, "opendexter-plugin");
const codexMarketplacePath = resolve(repoRoot, ".agents/plugins/marketplace.json");
const claudeMarketplacePath = resolve(repoRoot, ".claude-plugin/marketplace.json");
const appBindingPath = resolve(repoRoot, "chatgpt-app-binding/.app.json");
const contractPath = resolve(
  codexRoot,
  "skills/opendexter/references/hosted-contract.json",
);
const execFileAsync = promisify(execFile);

const HOSTED_TOOLS = Object.freeze([
  "x402_search",
  "x402_check",
  "x402_fetch",
  "x402_status",
  "x402_access",
  "x402_wallet",
  "dexter_portfolio",
  "dexter_prepare_asset_action",
  "dexter_execute_asset_action",
  "dexter_asset_action_status",
  "dexter_reconcile_asset_action",
  "dexter_wallet_history",
]);

const ANONYMOUS_TOOLS = Object.freeze([
  "x402_search",
  "x402_check",
  "x402_access",
  "x402_wallet",
  "dexter_portfolio",
]);

const OAUTH_PROMOTED_TOOLS = Object.freeze([
  "x402_fetch",
  "x402_status",
  "dexter_prepare_asset_action",
  "dexter_execute_asset_action",
  "dexter_asset_action_status",
  "dexter_reconcile_asset_action",
  "dexter_wallet_history",
]);

const RETIRED_HOSTED_TOOLS = Object.freeze([
  "x402_pay",
  "x402_compose_skill",
  "promote_skill",
  "dexter_passkey_probe",
  "dexter_passkey",
  "dexter_authorize_asset_action",
]);

const EXPECTED_SCHEMES = Object.freeze({
  x402_search: ["noauth"],
  x402_check: ["noauth", "oauth2:vault"],
  x402_fetch: ["oauth2:vault"],
  x402_status: ["oauth2:vault"],
  x402_access: ["noauth"],
  x402_wallet: ["oauth2:vault"],
  dexter_portfolio: ["oauth2:vault"],
  dexter_prepare_asset_action: ["oauth2:vault"],
  dexter_execute_asset_action: ["oauth2:vault"],
  dexter_asset_action_status: ["oauth2:vault"],
  dexter_reconcile_asset_action: ["oauth2:vault"],
  dexter_wallet_history: ["oauth2:vault"],
});

const EXPECTED_SKILLS = Object.freeze([
  "opendexter",
  "x402-debugging",
  "x402-protocol",
]);

const LEGACY_ACTIVE_PATTERN =
  /\b(?:card_status|card_issue|card_link_wallet|card_freeze|card_login_request_otp|card_login_complete|x402_settings)\b|@dexterai\/opendexter|wallet\.json|PRIVATE_KEY|\/mcp\/dlt_/i;
const TOOL_NAME =
  /\b(?:x402_[a-z_]+|dexter_[a-z_]+|promote_skill|card_[a-z_]+)\b/g;

function hostedDescriptorFixture() {
  const tool = ({ name, securitySchemes, marker }) => {
    const schemes = structuredClone(securitySchemes);
    return {
      name,
      title: `${name} title`,
      description: `${name} description`,
      inputSchema: {
        type: "object",
        properties: { input: { type: "string", const: marker } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { output: { type: "string", const: marker } },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      securitySchemes: schemes,
      _meta: {
        ui: { visibility: ["model"] },
        "openai/widgetAccessible": false,
        securitySchemes: structuredClone(schemes),
      },
    };
  };
  return {
    schemaVersion: 2,
    kind: "opendexter-hosted-tool-descriptors/v2",
    sourceContracts: {
      schemaVersion: 3,
      kind: "opendexter-source-contracts/v3",
      api: {
        repository: "https://github.com/Dexter-DAO/dexter-api",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        consumerFixture: {
          path:
            "tests/fixtures/governed-agent-reconcile-advanced-final-c3e32885.json",
          sha256: "c".repeat(64),
          canonicalBodyDigest: "d".repeat(64),
        },
      },
      integratedApiRelease: {
        repository: "https://github.com/Dexter-DAO/dexter-api",
        commit: "1".repeat(40),
        tree: "2".repeat(40),
        governedContractCommit: "a".repeat(40),
        governedContractTree: "b".repeat(40),
      },
      portfolioProjection: {
        repository: "https://github.com/Dexter-DAO/dexter-api",
        commit: "1".repeat(40),
        tree: "2".repeat(40),
        sourcePaths: [
          "src/portfolio/approvedActionTargets.ts",
          "src/routes/passkeyMcpBinding.ts",
          "src/routes/defaultGovernedDelegatedAssetActions.ts",
        ],
        fixture: {
          consumerPath:
            "tests/fixtures/opendexter-portfolio-v1-zero-holding-approved-action-targets.json",
          apiPath:
            "tests/fixtures/opendexter-portfolio-v1-zero-holding-approved-action-targets.json",
          sha256: "3".repeat(64),
          canonicalDigest: "4".repeat(64),
        },
      },
      facilitator: {
        repository: "https://github.com/Dexter-DAO/dexter-facilitator",
        commit: "5".repeat(40),
        tree: "6".repeat(40),
        bindingFixture: {
          consumerPath:
            "tests/fixtures/governed-agent-trade-api-facilitator-binding-v1.json",
          apiPath:
            "tests/fixtures/governed-agent-trade-api-facilitator-binding-v1.json",
          facilitatorPath:
            "test/fixtures/governed-agent-trade-api-facilitator-binding-v1.json",
          sha256: "7".repeat(64),
        },
      },
      mcp: {
        repository: "https://github.com/Dexter-DAO/dexter-mcp",
        commit: "e".repeat(40),
        tree: "f".repeat(40),
        toolContractPath: "lib/open-tool-contracts.mjs",
        authContractPath: "lib/open-tool-auth.mjs",
      },
    },
    oauth: {
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
    },
    anonymousToolNames: ["x402_check"],
    oauthPromotedToolNames: ["x402_fetch"],
    connectedToolNames: ["x402_check", "x402_fetch"],
    optionalOAuthToolNames: ["x402_check"],
    tools: [
      tool({
        name: "x402_check",
        marker: "check",
        securitySchemes: [
          { type: "noauth" },
          { type: "oauth2", scopes: ["vault"] },
        ],
      }),
      tool({
        name: "x402_fetch",
        marker: "fetch",
        securitySchemes: [{ type: "oauth2", scopes: ["vault"] }],
      }),
    ],
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function namedTools(text) {
  return [...new Set(text.match(TOOL_NAME) ?? [])].sort();
}

function normalizedSchemes(tool) {
  return tool.securitySchemes.map((scheme) =>
    scheme.type === "oauth2"
      ? `oauth2:${[...(scheme.scopes ?? [])].sort().join(",")}`
      : scheme.type,
  );
}

function frontmatter(text, path) {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert.ok(match, `${path}: missing YAML frontmatter`);
  const name = match[1].match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
  const rawDescription =
    match[1].match(/^description:\s*([^\n]+)$/m)?.[1]?.trim();
  assert.ok(name, `${path}: missing skill name`);
  assert.ok(rawDescription, `${path}: missing skill description`);
  const description =
    rawDescription.startsWith('"') && rawDescription.endsWith('"')
      ? JSON.parse(rawDescription)
      : rawDescription;
  return { name, description };
}

async function packageSkillNames(root) {
  const skillRoot = resolve(root, "skills");
  const entries = await readdir(skillRoot, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await lstat(resolve(skillRoot, entry.name, "SKILL.md"));
      names.push(entry.name);
    } catch {
      // Empty historical directories are ignored in a working tree and do not
      // exist in the committed archive.
    }
  }
  return names.sort();
}

async function activeText(root) {
  const paths = [
    resolve(
      root,
      root === codexRoot
        ? ".codex-plugin/plugin.json"
        : ".claude-plugin/plugin.json",
    ),
  ];
  if (root !== codexRoot) paths.push(resolve(root, ".mcp.json"));
  for (const skill of EXPECTED_SKILLS) {
    paths.push(resolve(root, "skills", skill, "SKILL.md"));
  }
  paths.push(
    resolve(root, "skills/opendexter/references/authentication.md"),
    resolve(root, "skills/opendexter/references/routing-and-safety.md"),
  );
  return (
    await Promise.all(paths.map(async (path) => await readFile(path, "utf8")))
  ).join("\n");
}

async function inspectTree(root) {
  const entries = [];
  async function visit(path) {
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `symlink is not publishable: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(resolve(path, name));
      }
      return;
    }
    assert.equal(info.isFile(), true, `special file is not publishable: ${path}`);
    const bytes = await readFile(path);
    entries.push({
      path: relative(root, path),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await visit(root);
  return entries;
}

test("hosted source identity is fixed to the Dexter MCP repository", () => {
  for (const origin of [
    "https://github.com/Dexter-DAO/dexter-mcp.git",
    "git@github.com:Dexter-DAO/dexter-mcp.git",
    "ssh://git@github.com/Dexter-DAO/dexter-mcp.git",
  ]) {
    assert.equal(
      verifyHostedRepositoryIdentity(origin),
      "https://github.com/Dexter-DAO/dexter-mcp",
    );
  }
  assert.throws(
    () => verifyHostedRepositoryIdentity("https://github.com/example/dexter-mcp.git"),
    /expected https:\/\/github\.com\/Dexter-DAO\/dexter-mcp/,
  );
  assert.throws(
    () => verifyHostedRepositoryIdentity("/tmp/clean-lookalike"),
    /not a canonical GitHub repository/,
  );
});

test("hosted source verifier refuses a nested path before source contact", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "opendexter-nested-source-"));
  const nested = resolve(root, "nested");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(nested);
  await execFileAsync("git", ["init", "-q", root]);
  await assert.rejects(
    verifyHostedSource({ sourceRoot: nested }),
    /hosted source root is not the Git toplevel/,
  );
});

test("hosted source verifier refuses hidden index state before origin contact", async (t) => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const root = await mkdtemp(resolve(tmpdir(), "opendexter-hidden-source-"));
    t.after(async () => await rm(root, { recursive: true, force: true }));
    await writeFile(resolve(root, "tracked.txt"), "tracked\n");
    for (const args of [
      ["init", "-q", root],
      ["-C", root, "config", "user.name", "OpenDexter Test"],
      ["-C", root, "config", "user.email", "test@invalid.example"],
      ["-C", root, "add", "tracked.txt"],
      ["-C", root, "commit", "-qm", "fixture"],
      [
        "-C",
        root,
        "remote",
        "add",
        "origin",
        "https://github.com/Dexter-DAO/dexter-mcp.git",
      ],
      ["-C", root, "update-index", flag, "tracked.txt"],
    ]) {
      await execFileAsync("git", args);
    }
    await assert.rejects(
      verifyHostedSource({ sourceRoot: root }),
      /assume-unchanged or skip-worktree/,
      flag,
    );
  }
});

test("canonical source lookup ignores caller repository URL rewrites", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "opendexter-remote-rewrite-"));
  const attacker = resolve(root, "attacker.git");
  const runner = resolve(root, "runner");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(runner);
  await execFileAsync("git", ["init", "--bare", "-q", attacker]);
  await execFileAsync("git", ["init", "-q", runner]);
  await writeFile(resolve(runner, "attacker.txt"), "attacker\n");
  for (const args of [
    ["-C", runner, "config", "user.name", "OpenDexter Test"],
    ["-C", runner, "config", "user.email", "test@invalid.example"],
    ["-C", runner, "add", "attacker.txt"],
    ["-C", runner, "commit", "-qm", "attacker"],
    ["-C", runner, "push", `file://${attacker}`, "HEAD:refs/heads/attacker"],
  ]) {
    await execFileAsync("git", args);
  }
  await execFileAsync("git", [
    "-C",
    runner,
    "config",
    `url.file://${attacker}.insteadOf`,
    "test://canonical-source/repository.git",
  ]);
  const redirected = await execFileAsync(
    "git",
    ["-C", runner, "ls-remote", "test://canonical-source/repository.git"],
  );
  assert.equal(redirected.stderr, "");
  assert.match(redirected.stdout, /^[0-9a-f]{40}\s+refs\/heads\/attacker\s*$/);
  assert.throws(
    () => listCanonicalRemoteRefs("test://canonical-source/repository.git", {
      cwd: runner,
    }),
    /remote-test|not a git command|unable to find remote helper/i,
  );
});

test("canonical hosted advertisement accepts only public heads and tags", () => {
  const commit = "a".repeat(40);
  assert.equal(
    hasCanonicalHostedAdvertisement(`${commit}\trefs/heads/main`, commit),
    true,
  );
  assert.equal(
    hasCanonicalHostedAdvertisement(`${commit}\trefs/tags/opendexter-v1`, commit),
    true,
  );
  for (const hostile of [
    `${commit}\trefs/pull/123/head`,
    `${commit}\trefs/changes/1`,
    `${commit}\trefs/heads/main\textra`,
  ]) {
    assert.equal(hasCanonicalHostedAdvertisement(hostile, commit), false);
  }
});

test("tree-pure archive ignores hidden and local attribute injection", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "opendexter-archive-attrs-"));
  const repository = resolve(root, "repository");
  const disposable = resolve(root, "disposable");
  const extracted = resolve(root, "extracted");
  const archive = resolve(root, "source.tar");
  const localAttributes = resolve(root, "local-attributes");
  const attackerHome = resolve(root, "attacker-home");
  const attackerXdg = resolve(root, "attacker-xdg");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(repository);
  await mkdir(disposable);
  await mkdir(extracted);
  await mkdir(resolve(attackerXdg, "git"), { recursive: true });
  await writeFile(resolve(repository, "kept.txt"), "$Format:%H$\n");
  await writeFile(resolve(repository, "hidden.txt"), "must remain\n");
  await writeFile(localAttributes, "hidden.txt export-ignore\nkept.txt export-subst\n");
  await writeFile(
    resolve(attackerXdg, "git/attributes"),
    "hidden.txt export-ignore\nkept.txt export-subst\n",
  );
  for (const args of [
    ["init", "-q", repository],
    ["-C", repository, "config", "user.name", "OpenDexter Test"],
    ["-C", repository, "config", "user.email", "test@invalid.example"],
    ["-C", repository, "add", "kept.txt", "hidden.txt"],
    ["-C", repository, "commit", "-qm", "fixture"],
    ["-C", repository, "config", "core.attributesFile", localAttributes],
  ]) {
    await execFileAsync("git", args);
  }
  const gitDir = (await execFileAsync(
    "git",
    ["-C", repository, "rev-parse", "--git-dir"],
  )).stdout.trim();
  await writeFile(
    resolve(repository, gitDir, "info/attributes"),
    "hidden.txt export-ignore\nkept.txt export-subst\n",
  );
  const commit = (await execFileAsync(
    "git",
    ["-C", repository, "rev-parse", "HEAD^{commit}"],
  )).stdout.trim();
  const tree = (await execFileAsync(
    "git",
    ["-C", repository, "rev-parse", "HEAD^{tree}"],
  )).stdout.trim();
  const status = (await execFileAsync(
    "git",
    ["-C", repository, "status", "--porcelain=v2"],
  )).stdout;
  assert.equal(status, "");
  createTreePureArchive({
    root: repository,
    commit,
    tree,
    output: archive,
    disposableRoot: disposable,
    cleanEnvironment: {
      PATH: process.env.PATH,
      HOME: attackerHome,
      XDG_CONFIG_HOME: attackerXdg,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
  await execFileAsync("tar", ["-xf", archive, "-C", extracted]);
  assert.equal(await readFile(resolve(extracted, "hidden.txt"), "utf8"), "must remain\n");
  assert.equal(await readFile(resolve(extracted, "kept.txt"), "utf8"), "$Format:%H$\n");
});

test("hosted descriptor binds exact schemas and optional OAuth to finalized source", () => {
  const committed = hostedDescriptorFixture();
  assert.deepEqual(validateHostedDescriptor(committed), committed);
  assert.deepEqual(
    verifyMaterializedHostedDescriptor(committed, structuredClone(committed)),
    committed,
  );

  const staleInput = structuredClone(committed);
  staleInput.tools[0].inputSchema.properties.input.const = "invented-input";
  assert.throws(
    () => verifyMaterializedHostedDescriptor(committed, staleInput),
    /differs from the final hosted source descriptor/,
  );

  const nonObjectInput = structuredClone(committed);
  delete nonObjectInput.tools[0].inputSchema.type;
  nonObjectInput.tools[0].inputSchema.anyOf = [
    { type: "object", properties: {}, additionalProperties: false },
  ];
  assert.throws(
    () => validateHostedDescriptor(nonObjectInput),
    /inputSchema must have top-level type object/,
  );

  const staleOutput = structuredClone(committed);
  staleOutput.tools[1].outputSchema.properties.output.const = "invented-output";
  assert.throws(
    () => verifyMaterializedHostedDescriptor(committed, staleOutput),
    /differs from the final hosted source descriptor/,
  );

  const inventedOptionalOAuth = structuredClone(committed);
  inventedOptionalOAuth.optionalOAuthToolNames = ["x402_fetch"];
  assert.throws(
    () => validateHostedDescriptor(inventedOptionalOAuth),
    /optional-OAuth roster differs/,
  );

  const duplicateOptionalOAuth = structuredClone(committed);
  duplicateOptionalOAuth.optionalOAuthToolNames = ["x402_check", "x402_check"];
  assert.throws(
    () => validateHostedDescriptor(duplicateOptionalOAuth),
    /contains duplicates/,
  );

  const inventedSource = structuredClone(committed);
  inventedSource.sourceContracts.mcp.repository =
    "https://github.com/example/dexter-mcp";
  assert.throws(
    () => validateHostedDescriptor(inventedSource),
    /MCP source repository is unexpected/,
  );

  const staleOAuth = structuredClone(committed);
  staleOAuth.oauth.scopesSupported = ["vault", "invented"];
  assert.throws(
    () => validateHostedDescriptor(staleOAuth),
    /OAuth contract differs/,
  );

  const inventedDescriptorField = structuredClone(committed);
  inventedDescriptorField.guessedRouting = true;
  assert.throws(
    () => validateHostedDescriptor(inventedDescriptorField),
    /hosted descriptor fields differs/,
  );
});

test("hosted contract writer preserves the full descriptor and deny lists", () => {
  const descriptor = hostedDescriptorFixture();
  const materialization = {
    recipe:
      "mcp-source-owned-outer-receipt+sterile-bare-git-archive+npm-ci-ignore-scripts+workspace-build+source-materializer/v3",
    node: "v22.19.0",
    npm: "10.9.3",
    packageLockSha256: "1".repeat(64),
    sourceArchiveSha256: "2".repeat(64),
    descriptorSha256: "3".repeat(64),
  };
  const contract = buildHostedContract({
    descriptor,
    commit: "4".repeat(40),
    tree: "5".repeat(40),
    materialization,
  });
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.contractId, "opendexter-hosted-full-descriptor-v2");
  assert.deepEqual(contract.sourceContracts, descriptor.sourceContracts);
  assert.deepEqual(contract.oauth, descriptor.oauth);
  assert.deepEqual(contract.materialization, materialization);
  assert.deepEqual(contract.tools, descriptor.tools);
  assert.deepEqual(contract.forbiddenHostedToolNames, RETIRED_HOSTED_TOOLS);
  assert.deepEqual(contract.forbiddenHostedToolPatterns, ["^card_"]);
  assert.deepEqual(contract.forbiddenGuidancePatterns, [
    "pairing_url",
    "/mcp/dlt_",
    "personalized MCP URL",
  ]);
});

test("release fixture is source-pinned to the exact hosted twelve", async () => {
  const contract = await readJson(contractPath);
  assert.equal(contract.contractId, "opendexter-hosted-full-descriptor-v2");
  assert.deepEqual(contract.source, {
    repository: "https://github.com/Dexter-DAO/dexter-mcp",
    commit: "b36075a9f96be921a58a7e16ccb410adb6b57f83",
    tree: "511ece446a4329d31a16474f3b749bea19f073df",
    descriptorPath: "release/open-tool-descriptors.json",
    descriptorMaterializerPath: "scripts/materialize-open-tool-descriptors.mjs",
    toolContractPath: "lib/open-tool-contracts.mjs",
    authContractPath: "lib/open-tool-auth.mjs",
  });
  assert.equal(contract.sourceContracts.schemaVersion, 3);
  assert.equal(
    contract.sourceContracts.integratedApiRelease.commit,
    "6d8de2cee71fc217559fa2a2825fa2a25faf9497",
  );
  assert.equal(
    contract.sourceContracts.facilitator.commit,
    "df370826b7b951dfc825a689c4e6f3b1928ee5e2",
  );
  assert.equal(contract.mcp.url, "https://open.dexter.cash/mcp");
  assert.equal(contract.mcp.manifestVersion, "0.5.0");
  assert.equal(contract.mcp.resource, "https://open.dexter.cash/mcp");
  assert.equal(
    contract.mcp.protectedResourceMetadata,
    "https://open.dexter.cash/.well-known/oauth-protected-resource/mcp",
  );
  assert.deepEqual(
    contract.mcp.protectedResourcePaths,
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
  );
  assert.equal(
    contract.mcp.authorizationServer,
    "https://mcp.dexter.cash/mcp",
  );
  assert.equal(
    contract.mcp.authorizationServerMetadata,
    "https://mcp.dexter.cash/.well-known/oauth-authorization-server/mcp",
  );
  assert.equal(contract.mcp.tokenIssuer, "https://dexter.cash");
  assert.equal(contract.mcp.scope, "vault");
  assert.deepEqual(
    contract.mcp.challengeRequiredParameters,
    ["resource_metadata", "scope", "error", "error_description"],
  );
  assert.deepEqual(
    contract.tools.map(({ name }) => name),
    HOSTED_TOOLS,
  );
  assert.deepEqual(contract.anonymousToolNames, ANONYMOUS_TOOLS);
  assert.deepEqual(contract.oauthPromotedToolNames, OAUTH_PROMOTED_TOOLS);
  assert.deepEqual(contract.connectedToolNames, HOSTED_TOOLS);
  assert.deepEqual(contract.optionalOAuthToolNames, ["x402_check"]);
  assert.deepEqual(
    [...new Set([...ANONYMOUS_TOOLS, ...OAUTH_PROMOTED_TOOLS])].sort(),
    [...HOSTED_TOOLS].sort(),
  );
  for (const tool of contract.tools) {
    assert.deepEqual(normalizedSchemes(tool), EXPECTED_SCHEMES[tool.name]);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.idempotentHint, "boolean");
    assert.equal(typeof tool.annotations.openWorldHint, "boolean");
  }
  assert.equal(
    contract.tools.find(({ name }) => name === "x402_check").annotations
      .readOnlyHint,
    false,
  );
  assert.equal(
    contract.tools.find(({ name }) => name === "x402_fetch")
      ._meta["openai/widgetAccessible"],
    false,
  );
  assert.deepEqual(
    contract.tools.find(({ name }) => name === "dexter_reconcile_asset_action")
      .annotations,
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  );
  const portfolio = contract.tools.find(({ name }) => name === "dexter_portfolio");
  assert.deepEqual(portfolio.securitySchemes, [
    { type: "oauth2", scopes: ["vault"] },
  ]);
  assert.deepEqual(portfolio.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(portfolio._meta.ui.visibility, ["model"]);
  assert.equal(portfolio._meta["openai/widgetAccessible"], false);
  assert.deepEqual(portfolio._meta.securitySchemes, portfolio.securitySchemes);
  assert.equal(portfolio.inputSchema.type, "object");
  assert.equal(portfolio.outputSchema.type, "object");
  for (const name of OAUTH_PROMOTED_TOOLS) {
    assert.deepEqual(EXPECTED_SCHEMES[name], ["oauth2:vault"], name);
  }
  assert.deepEqual(EXPECTED_SCHEMES.x402_check, ["noauth", "oauth2:vault"]);
  assert.deepEqual(EXPECTED_SCHEMES.x402_wallet, ["oauth2:vault"]);
  assert.deepEqual(EXPECTED_SCHEMES.dexter_portfolio, ["oauth2:vault"]);
  assert.deepEqual(
    contract.tools
      .filter(({ _meta }) => _meta.ui.visibility.includes("model"))
      .map(({ name }) => name),
    HOSTED_TOOLS,
  );
  for (const retired of RETIRED_HOSTED_TOOLS) {
    assert.equal(
      contract.tools.some(({ name }) => name === retired),
      false,
      retired,
    );
  }
  assert.deepEqual(contract.forbiddenHostedToolNames, RETIRED_HOSTED_TOOLS);
});

test(
  "release fixture matches the pinned hosted source checkout",
  {
    skip: ![
      process.env.OPENDXTER_HOSTED_SOURCE_ROOT,
      process.env.OPENDXTER_API_SOURCE_ROOT,
      process.env.OPENDXTER_FACILITATOR_SOURCE_ROOT,
      process.env.GH_TOKEN,
    ].every(Boolean),
  },
  async () => {
    const sourceRoot = resolve(process.env.OPENDXTER_HOSTED_SOURCE_ROOT);
    const contract = await readJson(contractPath);
    const verified = await verifyHostedSource({
      sourceRoot,
      apiSourceRoot: resolve(process.env.OPENDXTER_API_SOURCE_ROOT),
      facilitatorSourceRoot: resolve(
        process.env.OPENDXTER_FACILITATOR_SOURCE_ROOT,
      ),
      mode: "check",
    });
    assert.equal(verified.commit, contract.source.commit);
    assert.equal(verified.tree, contract.source.tree);
    assert.deepEqual(verified.contract, contract);
  },
);

test("Codex package uses one portable remote MCP and mixed-auth marketplace policy", async () => {
  const manifest = await readJson(resolve(codexRoot, ".codex-plugin/plugin.json"));
  const marketplace = await readJson(codexMarketplacePath);
  assert.equal(manifest.name, "opendexter");
  assert.equal(manifest.version, "0.5.0");
  assert.equal(Object.hasOwn(manifest, "apps"), false);
  assert.deepEqual(manifest.mcpServers, {
    opendexter: {
      type: "http",
      url: "https://open.dexter.cash/mcp",
    },
  });
  await assert.rejects(access(resolve(codexRoot, ".mcp.json")));
  const entry = marketplace.plugins.find(({ name }) => name === "opendexter");
  assert.ok(entry);
  assert.equal(entry.source.path, "./plugins/opendexter");
  assert.equal(entry.policy.authentication, "ON_USE");
});

test("Claude package is self-contained and uses the hosted remote MCP", async () => {
  const manifest = await readJson(
    resolve(claudeRoot, ".claude-plugin/plugin.json"),
  );
  const mcp = await readJson(resolve(claudeRoot, ".mcp.json"));
  const marketplace = await readJson(claudeMarketplacePath);
  assert.equal(manifest.name, "opendexter");
  assert.equal(manifest.version, "2.1.0");
  assert.deepEqual(mcp, {
    mcpServers: {
      opendexter: {
        type: "http",
        url: "https://open.dexter.cash/mcp",
      },
    },
  });
  const entry = marketplace.plugins.find(({ name }) => name === "opendexter");
  assert.ok(entry);
  assert.equal(entry.source, "./opendexter-plugin");
  assert.equal((await inspectTree(claudeRoot)).length > 0, true);
});

test("local package candidate pins its runtime and stdio discovery identity", async () => {
  const workspace = await readJson(resolve(repoRoot, "package.json"));
  const pkg = await readJson(resolve(repoRoot, "packages/mcp/package.json"));
  const toolsPkg = await readJson(
    resolve(repoRoot, "packages/x402-mcp-tools/package.json"),
  );
  const instructionsPkg = await readJson(
    resolve(repoRoot, "packages/mcp-instructions/package.json"),
  );
  const mcp = await readJson(resolve(repoRoot, "mcp.json"));
  assert.equal(workspace.packageManager, "npm@10.9.3");
  assert.equal(workspace.engines.node, ">=20");
  assert.equal(pkg.version, "1.23.1");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
  assert.equal(pkg.dependencies["@modelcontextprotocol/ext-apps"], "1.7.5");
  assert.equal(pkg.dependencies.zod, "3.25.76");
  assert.equal(pkg.dependencies["@dexterai/x402-core"], "1.5.2");
  assert.equal(pkg.dependencies["@dexterai/vault"], "0.43.0");
  assert.equal(pkg.dependencies["@dexterai/mcp-instructions"], "2.4.1");
  assert.equal(pkg.dependencies["@dexterai/x402-mcp-tools"], "0.8.2");
  assert.equal(instructionsPkg.version, "2.4.1");
  assert.equal(toolsPkg.version, "0.8.2");
  assert.equal(toolsPkg.dependencies["@dexterai/x402-core"], "1.5.2");
  assert.deepEqual(mcp, {
    mcpServers: {
      opendexter: {
        command: "npx",
        args: ["-y", "@dexterai/opendexter@1.23.1"],
      },
    },
  });
});

test("release changelog carries stable hosted and candidate local identities", async () => {
  const changelog = await readFile(resolve(repoRoot, "CHANGELOG.md"), "utf8");
  const currentRelease = changelog.slice(0, changelog.indexOf("## 2026-08-01"));
  assert.match(changelog, /Codex `0\.5\.0`/);
  assert.match(changelog, /Claude Code `2\.1\.0`/);
  assert.match(currentRelease, /`@dexterai\/opendexter@1\.23\.1`/);
  assert.match(currentRelease, /`@dexterai\/mcp-instructions@2\.4\.1`/);
  assert.match(currentRelease, /`@dexterai\/x402-core@1\.5\.2`/);
  assert.match(currentRelease, /`@dexterai\/x402-mcp-tools@0\.8\.2`/);
  assert.match(currentRelease, /OpenDexter remains unpublished/);
  assert.match(currentRelease, /hosted refresh remains pending/);
});

test("release train freezes full descriptors and a post-deploy novice suite", async () => {
  const hostedVerifier = await readFile(
    resolve(repoRoot, "packages/mcp/scripts/verify-hosted-source.mjs"),
    "utf8",
  );
  assert.match(hostedVerifier, /release\/open-tool-descriptors\.json/);
  for (const field of [
    "title",
    "description",
    "inputSchema",
    "outputSchema",
    "securitySchemes",
    "annotations",
    "_meta",
    "ui.visibility",
    "openai/widgetAccessible",
  ]) {
    assert.match(hostedVerifier, new RegExp(field));
  }
  for (const invariant of [
    "--show-toplevel",
    "ls-files",
    "refs/replace",
    "ls-remote",
    "--git-dir=/dev/null",
    "GIT_ATTR_NOSYSTEM",
    "core.attributesFile=/dev/null",
    "init",
    "--bare",
    "archive",
    "package-lock.json",
    "npm@",
    "materializeOpenToolDescriptorsFromGit",
    "verifyCrossRepositorySources",
    "apiSourceRoot",
    "facilitatorSourceRoot",
    "GH_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
  ]) {
    assert.match(hostedVerifier, new RegExp(invariant));
  }
  assert.match(hostedVerifier, /pathToFileURL/);
  assert.match(hostedVerifier, /await import\(/);
  const candidateBuilder = await readFile(
    resolve(repoRoot, "packages/mcp/scripts/build-release-candidate.mjs"),
    "utf8",
  );
  assert.match(candidateBuilder, /status: "pending-post-deploy"/);
  assert.match(
    candidateBuilder,
    /requiredAfter: "package-install-and-hosted-activation"/,
  );
  assert.doesNotMatch(candidateBuilder, /--novice-evidence/);

  const casesPath = resolve(repoRoot, "tests/opendexter-novice-routing-cases.json");
  const suite = await readJson(casesPath);
  assert.equal(suite.kind, "opendexter-novice-routing-cases/v1");
  assert.equal(suite.cases.length >= 10, true);
  for (const entry of suite.cases) {
    assert.doesNotMatch(entry.prompt, TOOL_NAME);
    assert.doesNotMatch(
      entry.prompt,
      /\b(?:intentId|operationId|maxAmountAtomic|amountAtomic|tool name|call the tool)\b/i,
    );
  }
  const check = suite.cases.find(({ id }) => id === "hosted-check-known-endpoint");
  assert.equal(check.expectedConsequence, "durable-quote-intent");
  assert.deepEqual(check.forbiddenTools, ["x402_fetch"]);

  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(repoRoot, "tests/opendexter-novice-routing-evaluation.mjs")],
  );
  assert.match(stdout, /no execution evidence was claimed/);
});

test("both formats expose only the three hosted-contract skills", async () => {
  assert.deepEqual(await packageSkillNames(codexRoot), [...EXPECTED_SKILLS]);
  assert.deepEqual(await packageSkillNames(claudeRoot), [...EXPECTED_SKILLS]);
  for (const root of [codexRoot, claudeRoot]) {
    for (const skill of EXPECTED_SKILLS) {
      const path = resolve(root, "skills", skill, "SKILL.md");
      const text = await readFile(path, "utf8");
      const metadata = frontmatter(text, path);
      assert.equal(metadata.name, skill);
      assert.ok(metadata.description.length > 0);
      assert.ok(metadata.description.length <= 1024);
    }
    const umbrella = await readFile(
      resolve(root, "skills/opendexter/SKILL.md"),
      "utf8",
    );
    assert.deepEqual(namedTools(umbrella), [...HOSTED_TOOLS].sort());
    for (const tool of HOSTED_TOOLS) {
      assert.match(umbrella, new RegExp(`\\\`${tool}\\\``));
    }
    assert.doesNotMatch(
      umbrella,
      /\b(?:x402_pay|x402_compose_skill|promote_skill|dexter_passkey(?:_probe)?)\b/,
    );
    assert.match(umbrella, /call `x402_check`/i);
    assert.match(umbrella, /maxAmountAtomic/);
    assert.match(umbrella, /Never automatically retry/i);
    assert.match(umbrella, /canonical `assetId`/);
    assert.match(umbrella, /reusable[\s\S]{0,40}bounded mandate/i);
    assert.match(umbrella, /There is no public authorize tool/i);
    assert.match(
      umbrella,
      /`dexter_execute_asset_action` only with a new stable `operationId` and[\s\S]{0,80}`intentId`/,
    );
  }
});

test("one OpenDexter product brain has honest surface-specific skill editions", async () => {
  const codex = await readFile(
    resolve(codexRoot, "skills/opendexter/SKILL.md"),
    "utf8",
  );
  const claude = await readFile(
    resolve(claudeRoot, "skills/opendexter/SKILL.md"),
    "utf8",
  );
  const local = await readFile(
    resolve(repoRoot, "packages/mcp/skills/opendexter/SKILL.md"),
    "utf8",
  );
  for (const text of [codex, claude, local]) {
    assert.match(text, /share one product truth, safety model, and\s+user-outcome vocabulary/i);
    assert.match(text, /surface-specific/i);
    assert.match(text, /byte-for-byte/i);
  }
  assert.match(codex, /Codex's own Connect\/MCP login/);
  assert.match(claude, /Claude Code's own MCP login/);
  assert.match(local, /local CLI\/MCP edition/);
  assert.notEqual(codex, claude);
  assert.notEqual(codex, local);
  assert.notEqual(claude, local);
});

test("both formats route anonymous five and connected twelve without retired tools", async () => {
  for (const root of [codexRoot, claudeRoot]) {
    const umbrella = await readFile(
      resolve(root, "skills/opendexter/SKILL.md"),
      "utf8",
    );
    const routing = await readFile(
      resolve(root, "skills/opendexter/references/routing-and-safety.md"),
      "utf8",
    );
    assert.deepEqual(namedTools(umbrella), [...HOSTED_TOOLS].sort());
    assert.deepEqual(namedTools(routing), [...HOSTED_TOOLS].sort());
    assert.match(umbrella, /anonymous roster is exactly[\s\S]*connected roster exactly twelve/i);
    assert.match(routing, /Before OAuth[\s\S]*exactly five entry tools/i);
    assert.match(routing, /OAuth adds exactly seven tools[\s\S]*connected roster twelve/i);
    assert.match(routing, /Buy[\s\S]*USDC input budget[\s\S]*6-decimal atomic units/i);
    assert.match(routing, /Sell and Send[\s\S]*selected-asset input/i);
    assert.match(routing, /Execute receives only[\s\S]*`operationId`[\s\S]*`intentId`/i);
    for (const retired of RETIRED_HOSTED_TOOLS) {
      assert.doesNotMatch(umbrella, new RegExp(`\\b${retired}\\b`), retired);
      assert.doesNotMatch(routing, new RegExp(`\\b${retired}\\b`), retired);
    }
  }
});

test("both package auth references preserve the three distinct OAuth identities", async () => {
  for (const root of [codexRoot, claudeRoot]) {
    const auth = await readFile(
      resolve(root, "skills/opendexter/references/authentication.md"),
      "utf8",
    );
    assert.match(auth, /`https:\/\/open\.dexter\.cash\/mcp`/);
    assert.match(auth, /`https:\/\/mcp\.dexter\.cash\/mcp`/);
    assert.match(auth, /`https:\/\/dexter\.cash`/);
    assert.doesNotMatch(auth, /`https:\/\/mcp\.dexter\.cash`/);
  }
});

test("active package guidance contains no old local/card tool routes", async () => {
  for (const root of [codexRoot, claudeRoot]) {
    const text = await activeText(root);
    assert.doesNotMatch(text, LEGACY_ACTIVE_PATTERN);
    assert.doesNotMatch(text, /\b(?:all )?16 tools\b|\bsixteen[- ]tool\b/i);
    assert.doesNotMatch(
      text,
      /\bpurchaseOptions?\b|\bpreparedPurchase\b|\bdirect_exact\b|\bnative_tab\b|\bgateway_(?:cash|credit)\b/,
    );
    assert.match(text, /`x402_status`/);
    assert.match(
      text,
      /Card controls[\s\S]{0,120}secure wallet\s+surface|No hosted card tool|No card tool/i,
    );
  }
});

test("publisher-side app binding stays separate from portable packages", async () => {
  const binding = await readJson(appBindingPath);
  const entries = Object.entries(binding.apps ?? {});
  assert.equal(entries.length, 1);
  assert.match(entries[0][0], /^dev-[a-z0-9]+$/i);
  assert.match(entries[0][1].id, /^asdk_app_[a-z0-9]+$/i);
  const codexEntries = (await inspectTree(codexRoot)).map(({ path }) => path);
  const claudeEntries = (await inspectTree(claudeRoot)).map(({ path }) => path);
  assert.equal(codexEntries.includes(".app.json"), false);
  assert.equal(claudeEntries.includes(".app.json"), false);
  const bindingReadme = await readFile(
    resolve(repoRoot, "chatgpt-app-binding/README.md"),
    "utf8",
  );
  assert.match(bindingReadme, /five anonymous entry tools/i);
  assert.match(bindingReadme, /seven OAuth-promoted tools/i);
  assert.match(bindingReadme, /exactly twelve after connection/i);
  assert.doesNotMatch(bindingReadme, /compatibility (?:tool|endpoint|alias)/i);
  assert.doesNotMatch(bindingReadme, /\bten tools\b|\b10 tools\b/i);
});

test("disposable marketplaces discover both clean source packages", async () => {
  const stage = await mkdtemp(resolve(tmpdir(), "opendexter-marketplace-"));
  try {
    const stagedCodex = resolve(stage, "plugins/opendexter");
    const stagedClaude = resolve(stage, "opendexter-plugin");
    await cp(resolve(repoRoot, ".agents"), resolve(stage, ".agents"), {
      recursive: true,
      dereference: false,
    });
    await cp(resolve(repoRoot, ".claude-plugin"), resolve(stage, ".claude-plugin"), {
      recursive: true,
      dereference: false,
    });
    await cp(codexRoot, stagedCodex, { recursive: true, dereference: false });
    await cp(claudeRoot, stagedClaude, { recursive: true, dereference: false });

    const stagedCodexMarketplace = await readJson(
      resolve(stage, ".agents/plugins/marketplace.json"),
    );
    const stagedClaudeMarketplace = await readJson(
      resolve(stage, ".claude-plugin/marketplace.json"),
    );
    const codexEntry = stagedCodexMarketplace.plugins.find(
      ({ name }) => name === "opendexter",
    );
    const claudeEntry = stagedClaudeMarketplace.plugins.find(
      ({ name }) => name === "opendexter",
    );
    assert.ok(codexEntry);
    assert.ok(claudeEntry);
    assert.equal(
      resolve(stage, codexEntry.source.path),
      stagedCodex,
    );
    assert.equal(resolve(stage, claudeEntry.source), stagedClaude);

    const sourceCodex = await inspectTree(codexRoot);
    const sourceClaude = await inspectTree(claudeRoot);
    assert.deepEqual(await inspectTree(stagedCodex), sourceCodex);
    assert.deepEqual(await inspectTree(stagedClaude), sourceClaude);
    assert.deepEqual(await packageSkillNames(stagedCodex), [...EXPECTED_SKILLS]);
    assert.deepEqual(await packageSkillNames(stagedClaude), [...EXPECTED_SKILLS]);
    assert.equal(
      (await readJson(resolve(stagedCodex, ".codex-plugin/plugin.json"))).name,
      "opendexter",
    );
    assert.equal(
      (await readJson(resolve(stagedClaude, ".claude-plugin/plugin.json"))).name,
      "opendexter",
    );
    assert.deepEqual(
      (await readJson(resolve(stagedCodex, ".codex-plugin/plugin.json")))
        .mcpServers,
      (await readJson(resolve(codexRoot, ".codex-plugin/plugin.json")))
        .mcpServers,
    );
    assert.deepEqual(
      await readJson(resolve(stagedClaude, ".mcp.json")),
      await readJson(resolve(claudeRoot, ".mcp.json")),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
