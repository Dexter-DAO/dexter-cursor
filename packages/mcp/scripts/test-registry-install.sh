#!/usr/bin/env bash
# Post-publication proof for one exact immutable registry version. Registry
# metadata `dist.integrity` and `dist.shasum` must match the pre-publication
# tarball release receipt before install.
set -euo pipefail

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 VERSION /absolute/path/to/release.json" >&2
  exit 2
fi

VERSION=$1
ATTESTATION=$2
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Expected one exact semantic version, not a tag, path, URL, or range" >&2
  exit 2
fi
if [[ ! "$ATTESTATION" = /* || ! -f "$ATTESTATION" ]]; then
  echo "Expected an absolute path to the immutable release receipt" >&2
  exit 2
fi

PACKAGE_SPEC="@dexterai/opendexter@$VERSION"
INSTALL_ROOT=$(mktemp -d)
trap 'rm -rf "$INSTALL_ROOT"' EXIT
METADATA="$INSTALL_ROOT/registry-metadata.json"

# Tests may inject a captured metadata file. The real post-publication gate
# fetches the exact immutable version, never a tag or range.
if [[ -n "${OPENDXTER_REGISTRY_METADATA_FILE:-}" ]]; then
  if [[ ! "$OPENDXTER_REGISTRY_METADATA_FILE" = /* || ! -f "$OPENDXTER_REGISTRY_METADATA_FILE" ]]; then
    echo "OPENDXTER_REGISTRY_METADATA_FILE must be an absolute existing file" >&2
    exit 2
  fi
  cp "$OPENDXTER_REGISTRY_METADATA_FILE" "$METADATA"
else
  npm view \
    --registry=https://registry.npmjs.org \
    --json \
    "$PACKAGE_SPEC" \
    name version dist > "$METADATA"
fi

node "$SCRIPT_ROOT/package-provenance.mjs" verify-registry \
  --attestation "$ATTESTATION" \
  --metadata "$METADATA"

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
echo "Registry integrity and install proof passed: $PACKAGE_SPEC"
