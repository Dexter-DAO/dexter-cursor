#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const requirePureJs = process.argv.includes("--require-pure-js");
const rootArgument = process.argv.slice(2).find((value) => !value.startsWith("--"));
const installRoot = resolve(rootArgument || "");
if (!rootArgument || !existsSync(join(installRoot, "package.json"))) {
  throw new Error(
    "usage: verify-bigint-buffer-boundary.mjs INSTALL_ROOT [--require-pure-js]",
  );
}

function findNativeModules(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const visit = (path) => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      const stat = statSync(child);
      if (stat.isDirectory()) visit(child);
      else if (entry.endsWith(".node")) found.push(child);
    }
  };
  visit(root);
  return found;
}

const fromInstall = createRequire(join(installRoot, "package.json"));
const openDexterPackage = fromInstall.resolve("@dexterai/opendexter/package.json");
const fromOpenDexter = createRequire(openDexterPackage);
const splTokenEntry = fromOpenDexter.resolve("@solana/spl-token");
const fromSplToken = createRequire(splTokenEntry);
const layoutEntry = fromSplToken.resolve("@solana/buffer-layout-utils");
const fromLayout = createRequire(layoutEntry);
const bigintEntry = fromLayout.resolve("bigint-buffer");
const bigintRoot = dirname(dirname(bigintEntry));

if (requirePureJs) {
  assert.deepEqual(
    findNativeModules(bigintRoot),
    [],
    "the --ignore-scripts install unexpectedly contains a native bigint-buffer binding",
  );
}

const bigint = fromLayout("bigint-buffer");
const observedLE = [];
const observedBE = [];
const originalLE = bigint.toBigIntLE;
const originalBE = bigint.toBigIntBE;
bigint.toBigIntLE = (buffer) => {
  observedLE.push(buffer.length);
  return originalLE(buffer);
};
bigint.toBigIntBE = (buffer) => {
  observedBE.push(buffer.length);
  return originalBE(buffer);
};

const layouts = fromSplToken("@solana/buffer-layout-utils");
for (const [name, width] of [
  ["u64", 8],
  ["u128", 16],
  ["u192", 24],
  ["u256", 32],
]) {
  layouts[name]().decode(Buffer.alloc(width + 64));
}
for (const [name, width] of [
  ["u64be", 8],
  ["u128be", 16],
  ["u192be", 24],
  ["u256be", 32],
]) {
  layouts[name]().decode(Buffer.alloc(width + 64));
}

assert.deepEqual(observedLE, [8, 16, 24, 32]);
assert.deepEqual(observedBE, [8, 16, 24, 32]);
console.log(
  `bigint-buffer boundary passed: ${
    requirePureJs ? "pure JS fallback and " : ""
  }fixed 8/16/24/32-byte layout slices`,
);
