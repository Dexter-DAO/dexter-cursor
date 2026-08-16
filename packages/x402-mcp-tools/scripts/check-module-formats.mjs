#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(packageRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const EXPECTED_RUNTIME_EXPORTS = [
  "DEFAULT_CAPABILITY_PATH",
  "DextercardLoginRequiredError",
  "DextercardPairingRequiredError",
  "LocalCardOperations",
  "PURCHASE_CONTRACT_VERSION",
  "PURCHASE_MODES",
  "accessWithWalletProof",
  "attachPurchaseReceipt",
  "buildPurchaseIntegrationRequired",
  "buildPurchaseOptions",
  "buildToolMetas",
  "buildUnavailablePurchaseReceipt",
  "composeAllTools",
  "createManagedFinalVoucherV2Reservation",
  "createRemoteCardOperations",
  "evaluatePaymentRequirements",
  "preparedPurchaseSchema",
  "purchasePayloadSha256",
  "registerAccessTool",
  "registerCheckTool",
  "registerFetchTool",
  "registerSearchTool",
  "registerWalletTool",
  "sellerAcceptSha256",
  "sellerOfferMatches",
  "validatePurchaseExecution",
  "widgetMeta",
  "x402Fetch",
].sort();

function fail(message) {
  throw new Error(`[check-module-formats] ${message}`);
}

function packagePath(declaredPath, label) {
  if (typeof declaredPath !== "string" || declaredPath.length === 0) {
    fail(`${label} must declare a nonempty package path`);
  }

  const absolute = resolve(packageRoot, declaredPath);
  if (absolute !== packageRoot && !absolute.startsWith(`${packageRoot}/`)) {
    fail(`${label} points outside the package: ${declaredPath}`);
  }
  return absolute;
}

async function requireFile(declaredPath, label) {
  const absolute = packagePath(declaredPath, label);
  try {
    if (!(await stat(absolute)).isFile()) {
      fail(`${label} is not a file: ${declaredPath}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`${label} does not exist: ${declaredPath}`);
    }
    throw error;
  }
  return absolute;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const rootExport = manifest.exports?.["."];
if (!rootExport || typeof rootExport !== "object" || Array.isArray(rootExport)) {
  fail("exports[\".\"] must declare types, import, and require entrypoints");
}
if (manifest.type !== "module") {
  fail('package type must be "module"');
}

const mainFile = await requireFile(manifest.main, "main");
const moduleFile = await requireFile(manifest.module, "module");
const typesFile = await requireFile(manifest.types, "types");
const importFile = await requireFile(rootExport.import, 'exports["."].import');
const requireFilePath = await requireFile(
  rootExport.require,
  'exports["."].require',
);
const exportTypesFile = await requireFile(rootExport.types, 'exports["."].types');

if (mainFile !== requireFilePath) {
  fail("main and exports[\".\"].require must resolve to one CommonJS file");
}
if (moduleFile !== importFile) {
  fail("module and exports[\".\"].import must resolve to one ESM file");
}
if (typesFile !== exportTypesFile) {
  fail("types and exports[\".\"].types must resolve to one declaration file");
}
if (!requireFilePath.endsWith(".cjs")) {
  fail("exports[\".\"].require must resolve to a .cjs file");
}

const distRoot = resolve(packageRoot, "dist");
const distFiles = await walk(distRoot);
const forbidden = distFiles.filter((file) => file.endsWith(".map"));
if (forbidden.length > 0) {
  fail(
    `dist must not ship sourcemaps: ${forbidden
      .map((file) => file.slice(packageRoot.length + 1))
      .join(", ")}`,
  );
}

const esm = await import(manifest.name);
const cjs = createRequire(import.meta.url)(manifest.name);
for (const [label, publicApi] of [["import", esm], ["require", cjs]]) {
  const keys = Object.keys(publicApi).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_RUNTIME_EXPORTS)) {
    fail(
      `${label} runtime exports differ from the exact public contract: ${keys.join(", ")}`,
    );
  }

  for (const name of [
    "composeAllTools",
    "registerSearchTool",
    "registerCheckTool",
    "registerFetchTool",
    "buildToolMetas",
    "sellerAcceptSha256",
  ]) {
    if (typeof publicApi[name] !== "function") {
      fail(`${label} runtime export ${name} is not a function`);
    }
  }
  if (typeof publicApi.PURCHASE_CONTRACT_VERSION !== "string") {
    fail(`${label} PURCHASE_CONTRACT_VERSION is not a string`);
  }
  if (!Array.isArray(publicApi.PURCHASE_MODES)) {
    fail(`${label} PURCHASE_MODES is not an array`);
  }
}

const fixedSellerAccept = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:8453",
  amount: "1000",
  asset: "0x0000000000000000000000000000000000000001",
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};
const esmHash = esm.sellerAcceptSha256(fixedSellerAccept);
const cjsHash = cjs.sellerAcceptSha256(fixedSellerAccept);
if (!/^[0-9a-f]{64}$/.test(esmHash ?? "") || cjsHash !== esmHash) {
  fail(
    "import and require must produce the same deterministic sellerAcceptSha256 output",
  );
}

console.log(
  `[check-module-formats] import and require expose ${EXPECTED_RUNTIME_EXPORTS.length} matching exports and seller hash ${esmHash}`,
);
