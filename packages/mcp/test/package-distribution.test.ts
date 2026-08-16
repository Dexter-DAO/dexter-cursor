import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const sharedInstructionsRoot = resolve(packageRoot, "../mcp-instructions");
const sharedToolsRoot = resolve(packageRoot, "../x402-mcp-tools");

function read(relative: string): string {
  return readFileSync(join(packageRoot, relative), "utf8");
}

function directoryEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function textFiles(relative: string): string[] {
  const absolute = join(packageRoot, relative);
  const stat = lstatSync(absolute);
  if (stat.isFile()) return [relative];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(relative, entry.name);
    return entry.isDirectory() ? textFiles(child) : [child];
  });
}

function expectExactExecutableReferences(
  path: string,
  text: string,
  exact: string,
): void {
  expect(text, path).not.toContain("@dexterai/opendexter@latest");
  expect(text, path).not.toContain("@dexterai/opendexter@next");
  expect(text, path).not.toMatch(
    /npx(?:\s+-y)?\s+@dexterai\/opendexter(?!@)/,
  );
  expect(text, path).not.toMatch(
    /npm\s+(?:install|i)(?:\s+-g)?\s+@dexterai\/opendexter(?!@)/,
  );
  for (const reference of text.match(
    /@dexterai\/opendexter@[0-9][0-9A-Za-z.-]*/g,
  ) ?? []) {
    expect(reference, path).toBe(exact);
  }
}

describe("local package distribution", () => {
  it("reports its own version instead of the embedding application's version", () => {
    const consumer = mkdtempSync(join(tmpdir(), "opendexter-version-consumer-"));
    try {
      writeFileSync(
        join(consumer, "package.json"),
        `${JSON.stringify({ name: "consumer", version: "1.0.0" })}\n`,
      );
      const packageManifest = JSON.parse(read("package.json"));
      const result = spawnSync(
        process.execPath,
        [
          require.resolve("tsx/cli"),
          join(packageRoot, "src/index.ts"),
          "--version",
        ],
        {
          cwd: consumer,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: consumer,
            CODEX_HOME: join(consumer, ".codex"),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(packageManifest.version);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("ships the promised canonical license in shared packages", () => {
    const canonicalLicense = readFileSync(join(packageRoot, "LICENSE"));
    for (const [name, root] of [
      ["@dexterai/mcp-instructions", sharedInstructionsRoot],
      ["@dexterai/x402-mcp-tools", sharedToolsRoot],
    ] as const) {
      const manifest = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      );
      const licensePath = join(root, "LICENSE");

      expect(manifest.files, `${name} package files`).toContain("LICENSE");
      expect(existsSync(licensePath), `${name} LICENSE`).toBe(true);
      expect(readFileSync(licensePath), `${name} LICENSE bytes`).toEqual(
        canonicalLicense,
      );
    }
  });

  it("prepares MCP instructions through one truthful dual-format release path", () => {
    const manifest = JSON.parse(
      readFileSync(join(sharedInstructionsRoot, "package.json"), "utf8"),
    );
    const checker = readFileSync(
      join(sharedInstructionsRoot, "scripts/check-module-formats.mjs"),
      "utf8",
    );

    expect(manifest.version).toBe("2.4.1");
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("dist/index.cjs");
    expect(manifest.module).toBe("dist/index.js");
    expect(manifest.types).toBe("dist/index.d.ts");
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
    });
    expect(manifest.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(manifest.scripts.build).toContain("--format esm,cjs");
    expect(manifest.scripts.build).toContain("--no-sourcemap");
    expect(manifest.scripts["release:prepare"]).toBe(
      "npm run typecheck && npm test && npm run build && node ./scripts/check-module-formats.mjs",
    );
    expect(manifest.scripts.prepublishOnly).toBe("npm run release:prepare");
    expect(manifest.scripts.release).toBe(
      "npm publish --access public --tag latest",
    );
    expect(manifest.scripts.release).not.toContain("npm version");
    expect(manifest.publishConfig).toEqual({ access: "public", tag: "latest" });

    expect(checker).toContain("EXPECTED_RUNTIME_EXPORTS");
    expect(checker).toContain("createRequire");
    expect(checker).toContain("await import(manifest.name)");
    expect(checker).toContain("entry.isFile()");
    expect(checker).toContain('file.endsWith(".map")');
    expect(checker).toContain('"buildServerInstructions"');
    expect(checker).toContain('"assertInstructionRosterParity"');
    expect(checker).toContain("SERVER_INSTRUCTIONS_VERSION !== manifest.version");
  });

  it("prepares x402 MCP tools through one truthful dual-format release path", () => {
    const manifest = JSON.parse(
      readFileSync(join(sharedToolsRoot, "package.json"), "utf8"),
    );
    const checker = readFileSync(
      join(sharedToolsRoot, "scripts/check-module-formats.mjs"),
      "utf8",
    );
    const prepareSteps = [
      "npm run typecheck --workspace=@dexterai/dextercard",
      "npm run build --workspace=@dexterai/dextercard",
      "npm run typecheck",
      "npm run build",
      "node ./scripts/check-no-sourcemaps.cjs",
      "node ./scripts/check-module-formats.mjs",
    ];

    expect(manifest.version).toBe("0.9.0-rc.0");
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("dist/index.cjs");
    expect(manifest.module).toBe("dist/index.js");
    expect(manifest.types).toBe("dist/index.d.ts");
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
    });
    expect(manifest.dependencies["@dexterai/x402-core"]).toBe("1.5.2");
    expect(manifest.dependencies["@dexterai/vault"]).toBe("0.43.1");
    expect(manifest.dependencies["@dexterai/x402"]).toBe("6.0.0-rc.0");
    expect(manifest.engines.node).toBe(">=22");
    expect(manifest.scripts.build).toContain("--format esm,cjs");
    expect(manifest.scripts.build).toContain("--no-sourcemap");
    expect(manifest.scripts.dev).toContain("--format esm,cjs");
    expect(manifest.scripts.dev).toContain("--no-sourcemap");
    expect(manifest.scripts["release:prepare"]).toBe(
      prepareSteps.join(" && "),
    );
    expect(manifest.scripts.prepublishOnly).toBe("npm run release:prepare");
    expect(manifest.scripts.release).toBe("npm publish --access public");
    expect(manifest.scripts.release).not.toContain("npm version");

    expect(checker).toContain('manifest.exports?.["."]');
    expect(checker).toContain("createRequire");
    expect(checker).toContain("EXPECTED_RUNTIME_EXPORTS");
    expect(checker).toContain('file.endsWith(".map")');
    expect(checker).toContain("await import(manifest.name)");
    expect(checker).toContain("sellerAcceptSha256");
    expect(checker).toContain('"composeAllTools"');
    expect(checker).toContain('"PURCHASE_CONTRACT_VERSION"');
  });

  it("ships one valid Cursor identity with a release-pinned stdio command", () => {
    const pkg = JSON.parse(read("package.json"));
    const manifest = JSON.parse(read(".cursor-plugin/plugin.json"));
    const mcp = JSON.parse(read("cursor-mcp.json"));

    expect(manifest.name).toBe("opendexter");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.logo).toBe("assets/dexter-wordmark.svg");
    expect(existsSync(join(packageRoot, manifest.logo))).toBe(true);
    expect(pkg.dependencies["@dexterai/mcp-instructions"]).toBe("2.4.1");
    expect(pkg.dependencies["@dexterai/x402-mcp-tools"]).toBe("0.9.0-rc.0");
    expect(pkg.dependencies["@dexterai/vault"]).toBe("0.43.1");
    expect(pkg.dependencies["@dexterai/x402"]).toBe("6.0.0-rc.0");
    expect(pkg.dependencies["@dexterai/x402-core"]).toBe("1.5.2");
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    expect(pkg.dependencies.zod).toBe("3.25.76");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.scripts.version).toBe("npm run version:sync");
    expect(pkg.scripts.prepack).toBe("npm run version:check");
    expect(mcp.mcpServers.opendexter).toEqual({
      command: "npx",
      args: ["-y", `@dexterai/opendexter@${pkg.version}`],
    });
  });

  it("has no obsolete root Cursor manifest or broken plugin-directory aliases", () => {
    expect(existsSync(join(repositoryRoot, ".cursor-plugin", "plugin.json"))).toBe(false);
    for (const path of ["agents", "commands", "rules", "skills"]) {
      expect(directoryEntryExists(join(repositoryRoot, path))).toBe(false);
    }
  });

  it("copies exactly the four registered x402 widgets and recreates the output", () => {
    const copyScript = read("scripts/copy-widgets.mjs");
    for (const file of [
      "x402-marketplace-search.html",
      "x402-fetch-result.html",
      "x402-pricing.html",
      "x402-wallet.html",
    ]) {
      expect(copyScript).toContain(`'${file}'`);
    }
    expect(copyScript).not.toMatch(/\bcard-(?:status|issue|link-wallet)\.html\b/);
    expect(copyScript).toContain("rmSync(DEST, { recursive: true, force: true })");
    expect(copyScript).toContain("process.env.DEXTER_WIDGET_SOURCE");
    expect(copyScript).toContain("DEXTER_WIDGET_SOURCE is incomplete");
    expect(copyScript.indexOf("EXPLICIT_SOURCE")).toBeLessThan(
      copyScript.indexOf("else if (liveExists)"),
    );
  });

  it("does not retain a carrier domain in the x402 widget CSP", () => {
    const resources = read("src/resources/widgets.ts");
    expect(resources).not.toContain("agents.moonpay.com");
    expect(resources).not.toContain("Dextercard widgets");
  });

  it("keeps tarball inspection distinct from registry-only install proof", () => {
    const inspectScript = read("scripts/inspect-package-tarball.sh");
    expect(inspectScript).toContain("CANDIDATE_TARBALL");
    expect(inspectScript).toContain("package-provenance.mjs");
    expect(inspectScript).toContain("--package-root");
    expect(inspectScript).not.toContain("npm install");

    const installScript = read("scripts/test-registry-install.sh");
    expect(installScript).toContain("--registry=https://registry.npmjs.org");
    expect(installScript).toContain("--save-exact");
    expect(installScript).toContain('"$PACKAGE_SPEC"');
    expect(installScript).toContain("verify-registry");
    expect(installScript).toContain("dist.integrity");
    expect(installScript).toContain("OPENDXTER_REGISTRY_METADATA_FILE");
    expect(installScript).toContain("--require-pure-js");
    expect(installScript).toContain("npm ls --all");
    expect(installScript).not.toContain("CANDIDATE_TARBALL");

    const compatibilityScript = read("scripts/test-fresh-install.sh");
    expect(compatibilityScript).toContain("inspect-package-tarball.sh");
  });

  it("inspects pack contents without recursively running package lifecycles", () => {
    const verifier = read("verify-pack-no-sourcemaps.mjs");
    expect(verifier).toContain('"--ignore-scripts"');
    expect(verifier).toContain('"--dry-run"');
    expect(verifier).toContain('"--json"');
  });

  it("builds once from the locked archive and publishes only that immutable tarball", () => {
    const candidate = read("scripts/build-release-candidate.mjs");
    expect(candidate).toContain('"archive"');
    expect(candidate).toContain('["ci", "--ignore-scripts"]');
    expect(candidate.match(/"pack"/g)).toHaveLength(1);
    expect(candidate.match(/ignoreScripts: (?:false|true)/g)).toHaveLength(2);
    expect(candidate).toContain("toolchain: rebuilt.toolchain");
    expect(candidate).toContain("stageReviewedToolchain");
    expect(candidate).toContain("hostedContractRelativePath");
    expect(candidate).toContain("process.umask(0o022)");

    const publish = read("scripts/publish-release-candidate.mjs");
    const provenance = read("scripts/package-provenance.mjs");
    const hosted = read("scripts/verify-hosted-source.mjs");
    const publicHosted = read("scripts/public-hosted-release.mjs");
    const githubHosted = read("scripts/github-hosted-release.mjs");
    const toolchain = read("scripts/reviewed-toolchain.mjs");
    const toolchainPin = JSON.parse(
      read("release/reviewed-node-npm-toolchain.json"),
    );
    expect(publish).toContain("Local OpenDexter publishing is disabled");
    expect(publish).toContain("publish-opendexter.yml");
    expect(publish).not.toContain("OPENDXTER_RELEASE_NPM_TOKEN");
    expect(provenance).toContain('"publish"');
    expect(provenance).toContain('"--ignore-scripts"');
    expect(provenance).toContain('"--access"');
    expect(provenance).toContain('"public"');
    expect(publish).not.toContain("...process.env");
    expect(githubHosted).toContain('from "./build-release-candidate.mjs"');
    expect(githubHosted).toContain("buildReviewedReleaseArtifact({");
    expect(githubHosted).toContain("runValidation: true");
    expect(githubHosted).toContain("validatePublishBundle({");
    expect(githubHosted).toContain("validateProvenanceStatement");
    expect(githubHosted).toContain("publisher-npm");
    expect(githubHosted).toContain("verifyFrozenPublicHostedSource");
    expect(githubHosted).not.toContain("apiSourceRoot");
    expect(githubHosted).not.toContain("facilitatorSourceRoot");
    expect(githubHosted).not.toContain("GH_TOKEN");
    expect(publicHosted).toContain("https://open.dexter.cash/health");
    expect(publicHosted).toContain("materializeArchivedPublicHostedSource");
    expect(hosted).toContain("materializeOpenToolDescriptorsFromGit");
    expect(hosted).toContain("verifyCrossRepositorySources: false");
    expect(hosted).toContain("verifyCrossRepositorySources: true");
    expect(hosted).toContain("apiSourceRoot");
    expect(hosted).toContain("facilitatorSourceRoot");
    expect(hosted).toContain("GH_TOKEN");
    expect(toolchain).toContain("private reviewed Node/npm toolchain snapshot");
    expect(toolchainPin.kind).toBe("opendexter-reviewed-node-npm-toolchain/v1");
    expect(toolchainPin.runtime.toolchainInventory.length).toBeGreaterThan(2_000);
    expect(toolchainPin.runtime.toolchainInventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "bin/node" }),
      expect.objectContaining({ path: "lib/node_modules/npm/bin/npm-cli.js" }),
      expect.objectContaining({ path: "lib/node_modules/npm/lib/cli.js" }),
    ]));
  });

  it("requires a final source-owned complete hosted descriptor", () => {
    const verifier = read("scripts/verify-hosted-source.mjs");
    expect(verifier).toContain('release/open-tool-descriptors.json');
    expect(verifier).toContain('scripts/materialize-open-tool-descriptors.mjs');
    expect(verifier).toContain('materializeOpenToolDescriptorsFromGit');
    expect(verifier).toContain('verifyCrossRepositorySources: true');
    expect(verifier).toContain('EXPECTED_HOSTED_SOURCE_REPOSITORY');
    expect(verifier).toContain('verifyMaterializedHostedDescriptor');
    expect(verifier).toContain('optional-OAuth roster');
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
      expect(verifier).toContain(field);
    }
    expect(verifier).toContain('--show-toplevel');
    expect(verifier).toContain('ls-files');
    expect(verifier).toContain('refs/replace');
    expect(verifier).toContain('ls-remote');
    expect(verifier).toContain('--git-dir=/dev/null');
    expect(verifier).toContain('GIT_ATTR_NOSYSTEM');
    expect(verifier).toContain('core.attributesFile=/dev/null');
    expect(verifier).toContain('"--bare"');
    expect(verifier).toContain('archive');
    expect(verifier).toContain('status');
  });

  it("pins every executable RC guidance reference to the package version", () => {
    const pkg = JSON.parse(read("package.json"));
    const exact = `@dexterai/opendexter@${pkg.version}`;
    const guidance = [
      "README.md",
      ".cursor-plugin/plugin.json",
      "cursor-mcp.json",
      ...["agents", "assets/docs", "commands", "rules", "skills"].flatMap(textFiles),
    ];

    for (const path of guidance) {
      expectExactExecutableReferences(path, read(path), exact);
    }
    for (const path of [
      "README.md",
      "mcp.json",
      "docs/connect-your-wallet.md",
      "docs/connect-your-wallet.html",
    ]) {
      expectExactExecutableReferences(
        path,
        readFileSync(join(repositoryRoot, path), "utf8"),
        exact,
      );
    }

    const repositoryReadme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
    expect(repositoryReadme).toContain(
      "The stable npm channel remains available as `@latest`",
    );
    expect(repositoryReadme).not.toMatch(
      /npx(?:\s+-y)?\s+@dexterai\/opendexter@latest/,
    );
    expect(repositoryReadme).toContain(`npx ${exact} setup`);
  });

  it("pins relayable runtime CLI hints to the running package", async () => {
    const { cliHint } = await import("../src/cli-hint.js");
    const { staleNotice } = await import("../src/staleness.js");
    const { VERSION } = await import("../src/config.js");
    expect(cliHint("tab connect https://seller.example")).toBe(
      `npx -y @dexterai/opendexter@${VERSION} tab connect https://seller.example`,
    );
    expect(cliHint("tab connect https://seller.example")).not.toContain(
      "@latest",
    );
    expect(staleNotice("1.24.0", VERSION, "startup")).toContain(
      "npm i -g @dexterai/opendexter@1.24.0",
    );
    expect(staleNotice("1.24.0", VERSION, "startup")).not.toContain("@latest");
  });

  it("keeps settings as a CLI command with no dormant MCP registrar", () => {
    const settings = read("src/tools/settings.ts");
    expect(settings).toContain("export async function cliSettings");
    expect(settings).not.toContain("registerSettingsTool");
    expect(settings).not.toContain("x402_settings");
    expect(settings).not.toContain("server.tool");
  });

  it("ships a read-only doctor command and explicit registration-name control", () => {
    const cli = read("src/index.ts");
    const doctor = read("src/cli/doctor.ts");
    expect(cli).toContain('"doctor"');
    expect(cli).toContain('"registration-name"');
    expect(doctor).toContain("Doctor is read-only");
    expect(doctor).toContain("configurationIsApproval: false");
    expect(doctor).not.toContain("getAllBalances");
    expect(doctor).not.toContain("loadOrCreateWallet");
    expect(cli).toContain('const doctorInvocation = invokedCommand === "doctor"');
    expect(cli.match(/if \(!doctorInvocation\)/g)).toHaveLength(2);
  });

  it("keeps card operations but removes internal card registrar sources", () => {
    for (const path of [
      "src/compose-cards.ts",
      "src/card-widget-meta.ts",
      "src/tools/cards/status.ts",
      "src/tools/cards/issue.ts",
      "src/tools/cards/freeze.ts",
      "src/tools/cards/link-wallet.ts",
    ]) {
      expect(existsSync(join(sharedToolsRoot, path)), path).toBe(false);
    }

    expect(existsSync(join(sharedToolsRoot, "src/card-operations.ts"))).toBe(true);
    expect(existsSync(join(sharedToolsRoot, "src/remote-card-operations.ts"))).toBe(true);
    const publicEntry = readFileSync(join(sharedToolsRoot, "src/index.ts"), "utf8");
    expect(publicEntry).toMatch(/export type \{\s*CardsAdapter\s*\}/);
    expect(publicEntry).not.toMatch(/registerCard(?:Status|Issue|Freeze|LinkWallet)Tool/);
  });
});
