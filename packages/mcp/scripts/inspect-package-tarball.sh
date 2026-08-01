#!/usr/bin/env bash
#
# Inspect an exact local package tarball without installing it.
#
# This script never calls npm, npx, a registry, an AI client, or a service. It
# proves package contents only; it is not a registry-install or live proof.
#
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /absolute/path/to/dexterai-opendexter-VERSION.tgz" >&2
  exit 2
fi

CANDIDATE_TARBALL=$1
if [[ ! -f "$CANDIDATE_TARBALL" ]]; then
  echo "Candidate tarball not found: $CANDIDATE_TARBALL" >&2
  exit 2
fi

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_PACKAGE_JSON="$SCRIPT_ROOT/../package.json"
if [[ ! -f "$SOURCE_PACKAGE_JSON" ]]; then
  echo "Source package manifest not found: $SOURCE_PACKAGE_JSON" >&2
  exit 2
fi

CANDIDATE_ROOT=$(mktemp -d)
trap 'rm -rf "$CANDIDATE_ROOT"' EXIT

ARCHIVE_LIST="$CANDIDATE_ROOT/archive.txt"
tar -tzf "$CANDIDATE_TARBALL" > "$ARCHIVE_LIST"
if grep -Eq '(^|/)\.\.(/|$)|^/' "$ARCHIVE_LIST"; then
  echo "Candidate archive contains an unsafe path" >&2
  exit 1
fi

tar -xzf "$CANDIDATE_TARBALL" -C "$CANDIDATE_ROOT"
CANDIDATE_PACKAGE="$CANDIDATE_ROOT/package"

node --input-type=module - "$CANDIDATE_PACKAGE" "$SOURCE_PACKAGE_JSON" <<'NODE'
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const sourcePackageJson = process.argv[3];
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const pkg = readJson(join(root, "package.json"));
const expected = readJson(sourcePackageJson);
assert(pkg.name === expected.name, "candidate package name does not match this checkout");
assert(pkg.version === expected.version, "candidate version does not match this checkout");
assert(
  JSON.stringify(pkg.dependencies) === JSON.stringify(expected.dependencies),
  "candidate runtime dependency graph does not match this checkout",
);
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
for (const [name, version] of Object.entries(pkg.dependencies || {})) {
  assert(exactVersion.test(version), `${name} is not pinned exactly: ${version}`);
}
assert(pkg.engines?.node === ">=20", "candidate does not require Node.js 20 or newer");
assert(existsSync(join(root, "dist", "index.js")), "missing stdio entrypoint");
assert(existsSync(join(root, "skills", "opendexter", "SKILL.md")), "missing local OpenDexter skill");
assert(existsSync(join(root, "cursor-mcp.json")), "missing Cursor MCP configuration");

const cursorManifest = readJson(join(root, ".cursor-plugin", "plugin.json"));
assert(cursorManifest.name === "opendexter", "Cursor plugin has stale identity");
assert(cursorManifest.version === pkg.version, "Cursor plugin version does not match the package");
assert(typeof cursorManifest.logo === "string", "Cursor plugin logo is undeclared");
assert(existsSync(join(root, cursorManifest.logo)), "Cursor plugin logo target is missing");
const cursorMcp = readJson(join(root, "cursor-mcp.json"));
assert(
  JSON.stringify(cursorMcp.mcpServers?.opendexter) === JSON.stringify({
    command: "npx",
    args: ["-y", `@dexterai/opendexter@${pkg.version}`],
  }),
  "Cursor MCP command is not pinned to the unpacked candidate version",
);

const widgets = readdirSync(join(root, "assets", "widgets")).sort();
assert(JSON.stringify(widgets) === JSON.stringify([
  "x402-fetch-result.html",
  "x402-marketplace-search.html",
  "x402-pricing.html",
  "x402-wallet.html",
]), `unexpected widget set: ${widgets.join(", ")}`);

const readme = readFileSync(join(root, "README.md"), "utf8");
assert(readme.includes("## Six MCP tools"), "README does not declare the local roster");
assert(!/\bx402_(?:pay|settings)\b/.test(readme), "README suggests a retired MCP alias");
assert(!/\bcard_(?:status|issue|freeze|link_wallet)\b/.test(readme), "README revives card tools");

console.log(`Candidate fixture passed: ${pkg.name}@${pkg.version}`);
console.log("Verified stdio entrypoint, local skill, Cursor discovery, logo, and four-widget package set.");
NODE
