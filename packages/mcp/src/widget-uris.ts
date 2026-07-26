import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate paths where the widget HTML files might live, tried in
 * order. The build's copy-widgets.mjs places HTML at dist/widgets/,
 * but in source-mode dev the files may sit alongside the package at
 * a sibling path. We probe a small set so the hash works regardless
 * of which layout is active at runtime.
 */
const WIDGETS_DIR_CANDIDATES = [
  join(__dirname, "widgets"),       // built layout: dist/widget-uris.js + dist/widgets/
  join(__dirname, "..", "widgets"), // legacy / source-mode layout
];

function resolveWidgetPath(fileName: string): string | null {
  for (const dir of WIDGETS_DIR_CANDIDATES) {
    const full = join(dir, fileName);
    if (existsSync(full)) return full;
  }
  return null;
}

function versionedWidgetUri(baseUri: string, fileName: string): string {
  const path = resolveWidgetPath(fileName);
  if (!path) return baseUri;
  try {
    const html = readFileSync(path, "utf-8");
    const hash = createHash("sha1").update(html).digest("hex").slice(0, 8);
    return `${baseUri}-${hash}`;
  } catch {
    return baseUri;
  }
}

export const X402_WIDGET_URIS = Object.freeze({
  search: versionedWidgetUri("ui://dexter/x402-marketplace-search", "x402-marketplace-search.html"),
  fetch: versionedWidgetUri("ui://dexter/x402-fetch-result", "x402-fetch-result.html"),
  pricing: versionedWidgetUri("ui://dexter/x402-pricing", "x402-pricing.html"),
  wallet: versionedWidgetUri("ui://dexter/x402-wallet", "x402-wallet.html"),
});
