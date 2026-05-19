/**
 * Shared types for the x402 MCP tool registrars.
 *
 * Each consumer (npm CLI, hosted public server, hosted authed server)
 * builds an opts object once and passes it to the registrars. Tools
 * that need session-aware behavior (the wallet helpers, fetch with a
 * specific signer) accept their dependencies through this opts bag
 * via the WalletAdapter contract, so the same registrar works in
 * every environment.
 */

import type { ToolMetas } from "./widget-meta.js";
import type { WalletAdapter, GetMaxAmountUsdc } from "./wallet-adapter.js";

export interface ToolBaseOpts {
  /** Resolved API base URL (e.g. https://x402.dexter.cash). No trailing slash. */
  apiBaseUrl: string;
  /** Pre-built widget metadata blobs, one per tool. */
  metas: ToolMetas;
}

export interface SearchToolOpts extends ToolBaseOpts {
  /** Capability search path appended to apiBaseUrl. Default: /api/x402gle/capability */
  capabilityPath?: string;
}

export interface CheckToolOpts extends ToolBaseOpts {
  /** Capability search path appended to apiBaseUrl. Default: /api/x402gle/capability */
  capabilityPath?: string;
}

export interface FetchToolOpts extends ToolBaseOpts {
  /**
   * Wallet adapter providing balance, signer, and policy access. Pass
   * null when the consumer has no signing wallet — the tool then returns
   * canonical x402 payment requirements instead of attempting auto-pay.
   */
  wallet: WalletAdapter | null;
  /**
   * Per-call USDC cap callback. Read at call time to honor live setting
   * changes. Defaults to Number.POSITIVE_INFINITY when omitted.
   */
  getMaxAmountUsdc?: GetMaxAmountUsdc;
  /**
   * Optional rolling-budget hook. Returns, at call time, the 24h budget
   * ceiling, the spend witnessed so far in that window, and a recorder the
   * fetch path calls after a successful settlement. Consumers that own a
   * spend ledger (the npm CLI / MCP server) supply this; x402-mcp-tools
   * stays storage-agnostic. Omit it entirely to disable the budget.
   */
  getBudgetRuntime?: () => BudgetRuntime;
  /**
   * Optional descriptive label used in the registrar's tool description
   * to differentiate the wallet-bound and walletless modes. Defaults to
   * a generic message; consumers can override (e.g., "Configure
   * DEXTER_PRIVATE_KEY..." for the npm CLI).
   */
  walletlessHint?: string;
}

/** Rolling-budget hooks supplied by a consumer that owns a spend ledger. */
export interface BudgetRuntime {
  /** Rolling 24h ceiling in USDC. 0 = budget disabled. */
  dailyBudgetUsdc: number;
  /** Witnessed x402 spend in the trailing 24h, in USDC. */
  spentLast24hUsdc: number;
  /** Called after a successful settlement so the ledger grows. */
  recordSpend: (usdc: number, url: string) => void;
}

export interface AccessToolOpts extends ToolBaseOpts {
  /** Wallet adapter that exposes Solana / EVM signers for SIWX. */
  wallet: WalletAdapter | null;
}

export interface WalletToolOpts extends ToolBaseOpts {
  /** Wallet whose state is reported to callers. */
  wallet: WalletAdapter | null;
  /**
   * Optional one-line "tip" surfaced when no wallet is configured. Lets
   * the npm CLI show "Set DEXTER_PRIVATE_KEY..." while hosted servers
   * show "Sign in to provision a managed wallet" or similar.
   */
  noWalletTip?: string;
}

/** Default capability search path on dexter-api. */
export const DEFAULT_CAPABILITY_PATH = "/api/x402gle/capability";

/**
 * Options shared by all four card tool registrars. Consumers build
 * one of these, pass it to {@link composeCardTools} or each
 * registrar individually.
 */
export interface CardToolOpts {
  /**
   * Adapter that resolves the active Dextercard client. Pass null at
   * the consumer level to skip card tools entirely (the helpers
   * gracefully no-op when adapter.getClient() returns null).
   */
  cards: import("./cards-adapter.js").CardsAdapter | null;
  /** Pre-built widget metadata blobs for the card tools. */
  metas: import("./card-widget-meta.js").CardToolMetas;
  /**
   * Optional one-line tip surfaced when no Dextercard session is
   * configured. Lets the npm CLI show a different hint than hosted
   * servers (e.g., "Run `dextercard login` first").
   */
  noSessionTip?: string;
}
