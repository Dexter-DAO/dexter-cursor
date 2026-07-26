import { execFileSync } from "node:child_process";

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: new URL(".", import.meta.url),
  encoding: "utf8",
});

const [packInfo] = JSON.parse(raw);
const files = Array.isArray(packInfo?.files) ? packInfo.files : [];
const sourcemaps = files
  .map((file) => file?.path)
  .filter((path) => typeof path === "string" && path.endsWith(".map"));

if (sourcemaps.length > 0) {
  console.error("Refusing to publish source maps in @dexterai/opendexter:");
  for (const file of sourcemaps) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

const paths = files
  .map((file) => file?.path)
  .filter((path) => typeof path === "string");

const expectedWidgets = [
  "assets/widgets/x402-fetch-result.html",
  "assets/widgets/x402-marketplace-search.html",
  "assets/widgets/x402-pricing.html",
  "assets/widgets/x402-wallet.html",
  "dist/widgets/x402-fetch-result.html",
  "dist/widgets/x402-marketplace-search.html",
  "dist/widgets/x402-pricing.html",
  "dist/widgets/x402-wallet.html",
].sort();
const shippedWidgets = paths
  .filter((path) => /^(?:assets|dist)\/widgets\/[^/]+\.html$/.test(path))
  .sort();

if (JSON.stringify(shippedWidgets) !== JSON.stringify(expectedWidgets)) {
  console.error("Refusing to publish an unexpected OpenDexter widget set:");
  console.error(`Expected: ${expectedWidgets.join(", ")}`);
  console.error(`Found:    ${shippedWidgets.join(", ")}`);
  process.exit(1);
}

const forbiddenCardDeclarations = paths.filter((path) =>
  /(?:^|\/)(?:compose-cards|card-widget-meta)\.d\.ts$|(?:^|\/)tools\/cards\//.test(path),
);
if (forbiddenCardDeclarations.length > 0) {
  console.error("Refusing to publish retired Dextercard registrar declarations:");
  for (const file of forbiddenCardDeclarations) console.error(`- ${file}`);
  process.exit(1);
}

console.log("Pack verification passed: no source maps, orphan widgets, or card registrar declarations.");
