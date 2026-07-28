import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getApiBase } from "../config.js";
import { loadSession, saveSession, type VaultSession } from "../connect/store.js";
import {
  callHostedAccountTool,
  isAuthError,
  refreshVaultToken,
} from "../connect/wallet.js";

type PortfolioPayload = Record<string, unknown>;

const portfolioHoldingSchema = z
  .object({
    mint: z.string(),
    tokenAccount: z.string().nullable(),
    tokenProgram: z.enum(["native", "spl-token", "token-2022"]),
    assetClass: z.enum(["cash", "yield", "token", "stock", "fund", "nft", "rwa"]),
    amountRaw: z.string(),
    decimals: z.number().int().nonnegative(),
    displayAmount: z.string(),
    amountModel: z.enum(["raw-decimals", "scaled-ui-amount", "unknown"]),
    accountState: z.enum(["initialized", "frozen", "unknown"]),
    valueUsd: z.string().nullable(),
    priceUsd: z.string().nullable(),
    priceObservedAt: z.string().nullable(),
    approvalStatus: z.enum(["approved", "unreviewed", "blocked"]),
    availableActions: z.array(
      z.enum(["view", "receive", "send", "buy", "sell", "earn", "lend", "borrow", "pay"]),
    ),
  })
  .strict();

const portfolioSnapshotSchema = z
  .object({
    contractVersion: z.literal("opendexter.portfolio.v1"),
    network: z.literal("solana-mainnet"),
    walletAddress: z.string(),
    observedAt: z.string(),
    contextSlot: z.number().int().nonnegative().nullable(),
    holdingsComplete: z.boolean(),
    omittedHoldings: z.number().int().nonnegative(),
    pricedValueUsd: z.string(),
    portfolioValueUsd: z.string().nullable(),
    pricedHoldings: z.number().int().nonnegative(),
    unpricedHoldings: z.number().int().nonnegative(),
    holdings: z.array(portfolioHoldingSchema),
  })
  .strict();

const portfolioReadySchema = z
  .object({
    portfolio_status: z.literal("ready"),
    mode: z.literal("portfolio_ready"),
    user_bound: z.literal(true),
    portfolio: portfolioSnapshotSchema,
  })
  .strict();

const portfolioReadErrorSchema = z
  .object({
    portfolio_status: z.literal("read_error"),
    mode: z.literal("portfolio_read_error"),
    user_bound: z.boolean().nullable(),
    retryable: z.literal(true),
    error: z.literal("portfolio_state_read_failed"),
    message: z.string(),
  })
  .strict();

const authenticationRequiredSchema = z
  .object({
    status: z.literal(401),
    mode: z.literal("authentication_required"),
    paySource: z.literal("anon_vault"),
    next_action: z.literal("connect_opendexter"),
    vault_status: z.literal("authentication_required"),
    user_bound: z.literal(false),
    retry: z.unknown().nullable(),
    message: z.string(),
    instructions: z.string(),
    reason: z.string(),
    requirements: z.unknown().nullable(),
    merchantSettlement: z.unknown().nullable(),
  })
  .strict();

const connectionRequired = (): PortfolioPayload => ({
  portfolio_status: "read_error",
  mode: "authentication_required",
  user_bound: false,
  retryable: false,
  error: "connector_session_required",
  message:
    "Connect this local OpenDexter installation to your Dexter Wallet with `opendexter connect`, then try dexter_portfolio again.",
  status: 401,
  paySource: "anon_vault",
  next_action: "connect_opendexter",
  vault_status: "authentication_required",
});

const readError = (): PortfolioPayload => ({
  portfolio_status: "read_error",
  mode: "portfolio_read_error",
  user_bound: null,
  retryable: true,
  error: "portfolio_state_read_failed",
  message:
    "I could not verify a complete portfolio snapshot just now. No balance, asset, or action availability was inferred.",
});

function projectHostedPortfolioResult(value: unknown): PortfolioPayload {
  const ready = portfolioReadySchema.safeParse(value);
  if (ready.success) return ready.data;

  const readFailure = portfolioReadErrorSchema.safeParse(value);
  if (readFailure.success) {
    return {
      ...readError(),
      user_bound: readFailure.data.user_bound,
    };
  }

  if (authenticationRequiredSchema.safeParse(value).success) {
    return connectionRequired();
  }

  return readError();
}

export interface ConnectedPortfolioOptions {
  dataDir?: string;
  dev?: boolean;
  now?: () => number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  loadStoredSession?: (dataDir?: string) => VaultSession | null;
  saveStoredSession?: (session: VaultSession, dataDir?: string) => void;
  callHostedPortfolio?: (accessToken: string) => Promise<PortfolioPayload>;
}

/**
 * Read the exact session-bound governed portfolio from the hosted first-party
 * contract. This never derives a portfolio from the local hot-key wallet:
 * doing so would incorrectly imply that local holdings have Dexter grant and
 * policy state.
 */
export async function readConnectedPortfolio(
  opts: ConnectedPortfolioOptions = {},
): Promise<PortfolioPayload> {
  const loadStoredSession = opts.loadStoredSession ?? loadSession;
  const saveStoredSession = opts.saveStoredSession ?? saveSession;
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? getApiBase(opts.dev ?? false);
  const session = loadStoredSession(opts.dataDir);
  if (!session) return connectionRequired();

  const callHosted =
    opts.callHostedPortfolio ??
    ((accessToken: string) =>
      callHostedAccountTool<PortfolioPayload>({
        accessToken,
        toolName: "dexter_portfolio",
        fetchImpl,
      }));

  let activeSession = session;
  let result: PortfolioPayload;
  try {
    result = await callHosted(activeSession.accessToken);
  } catch (error) {
    if (!isAuthError(error)) return readError();
    const refreshed = await refreshVaultToken({
      refreshToken: activeSession.refreshToken,
      apiBase,
      fetchImpl,
    });
    if (!refreshed) return connectionRequired();
    activeSession = {
      ...activeSession,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? activeSession.refreshToken,
      expiresAt:
        now() +
        (refreshed.expiresIn && refreshed.expiresIn > 0
          ? refreshed.expiresIn
          : 3600) *
          1000,
    };
    saveStoredSession(activeSession, opts.dataDir);
    try {
      result = await callHosted(activeSession.accessToken);
    } catch (error) {
      return isAuthError(error) ? connectionRequired() : readError();
    }
  }

  return projectHostedPortfolioResult(result);
}

export function registerPortfolioTool(server: McpServer): void {
  server.tool(
    "dexter_portfolio",
    "Read the governed Dexter Wallet portfolio linked to this local OpenDexter installation. The tool accepts no wallet, user, agent, or grant selector; run `opendexter connect` first. This is a read-only account link: local paid calls still use the separately configured local signer.",
    {},
    async () => {
      const payload = await readConnectedPortfolio();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
        structuredContent: payload,
        isError: payload.mode !== "portfolio_ready",
      } as any;
    },
  );
}
