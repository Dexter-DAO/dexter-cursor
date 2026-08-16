#!/usr/bin/env node

import { copyFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const mode = process.argv[2] ?? "--check";

if (!new Set(["--check", "--write"]).has(mode) || process.argv.length > 3) {
  throw new Error(
    "usage: node scripts/sync-hosted-plugin-skills.mjs [--check|--write]",
  );
}

const sharedFiles = Object.freeze([
  "opendexter/SKILL.md",
  "opendexter/references/authentication.md",
  "opendexter/references/routing-and-safety.md",
  "x402-debugging/SKILL.md",
  "x402-protocol/SKILL.md",
]);

const canonicalRoot = resolve(repoRoot, "plugins/opendexter/skills");
const claudeRoot = resolve(repoRoot, "opendexter-plugin/skills");

for (const relativePath of sharedFiles) {
  const source = resolve(canonicalRoot, relativePath);
  const target = resolve(claudeRoot, relativePath);
  const canonical = await readFile(source);

  if (mode === "--write") {
    await copyFile(source, target);
    continue;
  }

  const generated = await readFile(target);
  if (!canonical.equals(generated)) {
    throw new Error(
      `hosted skill drift: ${relativePath}; run with --write and review the generated diff`,
    );
  }
}

console.log(
  mode === "--write"
    ? `synchronized ${sharedFiles.length} hosted skill files`
    : `hosted skill parity ok (${sharedFiles.length} files)`,
);
