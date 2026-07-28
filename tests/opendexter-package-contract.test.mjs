import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const HOSTED_TOOLS = Object.freeze([
  "x402_search",
  "x402_check",
  "x402_fetch",
  "x402_access",
  "x402_wallet",
  "dexter_portfolio",
]);

const RETIRED_HOSTED_TOOLS = Object.freeze([
  "x402_pay",
  "x402_compose_skill",
  "promote_skill",
  "dexter_passkey_probe",
  "dexter_passkey",
]);

const EXPECTED_SCHEMES = Object.freeze({
  x402_search: ["noauth"],
  x402_check: ["noauth"],
  x402_fetch: ["oauth2:vault"],
  x402_access: ["noauth"],
  x402_wallet: ["oauth2:vault"],
  dexter_portfolio: ["oauth2:vault"],
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

test("release fixture is the exact hosted six-tool contract", async () => {
  const contract = await readJson(contractPath);
  assert.equal(contract.contractId, "opendexter-hosted-six-tool-v1");
  assert.equal(contract.mcp.url, "https://open.dexter.cash/mcp");
  assert.equal(contract.mcp.manifestVersion, "0.3.0");
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
    contract.tools.find(({ name }) => name === "x402_fetch").widgetAccessible,
    false,
  );
  assert.deepEqual(
    contract.tools.find(({ name }) => name === "dexter_portfolio"),
    {
      name: "dexter_portfolio",
      securitySchemes: [{ type: "oauth2", scopes: ["vault"] }],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      visibility: ["model"],
      widgetAccessible: false,
    },
  );
  assert.deepEqual(contract.conditionalAuth, []);
  assert.deepEqual(
    contract.tools
      .filter(({ visibility }) => visibility.includes("model"))
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
});

test("Codex package uses one portable remote MCP and mixed-auth marketplace policy", async () => {
  const manifest = await readJson(resolve(codexRoot, ".codex-plugin/plugin.json"));
  const marketplace = await readJson(codexMarketplacePath);
  assert.equal(manifest.name, "opendexter");
  assert.equal(manifest.version, "0.4.0");
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
  assert.equal(manifest.version, "2.0.0");
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
  const mcp = await readJson(resolve(repoRoot, "mcp.json"));
  assert.equal(workspace.packageManager, "npm@10.9.3");
  assert.equal(workspace.engines.node, ">=20");
  assert.equal(pkg.version, "1.23.0-rc.2");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], "^1.24.0");
  assert.equal(pkg.dependencies.zod, "^3.25.76");
  assert.equal(pkg.dependencies["@dexterai/x402-core"], "^1.5.0");
  assert.equal(pkg.dependencies["@dexterai/mcp-instructions"], "2.4.0");
  assert.equal(pkg.dependencies["@dexterai/x402-mcp-tools"], "0.8.0");
  assert.deepEqual(mcp, {
    mcpServers: {
      opendexter: {
        command: "npx",
        args: ["-y", "@dexterai/opendexter@1.23.0-rc.2"],
      },
    },
  });
});

test("release changelog carries stable hosted and candidate local identities", async () => {
  const changelog = await readFile(resolve(repoRoot, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /Codex `0\.4\.0`/);
  assert.match(changelog, /Claude Code `2\.0\.0`/);
  assert.match(changelog, /`@dexterai\/opendexter@1\.23\.0-rc\.2`/);
  assert.match(changelog, /`@dexterai\/mcp-instructions@2\.4\.0`/);
  assert.match(changelog, /`@dexterai\/x402-mcp-tools@0\.8\.0`/);
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
    assert.match(umbrella, /fresh `x402_check`/i);
    assert.match(umbrella, /maxAmountAtomic/);
    assert.match(umbrella, /Never automatically retry/i);
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
    assert.match(
      text,
      /Card tools?[\s\S]{0,80}not available|No hosted card tool|No card tool/i,
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
  assert.match(bindingReadme, /exactly six raw tools/i);
  assert.doesNotMatch(bindingReadme, /compatibility (?:tool|endpoint|alias)/i);
  assert.match(bindingReadme, /`dexter_portfolio`/);
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
