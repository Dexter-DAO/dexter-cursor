import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertInstructionRosterParity } from "@dexterai/mcp-instructions";
import { VERSION } from "../config.js";
import { registerWidgetResources } from "../resources/widgets.js";
import { registerDocsResources } from "../resources/docs.js";
import {
  HOSTED_PROXY_TOOL_ROSTER,
  HOSTED_PROXY_INSTRUCTIONS,
  registerHostedProxyTools,
} from "./hosted-proxy.js";

export interface ServerOptions {
  transport: "stdio";
  dev: boolean;
  /** Test seam for the connect store. */
  dataDir?: string;
}

/** Published and actual runtime roster; status is the no-blind-retry recovery read. */
export const LOCAL_TOOL_ROSTER = HOSTED_PROXY_TOOL_ROSTER;
export const HOSTED_RUNTIME_TOOL_ROSTER = HOSTED_PROXY_TOOL_ROSTER;

export async function startServer(opts: ServerOptions): Promise<void> {
  const instructions = HOSTED_PROXY_INSTRUCTIONS;
  const server = new McpServer(
    { name: "OpenDexter", version: VERSION },
    { instructions },
  );

  registerHostedProxyTools(server, {
    dev: opts.dev,
    dataDir: opts.dataDir,
  });

  // Dextercard TOOLS: REMOVED (owner ruling Jul 23; docs/CARD-REMOVAL-
  // RUNBOOK-2026-07-23.md). The card is a wallet-widget + web-page concern
  // now; the `opendexter dextercard` CLI commands remain the local non-tool
  // path. Instructions render card-free via @dexterai/mcp-instructions
  // LOCAL_CAPS (hasCardTools:false) — reintroducing a card tool without
  // flipping that cap back on trips the parity assert below at boot.

  registerWidgetResources(server);

  // docs://opendexter/{workflow,protocol,debugging} — the resources the
  // served instructions point agents at. The hosted server registers
  // these; ship them here too so a local agent following the pointer gets
  // the doc instead of resource-not-found (drift register B4).
  registerDocsResources(server);

  // Physics, not vigilance: if these instructions ever name a tool this
  // server doesn't register, refuse to start (drift register, R1).
  assertInstructionRosterParity(
    instructions,
    [...HOSTED_PROXY_TOOL_ROSTER],
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
