import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServerInstructions, LOCAL_CAPS, assertInstructionRosterParity } from "@dexterai/mcp-instructions";
import {
  composeAllTools,
  buildToolMetas,
  type WidgetUris,
} from "@dexterai/x402-mcp-tools";
import { CAPABILITY_PATH, VERSION, getApiBase } from "../config.js";
import { loadOrCreateWallet } from "../wallet/index.js";
import { createNpmWalletAdapter } from "../wallet/adapter.js";
import { loadSettings } from "../settings.js";
import { recordSpend, spentLast24h } from "../spend-ledger.js";
import { createPurchaseAttemptStore } from "../purchase-attempt-ledger.js";
import { createTabLane } from "../tabs/lane.js";
import { registerSettingsTool } from "../tools/settings.js";
import { registerWidgetResources } from "../resources/widgets.js";
import { registerDocsResources } from "../resources/docs.js";
import { X402_WIDGET_URIS } from "../widget-uris.js";

export interface ServerOptions {
  transport: "stdio";
  dev: boolean;
}

export const LOCAL_TOOL_ROSTER = [
  "x402_search",
  "x402_pay",
  "x402_fetch",
  "x402_check",
  "x402_access",
  "x402_wallet",
  "x402_settings",
] as const;

export async function startServer(opts: ServerOptions): Promise<void> {
  let wallet;
  try {
    wallet = await loadOrCreateWallet();
  } catch (err: any) {
    console.error(`[dexter-mcp] Wallet initialization failed: ${err.message}`);
    console.error(
      "[dexter-mcp] Starting in search-only mode. Set DEXTER_PRIVATE_KEY or fix ~/.dexterai-mcp/wallet.json to enable payments.",
    );
    wallet = null;
  }

  const instructions = buildServerInstructions(LOCAL_CAPS);
  const server = new McpServer(
    { name: "OpenDexter", version: VERSION },
    { instructions },
  );

  // Wire the file-backed local wallet through the shared adapter contract.
  const walletAdapter = wallet ? createNpmWalletAdapter(wallet) : null;

  // Resolve widget URIs from this package's content-hashed HTML files,
  // and pass them into the shared registrars via buildToolMetas().
  const widgetUris: WidgetUris = {
    search: X402_WIDGET_URIS.search,
    fetch: X402_WIDGET_URIS.fetch,
    pricing: X402_WIDGET_URIS.pricing,
    wallet: X402_WIDGET_URIS.wallet,
  };
  const metas = buildToolMetas(widgetUris);

  // Tab-first payment: 402s whose accepts include scheme 'tab' pay by
  // voucher when ~/.dexterai-mcp/tabs.json custodies an ACTIVE grant for
  // the seller (opened via `opendexter tab connect` + one passkey tap on
  // dexter.cash). One lane for the server's lifetime — its in-process tab
  // cache turns call 2..N into pure-local voucher signatures; the grant
  // store is re-read per call, so a tab approved while the server runs
  // becomes payable without a restart.
  const tabLane = createTabLane({
    getMaxAmountUsdc: () => loadSettings().maxAmountUsdc,
    getBudgetRuntime: () => ({
      dailyBudgetUsdc: loadSettings().dailyBudgetUsdc,
      spentLast24hUsdc: spentLast24h(),
      recordSpend,
    }),
  });
  const purchaseAttempts = createPurchaseAttemptStore();

  composeAllTools(server, {
    apiBaseUrl: getApiBase(opts.dev),
    capabilityPath: CAPABILITY_PATH,
    metas,
    wallet: walletAdapter,
    // Per-call USDC cap is read from the local settings file. Wrapping in a
    // callback (rather than passing the value once) lets users update
    // ~/.dexterai-mcp/settings.json without restarting the server.
    getMaxAmountUsdc: () => loadSettings().maxAmountUsdc,
    // Rolling 24h budget — the velocity guard a per-call cap cannot provide.
    // Resolved fresh per call: live settings + a current spend-ledger read.
    getBudgetRuntime: () => ({
      dailyBudgetUsdc: loadSettings().dailyBudgetUsdc,
      spentLast24hUsdc: spentLast24h(),
      recordSpend,
    }),
    getTabLane: () => tabLane,
    getPurchaseAttemptStore: () => purchaseAttempts,
    walletlessHint:
      "Configure DEXTER_PRIVATE_KEY (Solana) or EVM_PRIVATE_KEY (Base/Polygon/etc) for automatic settlement.",
    noWalletTip:
      "Set DEXTER_PRIVATE_KEY (Solana) or EVM_PRIVATE_KEY (EVM) env var, or run `npx @dexterai/opendexter wallet` to create one.",
  });

  // Dextercard TOOLS: REMOVED (owner ruling Jul 23; docs/CARD-REMOVAL-
  // RUNBOOK-2026-07-23.md). The card is a wallet-widget + web-page concern
  // now; the `opendexter dextercard` CLI commands remain the local non-tool
  // path. Instructions render card-free via @dexterai/mcp-instructions
  // LOCAL_CAPS (hasCardTools:false) — reintroducing a card tool without
  // flipping that cap back on trips the parity assert below at boot.

  // Settings stays npm-package-specific (filesystem-backed). Hosted servers
  // do not surface this tool.
  registerSettingsTool(server);

  registerWidgetResources(server);

  // docs://opendexter/{workflow,protocol,debugging} — the resources the
  // served instructions point agents at. The hosted server registers
  // these; ship them here too so a local agent following the pointer gets
  // the doc instead of resource-not-found (drift register B4).
  registerDocsResources(server);

  // Physics, not vigilance: if these instructions ever name a tool this
  // server doesn't register, refuse to start (drift register, R1).
  assertInstructionRosterParity(instructions, [...LOCAL_TOOL_ROSTER]);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
