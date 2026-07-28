#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
const exactReference = `@dexterai/opendexter@${packageJson.version}`;
const packageReference =
  /@dexterai\/opendexter@(?:latest|next|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g;
const executableReference =
  /((?:npx(?:\s+-y)?|npm\s+(?:install|i)(?:\s+-g)?)\s+)@dexterai\/opendexter(?:@(?:latest|next|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?))?/g;
const referencePaths = [
  resolve(repositoryRoot, "README.md"),
  resolve(repositoryRoot, "mcp.json"),
  resolve(repositoryRoot, "docs/connect-your-wallet.md"),
  resolve(repositoryRoot, "docs/connect-your-wallet.html"),
  resolve(packageRoot, "README.md"),
  resolve(packageRoot, "cursor-mcp.json"),
  ...["agents", "assets/docs", "commands", "rules", "skills"].flatMap(
    function filesIn(relative) {
      const absolute = resolve(packageRoot, relative);
      return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
        const child = join(relative, entry.name);
        return entry.isDirectory() ? filesIn(child) : resolve(packageRoot, child);
      });
    },
  ),
];
const manifestPath = resolve(packageRoot, ".cursor-plugin/plugin.json");
const checkOnly = process.argv.includes("--check");
const stale = [];

for (const path of referencePaths) {
  const current = readFileSync(path, "utf8");
  const expected = current
    .replace(
      executableReference,
      (_match, command) => `${command}${exactReference}`,
    )
    .replace(packageReference, exactReference);
  if (current === expected) continue;
  stale.push(path);
  if (!checkOnly) writeFileSync(path, expected);
}

{
  const current = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(current);
  manifest.version = packageJson.version;
  const expected = `${JSON.stringify(manifest, null, 2)}\n`;
  if (current !== expected) {
    stale.push(manifestPath);
    if (!checkOnly) writeFileSync(manifestPath, expected);
  }
}

if (stale.length > 0 && checkOnly) {
  process.stderr.write(
    [
      `OpenDexter ${packageJson.version} has stale executable version references:`,
      ...stale.map((path) => `  ${path}`),
      "Run `npm run version:sync -w @dexterai/opendexter` and commit the result.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

process.stdout.write(
  stale.length === 0
    ? `OpenDexter ${packageJson.version} version references are synchronized.\n`
    : `Synchronized ${stale.length} OpenDexter version-reference files to ${exactReference}.\n`,
);
