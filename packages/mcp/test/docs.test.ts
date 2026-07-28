import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_ASSETS_DIR } from "../src/resources/docs.js";
import { LOCAL_TOOL_ROSTER } from "../src/server/index.js";

const LOCAL_TOOLS = [...LOCAL_TOOL_ROSTER].sort();
const HOSTED_ONLY_TOOLS = [
  "dexter_passkey",
  "dexter_passkey_probe",
  "promote_skill",
  "x402_compose_skill",
];

const TOOL_NAME =
  /\b(?:x402_[a-z_]+|card_[a-z_]+|dexter_[a-z_]+|promote_skill)\b/g;

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
  return [...new Set(text.match(TOOL_NAME) ?? [])].sort();
}

function plainText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const rootReadme = read("../../../README.md");
const packageReadme = read("../README.md");
const skill = read("../skills/opendexter/SKILL.md");
const workflow = read("../assets/docs/workflow.md");
const connectMarkdown = read("../../../docs/connect-your-wallet.md");
const connectHtml = read("../../../docs/connect-your-wallet.html");
const onboardingSource = read("../src/cli/onboard.ts");
const rootReadmePath = fileURLToPath(new URL("../../../README.md", import.meta.url));
const packageReadmePath = fileURLToPath(new URL("../README.md", import.meta.url));

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
  it("docs assets ship with the package", () => {
    for (const f of ["workflow.md", "protocol.md", "debugging.md"]) {
      expect(existsSync(join(DOCS_ASSETS_DIR, f))).toBe(true);
    }
  });

  it.each([
    ["package README", packageReadme],
    ["installable skill", stripFrontmatter(skill)],
    ["served workflow", workflow],
  ])("%s documents exactly the local eight-tool roster", (_name, text) => {
    expect(namedTools(text)).toEqual(LOCAL_TOOLS);
  });

  it("keeps hosted-only tools out of the local skill", () => {
    for (const tool of HOSTED_ONLY_TOOLS) {
      expect(skill).not.toContain(`\`${tool}\``);
    }
    expect(skill).toContain("local Solana/EVM payment wallet");
    expect(skill).toContain("connected Dexter Wallet portfolio");
    expect(skill).toContain("Do not apply hosted passkey-enrollment");
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
    ["root README", rootReadme],
    ["package README", packageReadme],
    ["Connect Markdown", connectMarkdown],
    ["Connect HTML", connectHtml],
  ])("%s states the local Connect payment boundary", (_name, text) => {
    const copy = plainText(text);
    expect(copy).toContain("does not change the payment signer");
    expect(copy).toContain("local paid calls still use the local wallet");
    expect(copy).not.toMatch(
      /see (?:your wallet|it) and pay (?:for things|from it)|pay from your (?:real )?(?:dexter )?(?:wallet|vault)(?: balance)?/,
    );
  });

  it.each([
    ["root README", rootReadme],
    ["package README", packageReadme],
    ["Connect Markdown", connectMarkdown],
    ["Connect HTML", connectHtml],
  ])("%s excludes superseded payment and wallet claims", (_name, text) => {
    expect(text).not.toContain("pay from your vault balance");
    expect(text).not.toContain("see your wallet and pay for things");
    expect(text).not.toContain("see it and pay from it");
    expect(text).not.toMatch(/\bcall any x402 API\b/i);
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

  it("describes the stored per-call limit as a default, not a hard wallet ceiling", () => {
    for (const text of [rootReadme, packageReadme, skill, workflow]) {
      expect(text).not.toMatch(/enforces? a per-call USDC ceiling/i);
      expect(text).not.toContain("no single call may exceed this amount");
    }
    expect(rootReadme).toContain("default per-call USDC limit");
    expect(packageReadme).toContain("default limit when a call supplies no override");
  });

  it("labels the hosted connector as a release candidate", () => {
    expect(plainText(rootReadme)).toMatch(
      /release candidates? pending final client-host validation/,
    );
    expect(rootReadme).toContain("### Hosted release candidate");
  });
});
