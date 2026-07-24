/**
 * @dexterai/x402-mcp-tools
 *
 * Shared MCP tool registrations for the Dexter x402 ecosystem.
 *
 * One register*Tool function per tool plus a composeAllTools helper.
 * Consumers (the npm @dexterai/opendexter CLI, the hosted public MCP
 * server, the hosted authenticated MCP server) import what they need,
 * build an opts bag with their environment-specific dependencies
 * (wallet adapter, api base URL, widget URIs), and call the registrars
 * from their own server bootstrap.
 *
 * Depends on @dexterai/x402-core for HTTP/formatting/types and stays
 * free of any consumer-specific concerns: no filesystem reads, no
 * environment variables, no auth flows. Inject what you need.
 */

// Tool registrars
export { registerSearchTool } from "./tools/search.js";
export { registerCheckTool } from "./tools/check.js";
export {
  registerFetchTool,
  x402Fetch,
  evaluatePaymentRequirements,
} from "./tools/fetch.js";
export { registerAccessTool, accessWithWalletProof } from "./tools/access.js";
export { registerWalletTool } from "./tools/wallet.js";

// Compose helper (x402 toolset)
export { composeAllTools, type ComposeAllToolsOpts } from "./compose.js";

// Dextercard TOOL registrars: REMOVED in 0.6.0 (owner ruling Jul 23;
// opendexter-ide/docs/CARD-REMOVAL-RUNBOOK-2026-07-23.md). The card is a
// wallet-widget concern — servers surface a read-only card summary on
// x402_wallet and a widget-frame-only reveal/freeze rail; no card tools.
// The card OPERATIONS clients below deliberately survive: they are how
// those non-tool surfaces (and the CLI) talk to the carrier.
export {
  LocalCardOperations,
  type CardOperations,
} from "./card-operations.js";
export {
  createRemoteCardOperations,
  DextercardLoginRequiredError,
  DextercardPairingRequiredError,
  type RemoteCardOperationsOptions,
} from "./remote-card-operations.js";

// Widget metadata helpers
export {
  widgetMeta,
  buildToolMetas,
  type WidgetUris,
  type WidgetMetaOptions,
  type ToolMetas,
} from "./widget-meta.js";

// Wallet adapter contract
export type {
  WalletAdapter,
  WalletInfo,
  WalletBalances,
  SolanaSigner,
  EvmSigner,
  GetMaxAmountUsdc,
} from "./wallet-adapter.js";

// Registrar opts
export type {
  ToolBaseOpts,
  SearchToolOpts,
  CheckToolOpts,
  FetchToolOpts,
  BudgetRuntime,
  TabLaneHook,
  TabLaneOutcome,
  TabLaneRequest,
  TabOfferMaterials,
  AccessToolOpts,
  WalletToolOpts,
} from "./types.js";
export { DEFAULT_CAPABILITY_PATH } from "./types.js";

// Re-export types from x402-core so consumers only need one import path
export type {
  FormattedResource,
  CapabilitySearchOptions,
  CapabilitySearchResult,
  SearchResponse,
  CheckResult,
  PaymentOption,
} from "@dexterai/x402-core";
