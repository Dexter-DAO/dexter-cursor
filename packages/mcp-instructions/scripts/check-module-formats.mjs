#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);

const EXPECTED_RUNTIME_EXPORTS = [
  "HOSTED_CAPS",
  "LOCAL_CAPS",
  "SERVER_INSTRUCTIONS",
  "SERVER_INSTRUCTIONS_VERSION",
  "assertInstructionRosterParity",
  "buildServerInstructions",
].sort();

function fail(message) {
  throw new Error(`[check-module-formats] ${message}`);
}

function packagePath(declaredPath, label) {
  if (typeof declaredPath !== "string" || declaredPath.length === 0) {
    fail(`${label} must declare a nonempty package path`);
  }

  const absolute = resolve(packageRoot, declaredPath);
  const fromRoot = relative(packageRoot, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    fail(`${label} points outside the package: ${declaredPath}`);
  }
  return absolute;
}

async function requireRegularFile(declaredPath, label) {
  const absolute = packagePath(declaredPath, label);
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`${label} does not exist: ${declaredPath}`);
    }
    throw error;
  }
  if (!entry.isFile()) {
    fail(`${label} must be a regular file: ${declaredPath}`);
  }
  return absolute;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    } else {
      fail(`dist contains a symlink or special file: ${relative(packageRoot, absolute)}`);
    }
  }
  return files;
}

if (manifest.type !== "module") {
  fail('package type must be "module"');
}
const rootExport = manifest.exports?.["."];
if (!rootExport || typeof rootExport !== "object" || Array.isArray(rootExport)) {
  fail('exports["."] must declare types, import, and require entrypoints');
}

const mainFile = await requireRegularFile(manifest.main, "main");
const moduleFile = await requireRegularFile(manifest.module, "module");
const typesFile = await requireRegularFile(manifest.types, "types");
const importFile = await requireRegularFile(
  rootExport.import,
  'exports["."].import',
);
const requireFile = await requireRegularFile(
  rootExport.require,
  'exports["."].require',
);
const exportTypesFile = await requireRegularFile(
  rootExport.types,
  'exports["."].types',
);

if (mainFile !== requireFile || !requireFile.endsWith(".cjs")) {
  fail('main and exports["."].require must resolve to one .cjs file');
}
if (moduleFile !== importFile || !importFile.endsWith(".js")) {
  fail('module and exports["."].import must resolve to one .js file');
}
if (typesFile !== exportTypesFile || !typesFile.endsWith(".d.ts")) {
  fail('types and exports["."].types must resolve to one .d.ts file');
}

const distFiles = await walk(resolve(packageRoot, "dist"));
const maps = distFiles.filter((file) => file.endsWith(".map"));
if (maps.length > 0) {
  fail(`dist must not ship sourcemaps: ${maps.map((file) => relative(packageRoot, file)).join(", ")}`);
}

const esm = await import(manifest.name);
const cjs = createRequire(import.meta.url)(manifest.name);
for (const [label, publicApi] of [["import", esm], ["require", cjs]]) {
  const keys = Object.keys(publicApi).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_RUNTIME_EXPORTS)) {
    fail(`${label} runtime exports differ from the exact public contract: ${keys.join(", ")}`);
  }
  for (const name of ["buildServerInstructions", "assertInstructionRosterParity"]) {
    if (typeof publicApi[name] !== "function") {
      fail(`${label} runtime export ${name} is not a function`);
    }
  }
  for (const name of ["LOCAL_CAPS", "HOSTED_CAPS"]) {
    if (!publicApi[name] || typeof publicApi[name] !== "object") {
      fail(`${label} runtime export ${name} is not an object`);
    }
  }
  for (const name of ["SERVER_INSTRUCTIONS", "SERVER_INSTRUCTIONS_VERSION"]) {
    if (typeof publicApi[name] !== "string" || publicApi[name].length === 0) {
      fail(`${label} runtime export ${name} is not a nonempty string`);
    }
  }
}

const esmInstructions = esm.buildServerInstructions(esm.LOCAL_CAPS);
const cjsInstructions = cjs.buildServerInstructions(cjs.LOCAL_CAPS);
if (
  esmInstructions !== cjsInstructions ||
  esmInstructions !== esm.SERVER_INSTRUCTIONS ||
  cjsInstructions !== cjs.SERVER_INSTRUCTIONS
) {
  fail("import and require must render the same deterministic local instructions");
}
if (
  esm.SERVER_INSTRUCTIONS_VERSION !== manifest.version ||
  cjs.SERVER_INSTRUCTIONS_VERSION !== manifest.version
) {
  fail("import and require version stamps must match package.json");
}

console.log(
  `[check-module-formats] import and require expose ${EXPECTED_RUNTIME_EXPORTS.length} matching exports for ${manifest.name}@${manifest.version}`,
);
