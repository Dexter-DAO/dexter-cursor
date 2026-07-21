import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServerInstructions, LOCAL_CAPS, assertInstructionRosterParity } from "@dexterai/mcp-instructions";
import {
  composeAllTools,
  composeCardTools,
  buildToolMetas,
  buildCardToolMetas,
  type WidgetUris,
  type CardWidgetUris,
} from "@dexterai/x402-mcp-tools";
import { CAPABILITY_PATH, VERSION, getApiBase } from "../config.js";
import { loadOrCreateWallet } from "../wallet/index.js";
import { createNpmWalletAdapter } from "../wallet/adapter.js";
import { createNpmCardsAdapter } from "../cards-adapter.js";
import { loadSettings } from "../settings.js";
import { recordSpend, spentLast24h } from "../spend-ledger.js";
import { createTabLane } from "../tabs/lane.js";
import { registerSettingsTool } from "../tools/settings.js";
import { registerCardLoginTools } from "../tools/card-login.js";
import { registerWidgetResources } from "../resources/widgets.js";
import { CARD_WIDGET_URIS, X402_WIDGET_URIS } from "../widget-uris.js";

export interface ServerOptions {
  transport: "stdio";
  dev: boolean;
}

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
    walletlessHint:
      "Configure DEXTER_PRIVATE_KEY (Solana) or EVM_PRIVATE_KEY (Base/Polygon/etc) for automatic settlement.",
    noWalletTip:
      "Set DEXTER_PRIVATE_KEY (Solana) or EVM_PRIVATE_KEY (EVM) env var, or run `npx @dexterai/opendexter wallet` to create one.",
  });

  // Dextercard tools — opt-in surface. The CardsAdapter resolves the
  // active session lazily on first tool call, so registering them here
  // costs nothing when no session is configured (handlers gracefully
  // surface a `no_session` stage with the configured tip).
  const cardWidgetUris: CardWidgetUris = {
    status: CARD_WIDGET_URIS.status,
    issue: CARD_WIDGET_URIS.issue,
    linkWallet: CARD_WIDGET_URIS.linkWallet,
  };
  const cardMetas = buildCardToolMetas(cardWidgetUris);
  const cardsAdapter = createNpmCardsAdapter();

  // noSessionTip only surfaces when auto-pairing is disabled
  // (OPENDEXTER_AUTOPAIR=0). In the normal path the adapter throws
  // DextercardPairingRequiredError instead of returning null, so the
  // shared registrars surface a clickable pairing URL automatically.
  composeCardTools(server, {
    cards: cardsAdapter,
    metas: cardMetas,
    noSessionTip:
      "Auto-pairing is disabled (OPENDEXTER_AUTOPAIR=0). Run `npx @dexterai/opendexter dextercard login` to provision a session manually, or unset OPENDEXTER_AUTOPAIR to enable browser-based pairing.",
  });

  // Agent-driven carrier provisioning. Closes the bootstrap gap for users
  // who haven't yet provisioned a Dextercard session at dexter.cash:
  // card_login_start hands the agent a MoonPay URL the user opens to
  // solve the captcha, card_login_complete exchanges the resulting OTP
  // code for a carrier session, persisted to the same encrypted store
  // that auto-pairing populates.
  registerCardLoginTools(server, { cards: cardsAdapter });

  // Settings stays npm-package-specific (filesystem-backed). Hosted servers
  // do not surface this tool.
  registerSettingsTool(server);

  registerWidgetResources(server);

  // Physics, not vigilance: if these instructions ever name a tool this
  // server doesn't register, refuse to start (drift register, R1).
  assertInstructionRosterParity(instructions, [
    "x402_search", "x402_pay", "x402_fetch", "x402_check", "x402_access", "x402_wallet",
    "x402_settings",
    "card_status", "card_issue", "card_link_wallet", "card_freeze",
    "card_login_request_otp", "card_login_complete", "card_login_start",
  ]);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
