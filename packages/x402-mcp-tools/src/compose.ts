import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTool } from "./tools/search.js";
import { registerCheckTool } from "./tools/check.js";
import { registerFetchTool } from "./tools/fetch.js";
import { registerAccessTool } from "./tools/access.js";
import { registerWalletTool } from "./tools/wallet.js";
import type {
  SearchToolOpts,
  CheckToolOpts,
  FetchToolOpts,
  AccessToolOpts,
  WalletToolOpts,
} from "./types.js";

/**
 * Compose options for the all-tools registrar. Each tool's opts is
 * derived from the base config; tools that need wallet access pull from
 * `wallet`, tools that need only the API base pull from `apiBaseUrl`.
 */
export interface ComposeAllToolsOpts {
  apiBaseUrl: SearchToolOpts["apiBaseUrl"];
  metas: SearchToolOpts["metas"];
  wallet: FetchToolOpts["wallet"];
  /** Optional capability search path override for search and check. */
  capabilityPath?: string;
  /** Per-call USDC cap callback for fetch's policy enforcement. */
  getMaxAmountUsdc?: FetchToolOpts["getMaxAmountUsdc"];
  /** Rolling 24h budget hooks for fetch's velocity guard. */
  getBudgetRuntime?: FetchToolOpts["getBudgetRuntime"];
  /** Tab-lane hook for fetch's tab-first payment path (see types.ts). */
  getTabLane?: FetchToolOpts["getTabLane"];
  /**
   * Durable preparation/attempt store shared by check and fetch so a caller
   * cannot synthesize an executable prepared identity.
   */
  getPurchaseAttemptStore?: CheckToolOpts["getPurchaseAttemptStore"];
  /** Optional walletless hint surfaced in fetch's description. */
  walletlessHint?: FetchToolOpts["walletlessHint"];
  /** Whether to expose the historical `x402_pay` alias. Defaults to true. */
  registerPayAlias?: FetchToolOpts["registerPayAlias"];
  /** Optional tip surfaced by x402_wallet when no wallet is configured. */
  noWalletTip?: WalletToolOpts["noWalletTip"];
  /**
   * Optional subset of tools to register. Defaults to all five.
   * Useful when a consumer wants to surface only a subset of the
   * canonical x402 toolset.
   */
  include?: Array<"search" | "check" | "fetch" | "access" | "wallet">;
}

const DEFAULT_INCLUDE: Array<"search" | "check" | "fetch" | "access" | "wallet"> = [
  "search",
  "check",
  "fetch",
  "access",
  "wallet",
];

/**
 * Register every tool in the canonical x402 toolset on a single MCP
 * server. Most consumers will use this; consumers that need per-tool
 * customization can call the individual register*Tool functions directly.
 */
export function composeAllTools(server: McpServer, opts: ComposeAllToolsOpts): void {
  const include = opts.include ?? DEFAULT_INCLUDE;

  if (include.includes("search")) {
    registerSearchTool(server, {
      apiBaseUrl: opts.apiBaseUrl,
      metas: opts.metas,
      capabilityPath: opts.capabilityPath,
    });
  }
  if (include.includes("check")) {
    registerCheckTool(server, {
      apiBaseUrl: opts.apiBaseUrl,
      metas: opts.metas,
      capabilityPath: opts.capabilityPath,
      wallet: opts.wallet,
      getTabLane: opts.getTabLane,
      getPurchaseAttemptStore: opts.getPurchaseAttemptStore,
    });
  }
  if (include.includes("fetch")) {
    registerFetchTool(server, {
      apiBaseUrl: opts.apiBaseUrl,
      metas: opts.metas,
      wallet: opts.wallet,
      getMaxAmountUsdc: opts.getMaxAmountUsdc,
      getBudgetRuntime: opts.getBudgetRuntime,
      getTabLane: opts.getTabLane,
      getPurchaseAttemptStore: opts.getPurchaseAttemptStore,
      walletlessHint: opts.walletlessHint,
      registerPayAlias: opts.registerPayAlias,
    });
  }
  if (include.includes("access")) {
    registerAccessTool(server, {
      apiBaseUrl: opts.apiBaseUrl,
      metas: opts.metas,
      wallet: opts.wallet,
    });
  }
  if (include.includes("wallet")) {
    registerWalletTool(server, {
      apiBaseUrl: opts.apiBaseUrl,
      metas: opts.metas,
      wallet: opts.wallet,
      noWalletTip: opts.noWalletTip,
    });
  }
}
