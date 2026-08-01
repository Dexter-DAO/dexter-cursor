#!/usr/bin/env bash
#
# Post-publication registry-only install proof for @dexterai/opendexter.
#
# This accepts only an exact semantic version, never a path, tarball, URL, tag,
# or range. Run it only after that version and its dependency train are
# published with release approval.
#
set -euo pipefail

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 VERSION" >&2
  exit 2
fi

VERSION=$1
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Expected one exact semantic version, not a tag, path, URL, or range" >&2
  exit 2
fi

PACKAGE_SPEC="@dexterai/opendexter@$VERSION"
INSTALL_ROOT=$(mktemp -d)
trap 'rm -rf "$INSTALL_ROOT"' EXIT

cd "$INSTALL_ROOT"
npm init --yes >/dev/null
npm install \
  --ignore-scripts \
  --save-exact \
  --registry=https://registry.npmjs.org \
  "$PACKAGE_SPEC"

node "$SCRIPT_ROOT/verify-bigint-buffer-boundary.mjs" \
  "$INSTALL_ROOT" \
  --require-pure-js

node --input-type=module - "$VERSION" <<'NODE'
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const expectedVersion = process.argv[2];
const root = new URL(
  "./node_modules/@dexterai/opendexter/",
  `file://${process.cwd()}/`,
);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
if (pkg.version !== expectedVersion) {
  throw new Error(`installed ${pkg.version}; expected ${expectedVersion}`);
}
for (const [name, version] of Object.entries(pkg.dependencies || {})) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${name} is not exact in the installed manifest: ${version}`);
  }
}
execFileSync(
  process.execPath,
  [new URL("dist/index.js", root).pathname, "--help"],
  { stdio: "inherit" },
);
NODE

npm ls --all
echo "Registry-only install proof passed: $PACKAGE_SPEC"
