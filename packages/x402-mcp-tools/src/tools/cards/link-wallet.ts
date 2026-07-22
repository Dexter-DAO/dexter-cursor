import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CardWalletLinkSchema } from "@dexterai/dextercard";
import type { CardToolOpts } from "../../types.js";
import { maybeLoginRequiredResult } from "./_remote-failures.js";

/**
 * card_link_wallet — authorize a wallet to fund Dextercard
 * transactions up to a per-wallet cap.
 *
 * The wallet must already exist in the carrier's wallet store; the
 * cap is in the wallet's currency units (e.g., 5000 USDC).
 */
export function registerCardLinkWalletTool(server: McpServer, opts: CardToolOpts): void {
  const meta = opts.metas.linkWallet;
  const cards = opts.cards;
  const noSessionTip =
    opts.noSessionTip ??
    "No Dextercard session. Sign in before linking a wallet.";

  server.tool(
    "card_link_wallet",
    "Authorize a wallet to fund Dextercard transactions up to a cap. Currency is the wallet's native asset (typically 'usdc'); amount is the spend cap in human-readable units (e.g., 5000 = 5,000 USDC). " +
      "Pre-condition: card must be active (run card_status first). " +
      "Post-condition: linked wallets surface in card_status.wallets.",
    {
      wallet: CardWalletLinkSchema.shape.wallet.describe(
        "Wallet name as known to the carrier's wallet store.",
      ),
      currency: CardWalletLinkSchema.shape.currency.describe(
        "Currency code (e.g., 'usdc').",
      ),
      amount: CardWalletLinkSchema.shape.amount.describe(
        "Spend cap in human-readable units (e.g., 5000 for 5,000 USDC).",
      ),
    },
    async (args) => {
      if (!cards) return wrap({ ok: false, tip: noSessionTip }, meta, true);
      const client = await cards.getOperations();
      if (!client) return wrap({ ok: false, tip: noSessionTip }, meta, true);

      try {
        const linked = await client.cardWalletLink({
          wallet: args.wallet,
          currency: args.currency,
          amount: args.amount,
        });
        return wrap({ ok: true, linked }, meta);
      } catch (err: any) {
        const loginRequired = maybeLoginRequiredResult(err, meta);
        if (loginRequired) return loginRequired;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: err.message || String(err), tool: err.tool }, null, 2) },
          ],
          isError: true,
        };
      }
    },
  ).update({ _meta: meta });
}

function wrap(data: Record<string, unknown>, meta: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    _meta: meta,
    ...(isError ? { isError: true } : {}),
  } as any;
}
