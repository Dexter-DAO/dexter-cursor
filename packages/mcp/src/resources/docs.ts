/**
 * docs://opendexter/* resource registration.
 *
 * The served instructions (both the hosted server and this npm package)
 * point agents at docs://opendexter/{workflow,protocol,debugging}. The
 * hosted server (dexter-mcp/open-mcp-server.mjs) reads these from the
 * opendexter-ide skills dir on disk; this package ships committed copies
 * of the same three SKILL.md files under assets/docs/ so an agent that
 * follows the pointer locally gets the doc, not resource-not-found
 * (drift register B4).
 *
 * Staleness between skills/ (source) and assets/docs/ (committed copies)
 * is accepted here — a future mechanism handles re-sync, not this module.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for the committed docs markdown, tried in order.
 * Mirrors widget-uris.ts: the tsup build bundles all of src into a single
 * dist/index.js (splitting:false), so at built runtime __dirname is
 * <pkg>/dist and the shipped assets sit one level up at <pkg>/assets/docs.
 * Under tsx/vitest the module keeps its own source path (src/resources/),
 * so the assets are two levels up — probe both.
 */
const DOCS_DIR_CANDIDATES = [
  join(__dirname, "..", "assets", "docs"), // built layout: dist/index.js -> <pkg>/assets/docs
  join(__dirname, "..", "..", "assets", "docs"), // source/vitest: src/resources/docs.ts -> <pkg>/assets/docs
];

function resolveDocsDir(): string {
  for (const dir of DOCS_DIR_CANDIDATES) {
    if (existsSync(dir)) return dir;
  }
  // Fall back to the built-layout path; readFileSync surfaces a clear ENOENT.
  return DOCS_DIR_CANDIDATES[0];
}

/** Resolved absolute path to the shipped docs assets directory. */
export const DOCS_ASSETS_DIR = resolveDocsDir();

const DOCS = [
  { name: "workflow", uri: "docs://opendexter/workflow", file: "workflow.md", description: "OpenDexter tool reference — search → check → fetch workflow, parameter tables, quality scores, tips" },
  { name: "protocol", uri: "docs://opendexter/protocol", file: "protocol.md", description: "x402 v2 protocol specification — payment flow, core types, CAIP-2 networks, error codes, transport layers" },
  { name: "debugging", uri: "docs://opendexter/debugging", file: "debugging.md", description: "x402 payment debugging — facilitator health, error code reference, common issues and fixes" },
] as const;

export function registerDocsResources(server: McpServer): void {
  for (const d of DOCS) {
    server.resource(d.name, d.uri, { description: d.description, mimeType: "text/markdown" }, async () => ({
      contents: [{ uri: d.uri, mimeType: "text/markdown", text: readFileSync(join(DOCS_ASSETS_DIR, d.file), "utf-8") }],
    }));
  }
}
