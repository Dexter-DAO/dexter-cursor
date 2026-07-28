import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
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
  it("ships one valid Cursor identity with a release-pinned stdio command", () => {
    const pkg = JSON.parse(read("package.json"));
    const manifest = JSON.parse(read(".cursor-plugin/plugin.json"));
    const mcp = JSON.parse(read("cursor-mcp.json"));

    expect(manifest.name).toBe("opendexter");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.logo).toBe("assets/dexter-wordmark.svg");
    expect(existsSync(join(packageRoot, manifest.logo))).toBe(true);
    expect(pkg.dependencies["@dexterai/mcp-instructions"]).toBe("2.4.0");
    expect(pkg.dependencies["@dexterai/x402-mcp-tools"]).toBe("0.8.0");
    expect(pkg.dependencies["@dexterai/x402-core"]).toBe("^1.5.0");
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe("^1.24.0");
    expect(pkg.dependencies.zod).toBe("^3.25.76");
    expect(pkg.engines.node).toBe(">=20");
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

  it("uses a no-network candidate fixture instead of registry latest", () => {
    const script = read("scripts/test-fresh-install.sh");
    expect(script).toContain("CANDIDATE_TARBALL");
    expect(script).toContain("SOURCE_PACKAGE_JSON");
    expect(script).toContain("tar -xzf");
    expect(script).toContain("pkg.version === expected.version");
    expect(script).toContain('"@dexterai/mcp-instructions"] === "2.4.0"');
    expect(script).toContain('"@dexterai/x402-mcp-tools"] === "0.8.0"');
    expect(script).toContain('"@dexterai/x402-core"] === "^1.5.0"');
    expect(script).toContain('"@modelcontextprotocol/sdk"] === "^1.24.0"');
    expect(script).toContain('pkg.dependencies?.zod === "^3.25.76"');
    expect(script).toContain('pkg.engines?.node === ">=20"');
    expect(script).not.toContain("npx @dexterai/opendexter@latest");
    expect(script).not.toContain("HOME=$TEST_HOME");
  });

  it("inspects pack contents without recursively running package lifecycles", () => {
    const verifier = read("verify-pack-no-sourcemaps.mjs");
    expect(verifier).toContain('"--ignore-scripts"');
    expect(verifier).toContain('"--dry-run"');
    expect(verifier).toContain('"--json"');
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
