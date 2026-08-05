import { describe, it, expect } from "vitest";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_ASSETS_DIR } from "../src/resources/docs.js";
import { LOCAL_TOOL_ROSTER } from "../src/server/index.js";

const LOCAL_TOOLS = [...LOCAL_TOOL_ROSTER].sort();
const RETIRED_TOOL_NAMES = [
  "dexter_passkey",
  "dexter_passkey_probe",
  "promote_skill",
  "x402_compose_skill",
  "x402_pay",
  "x402_settings",
];
const RETIRED_PURCHASE_CONTRACT = [
  "preparedPurchase",
  "purchaseOptions",
  "direct_exact",
  "native_tab",
  "gateway_cash",
  "gateway_credit",
  "six-tool",
  "six tools",
];
const RETIRED_LOCAL_EXECUTOR_CLAIMS = [
  "uses a local Solana/EVM payment wallet",
  "pays with the local wallet file",
  "local paid calls still use the local wallet",
  "local wallet lives at",
  "configured environment keys",
  "does not change the payment signer",
];

const TOOL_NAME =
  /`((?:x402_[a-z_]+|card_[a-z_]+|dexter_[a-z_]+|promote_skill))`/g;

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function stripFrontmatter(text: string): string {
  return normalize(text).replace(/^---\n[\s\S]*?\n---\n+/, "");
}

function namedTools(text: string): string[] {
  return [...new Set([...text.matchAll(TOOL_NAME)].map((match) => match[1]))]
    .sort();
}

function plainText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function textFiles(relative: string): string[] {
  const absolute = fileURLToPath(new URL(`../${relative}`, import.meta.url));
  const stat = lstatSync(absolute);
  if (stat.isFile()) return [relative];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(relative, entry.name);
    return entry.isDirectory() ? textFiles(child) : [child];
  });
}

const rootReadme = read("../../../README.md");
const packageReadme = read("../README.md");
const skill = read("../skills/opendexter/SKILL.md");
const workflow = read("../assets/docs/workflow.md");
const engineer = read("../agents/x402-engineer.md");
const codingRule = read("../rules/x402-coding.mdc");
const protocolRule = read("../rules/x402-protocol.mdc");
const setupCommand = read("../commands/setup-opendexter.md");
const onboardingSource = read("../src/cli/onboard.ts");
const packageManifest = JSON.parse(read("../package.json")) as {
  description: string;
};
const cursorManifest = JSON.parse(read("../.cursor-plugin/plugin.json")) as {
  description: string;
};
const rootReadmePath = fileURLToPath(new URL("../../../README.md", import.meta.url));
const packageReadmePath = fileURLToPath(new URL("../README.md", import.meta.url));

const AUTHORITATIVE_RUNTIME_GUIDANCE = [
  ["package README", packageReadme],
  ["installable skill", stripFrontmatter(skill)],
  ["served workflow", workflow],
  ["specialist agent", stripFrontmatter(engineer)],
  ["coding rule", stripFrontmatter(codingRule)],
  ["protocol rule", stripFrontmatter(protocolRule)],
  ["setup command", stripFrontmatter(setupCommand)],
] as const;

const PACKAGED_GUIDANCE_PATHS = [
  "README.md",
  ".cursor-plugin/plugin.json",
  "cursor-mcp.json",
  ...["agents", "assets/docs", "commands", "rules", "skills"].flatMap(textFiles),
];

function localTargets(text: string): string[] {
  const markdownLinks = [...text.matchAll(/\]\((\.\.?\/[^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1]);
  const htmlSources = [...text.matchAll(/\bsrc="(\.\.?\/[^"#]+)"/g)]
    .map((match) => match[1]);
  const htmlLinks = [...text.matchAll(/\bhref="(\.\.?\/[^"#]+|LICENSE)"/g)]
    .map((match) => match[1]);
  return [...new Set([...markdownLinks, ...htmlSources, ...htmlLinks])];
}

describe("docs resources", () => {
  it("ships every registered docs asset", () => {
    for (const file of ["workflow.md", "protocol.md", "debugging.md"]) {
      expect(existsSync(join(DOCS_ASSETS_DIR, file))).toBe(true);
    }
  });

  it.each(AUTHORITATIVE_RUNTIME_GUIDANCE)(
    "%s freezes the exact hosted-only seven-tool roster",
    (_name, text) => {
      expect(namedTools(text)).toEqual(LOCAL_TOOLS);
      expect(LOCAL_TOOLS).toEqual([
        "dexter_portfolio",
        "x402_access",
        "x402_check",
        "x402_fetch",
        "x402_search",
        "x402_status",
        "x402_wallet",
      ]);
    },
  );

  it.each(AUTHORITATIVE_RUNTIME_GUIDANCE)(
    "%s freezes opaque-intent execution, status recovery, and OAuth authority",
    (_name, text) => {
      expect(text).toContain("intentId");
      expect(text).toContain("maxAmountAtomic");
      expect(text).toContain("x402_status");
      expect(text).toMatch(/OAuth bearer|OAuth-bearer|connected bearer/i);
      expect(text).toMatch(/never|no local/i);
      for (const retired of [
        ...RETIRED_TOOL_NAMES,
        ...RETIRED_PURCHASE_CONTRACT,
        ...RETIRED_LOCAL_EXECUTOR_CLAIMS,
      ]) {
        expect(text).not.toContain(retired);
      }
    },
  );

  it("keeps retired execution contracts out of every packaged guidance file", () => {
    for (const path of PACKAGED_GUIDANCE_PATHS) {
      const text = read(`../${path}`);
      for (const retired of RETIRED_PURCHASE_CONTRACT) {
        expect(text, path).not.toContain(retired);
      }
    }
  });

  it("keeps package and Cursor descriptions on the hosted governed runtime", () => {
    for (const description of [
      packageManifest.description,
      cursorManifest.description,
    ]) {
      expect(description).toMatch(/hosted governed x402 runtime/i);
      expect(description).toMatch(/seven tools|status recovery|reconcile/i);
      expect(description).not.toMatch(/local (?:signer|payment wallet)/i);
      expect(description).not.toMatch(/prepared purchase/i);
    }
  });

  it("freezes the connected bearer audience and exact requested scopes", () => {
    for (const text of [packageReadme, skill, workflow, setupCommand]) {
      expect(text).toContain("https://open.dexter.cash/mcp");
      expect(text).toContain("vault dexter_surface");
    }
  });

  it("marks every shipped private-key SDK example as a separate non-fallback executor", () => {
    for (const path of PACKAGED_GUIDANCE_PATHS) {
      const text = read(`../${path}`);
      if (!/walletPrivateKey|SOLANA_PRIVATE_KEY|EVM_PRIVATE_KEY/.test(text)) continue;
      const copy = plainText(text);
      expect(copy, path).toContain("not the opendexter mcp runtime");
      expect(copy, path).toMatch(/\bnever\b|must never/i);
    }
  });

  it("updates adjacent shipped workflows that can cause payment or mutation", () => {
    const advertiser = read("../skills/instinct-advertiser/SKILL.md");
    expect(advertiser).toContain("intentId");
    expect(advertiser).toContain("maxAmountAtomic");
    expect(advertiser).toContain("x402_status");
    expect(advertiser).toContain("not an OpenDexter fallback");

    const discoverable = read("../skills/x402-discoverable/SKILL.md");
    expect(discoverable).toContain("server-side merchant test");
    expect(discoverable).toContain("does not load a local signer");
    expect(discoverable).toContain("Obtain explicit approval");
  });

  it.each([
    ["package README", packageReadme],
    ["OpenDexter skill", skill],
    ["served workflow", workflow],
  ])("%s contains no orphan card tools", (_name, text) => {
    expect(text).not.toMatch(/\bcard_[a-z_]+\b/);
    expect(text).not.toContain("Dextercard tools");
    expect(text).not.toContain("card family");
  });

  it.each([
    ["root README", rootReadme, rootReadmePath],
    ["package README", packageReadme, packageReadmePath],
  ])("%s has no broken local file links", (_name, text, readmePath) => {
    for (const target of localTargets(text)) {
      expect(
        existsSync(resolve(dirname(readmePath), target)),
        `missing local target: ${target}`,
      ).toBe(true);
    }
  });

  it("keeps npx setup follow-up commands runnable without a global install", () => {
    expect(onboardingSource).not.toMatch(/(?:Run|start with) `opendexter /);
    expect(onboardingSource).toContain(
      "const cli = `npx @dexterai/opendexter@${VERSION}`",
    );
    for (const command of ["wallet", "search", "check", "fetch"]) {
      expect(onboardingSource).toContain(`\${cli} ${command}`);
    }
  });

  it("states that legacy local settings do not govern hosted authority", () => {
    for (const text of [packageReadme, skill, workflow]) {
      expect(plainText(text)).toMatch(
        /legacy local settings?.*(?:no effect|does not govern)/,
      );
      expect(text).not.toMatch(/local paid calls still use/i);
    }
  });

  it("labels the hosted connector as a released public plugin", () => {
    expect(rootReadme).toContain("### Hosted connector");
    expect(rootReadme).toContain(
      "codex plugin marketplace add Dexter-DAO/opendexter-ide --ref main",
    );
    expect(rootReadme).toContain(
      "claude plugin marketplace add Dexter-DAO/opendexter-ide --scope user",
    );
    expect(plainText(rootReadme)).not.toMatch(
      /release candidates? pending final client-host validation/,
    );
  });
});
