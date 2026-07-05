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

// Dextercard tool registrars
export { registerCardStatusTool } from "./tools/cards/status.js";
export { registerCardIssueTool } from "./tools/cards/issue.js";
export { registerCardLinkWalletTool } from "./tools/cards/link-wallet.js";
export { registerCardFreezeTool } from "./tools/cards/freeze.js";

// Dextercard compose helper + adapter contract + widget metas
export { composeCardTools, type ComposeCardToolsOpts } from "./compose-cards.js";
export type { CardsAdapter } from "./cards-adapter.js";

// Card operations interface (the small subset of the Dextercard SDK
// surface that registrars actually call) plus the two reference
// implementations: a local wrapper around a real Dextercard, and a
// remote HTTP+HMAC client for hosted servers that don't hold the
// carrier session in-process.
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
export {
  buildCardToolMetas,
  type CardToolMetas,
  type CardWidgetUris,
} from "./card-widget-meta.js";

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
  CardToolOpts,
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
