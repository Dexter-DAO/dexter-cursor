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
import type {
  PreparedPurchaseV1,
  PurchaseAttemptStoreV1,
} from "./purchase-contract.js";

export interface PurchasePreparationStoreV1
  extends PurchaseAttemptStoreV1 {
  /**
   * Persist a check-produced prepared identity before the option is
   * advertised as executable. Implementations must fail closed on an
   * identity collision or unavailable durable storage.
   */
  prepare(purchase: PreparedPurchaseV1): void;
}

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
  /** Wallet whose actual Direct Exact signing capabilities gate readiness. */
  wallet?: WalletAdapter | null;
  /** Native Tab executor capability, resolved fresh for each pricing result. */
  getTabLane?: () => TabLaneHook | null | undefined;
  /**
   * Durable preparation/attempt store. Direct Exact and Native Tab are not
   * advertised as ready unless their exact prepared identity is recorded.
   */
  getPurchaseAttemptStore?: () =>
    | PurchasePreparationStoreV1
    | null
    | undefined;
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
  /**
   * Optional tab-lane hook, resolved fresh per call. Consumers that custody
   * granted session keys (the npm CLI's `~/.dexterai-mcp/tabs.json`) supply
   * this; x402-mcp-tools stays custody- and storage-agnostic. When the hook
   * is present, x402_fetch offers every 402 to the lane BEFORE the generic
   * exact path — the lane decides whether a stored tab covers the seller.
   */
  getTabLane?: () => TabLaneHook | null | undefined;
  /**
   * Durable prepared-identity store. Required for every explicit
   * direct_exact or native_tab execution; there is intentionally no
   * in-memory fallback.
   */
  getPurchaseAttemptStore?: () => PurchaseAttemptStoreV1 | null | undefined;
}

/** The request slice a tab lane needs to re-issue the call with a voucher. */
export interface TabLaneRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Route-bound transport for an explicit Native Tab purchase. B-owned lanes
   * must use this instead of global fetch so DNS and redirect policy cannot
   * change between pricing and the voucher-bearing request.
   */
  externalFetch?: typeof fetch;
}

/**
 * Materials for the in-band tab offer, supplied by a consumer lane that
 * custodies session keys. The lane mints and persists the session key
 * (0600, atomic) BEFORE returning these — the link carries only the
 * public key. x402Fetch composes the agent-facing offer from them, so the
 * relay copy lives in one place and every consumer says the same words.
 */
export interface TabOfferMaterials {
  /**
   * tab_available — the seller takes tabs and no grant exists yet; the
   *   link opens the consent page for a freshly minted session key.
   * tab_pending — a grant for this seller is awaiting the human's passkey
   *   approval; the link re-opens the SAME consent page (same key).
   */
  mode: "tab_available" | "tab_pending";
  /** The dexter.cash consent link. Carries the session PUBLIC key only. */
  connectUrl: string;
  /** Seller price per call in USDC, when parseable from the tab accept. */
  priceUsdcPerCall?: number;
}

/**
 * Tab-lane outcome contract:
 *  - `done: true`  — the lane produced the FINAL result for this call
 *    (a voucher-paid response, or a loud tab error that must not be
 *    papered over by an exact payment). x402Fetch returns it verbatim.
 *  - `done: false` — the lane is not handling this call; the ordinary
 *    exact path proceeds unchanged. An optional `note` is attached to the
 *    eventual result under `tab` so tab availability / skip reasons are
 *    never silent (no-silent-fallbacks). An optional `offer` carries the
 *    in-band tab invitation: x402Fetch attaches it alongside the paid
 *    result when an exact rail exists, and returns it AS the response for
 *    a tab-only seller (there the offer is the only way forward).
 */
export type TabLaneOutcome =
  | { done: true; result: Record<string, unknown> }
  | { done: false; note?: Record<string, unknown>; offer?: TabOfferMaterials };

/**
 * A consumer-supplied tab lane. Receives the request and the parsed 402
 * requirements (`{ accepts, x402Version, resource }` — null when the 402
 * body carried no accepts) and decides per the TabLaneOutcome contract.
 * Expected failures must come back as outcomes, not throws; a throw is
 * caught and surfaced as a loud note while the exact path continues.
 */
export type TabLaneHook = (
  request: TabLaneRequest,
  requirements: Record<string, unknown> | null,
) => Promise<TabLaneOutcome>;

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
