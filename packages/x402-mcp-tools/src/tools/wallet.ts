import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WalletToolOpts } from "../types.js";

/**
 * x402_wallet tool registration.
 *
 * Reports wallet state to callers: addresses, USDC balances per chain,
 * and a deposit hint when balances are zero. Reads everything through
 * the injected WalletAdapter so the same registrar works for the npm
 * CLI's local file-backed wallet, the hosted public server's anonymous
 * session wallet, and the hosted authenticated server's managed wallet.
 */
export function registerWalletTool(server: McpServer, opts: WalletToolOpts): void {
  const meta = opts.metas.wallet;
  const wallet = opts.wallet;
  const noWalletTip =
    opts.noWalletTip ??
    "No wallet is configured for this MCP session. Sign in or provision a wallet to enable balances and payments.";

  server.registerTool(
    "x402_wallet",
    {
      description:
        "Show wallet addresses (Solana + EVM), USDC balances across all chains, and deposit instructions. " +
        "The wallet is used to automatically pay for x402 API calls on Solana, Base, Polygon, Arbitrum, Optimism, and Avalanche.",
      inputSchema: {},
      _meta: meta,
    },
    async () => {
      if (!wallet) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "No wallet configured", tip: noWalletTip }, null, 2),
            },
          ],
        };
      }

      try {
        const info = wallet.getInfo();
        const { totalUsdc, chains, degraded, unavailableChains } = await wallet.getAllBalances();
        // A chain whose read failed (usdc === null) reports available:null +
        // unavailable:true rather than "0" — a transient RPC error must never
        // be indistinguishable from an empty balance.
        const chainBalances = Object.fromEntries(
          Object.entries(chains).map(([caip2, chain]) => [
            caip2,
            {
              available: chain.usdc === null ? null : String(Math.round(chain.usdc * 1e6)),
              ...(chain.usdc === null ? { unavailable: true } : {}),
              name: chain.name,
              tier:
                caip2 === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" || caip2 === "eip155:8453"
                  ? "first"
                  : "second",
            },
          ]),
        );
        const isDegraded = degraded ?? Object.values(chains).some((c) => c.usdc === null);
        const unavailable =
          unavailableChains ??
          Object.entries(chains).filter(([, c]) => c.usdc === null).map(([caip2]) => caip2);
        const data: Record<string, unknown> = {
          address: info.solanaAddress || info.evmAddress || null,
          solanaAddress: info.solanaAddress ?? null,
          evmAddress: info.evmAddress ?? null,
          network: "multichain",
          chainBalances,
          balances: {
            // Verified total only (failed chains excluded). `degraded` flags
            // that the real balance may be higher than shown.
            usdc: totalUsdc,
            fundedAtomic: String(Math.round(totalUsdc * 1e6)),
            spentAtomic: "0",
            availableAtomic: String(Math.round(totalUsdc * 1e6)),
            degraded: isDegraded,
            ...(isDegraded ? { unavailableChains: unavailable } : {}),
          },
          supportedNetworks:
            Object.keys(chainBalances).length > 0
              ? Object.keys(chainBalances)
              : ["solana", "base", "polygon", "arbitrum", "optimism", "avalanche"],
        };
        if (info.descriptor) {
          data.walletDescriptor = info.descriptor;
        }
        // Only advise depositing when the wallet is VERIFIABLY empty — not when
        // the total is 0 merely because reads failed (that would tell a funded
        // user to deposit funds they already hold).
        if (totalUsdc === 0 && !isDegraded) {
          data.tip = `Deposit USDC to ${
            info.solanaAddress || "your Solana wallet"
          }${info.evmAddress ? ` or ${info.evmAddress}` : ""} to start paying.`;
        } else if (totalUsdc === 0 && isDegraded) {
          data.tip = `Could not verify balances on ${unavailable.length} chain(s) (RPC unavailable). Retry before assuming the wallet is empty.`;
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
          _meta: meta,
        } as any;
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    },
  );
}
