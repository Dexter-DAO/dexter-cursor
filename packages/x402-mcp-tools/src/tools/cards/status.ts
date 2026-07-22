import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DextercardNoAccountError } from "@dexterai/dextercard";
import type { CardToolOpts } from "../../types.js";
import { maybeLoginRequiredResult } from "./_remote-failures.js";

/**
 * card_status — return everything the agent needs to render the
 * current Dextercard state: account info, card metadata, linked
 * wallets, and a recent transaction window.
 *
 * Failure modes that are NOT errors from the agent's perspective:
 *   - No session configured → returns a structured "no session" hint
 *   - Session valid but onboarding not started → returns
 *     { stage: "onboarding_required" } so the agent can suggest issue
 *
 * Anything genuinely broken (carrier 5xx, JSON parse failure) flips
 * isError=true so the host surfaces it.
 */
export function registerCardStatusTool(server: McpServer, opts: CardToolOpts): void {
  const meta = opts.metas.status;
  const cards = opts.cards;
  const noSessionTip =
    opts.noSessionTip ??
    "No Dextercard session configured for this MCP context. Sign in to view card status.";

  server.tool(
    "card_status",
    "Show current Dextercard status: account, card metadata (last4, expiry, frozen?), linked wallets, and a recent transaction window. " +
      "Returns a stage indicator (`no_session`, `onboarding_required`, `pending_kyc`, `pending_finalize`, `not_issued`, `active`, `frozen`) so the agent knows which next step to suggest. " +
      "Always call this before card_issue or card_link_wallet to know what state the user is actually in.",
    {},
    async () => {
      // No adapter at all (consumer never wired card tools)
      if (!cards) {
        const data = { stage: "no_session" as const, tip: noSessionTip };
        return wrap(data, meta);
      }

      const client = await cards.getOperations();
      if (!client) {
        const data = { stage: "no_session" as const, tip: noSessionTip };
        return wrap(data, meta);
      }

      try {
        const user = await client.userRetrieve();

        // Probe card state. NoAccount = onboarding hasn't started.
        let stage: CardStage = "active";
        let card: unknown = null;
        let wallets: unknown[] = [];
        let recentTransactions: unknown[] = [];
        let onboarding: unknown = null;

        try {
          card = await client.cardRetrieve();
        } catch (err) {
          if (err instanceof DextercardNoAccountError) {
            // Inspect onboarding to differentiate "never started" from
            // "started but unverified" from "verified but not finalized."
            try {
              onboarding = await client.cardOnboardingCheck();
              const status = String(
                (onboarding as { status?: string })?.status ?? "",
              ).toLowerCase();
              if (status === "verified") stage = "pending_finalize";
              else if (status) stage = "pending_kyc";
              else stage = "onboarding_required";
            } catch (innerErr) {
              if (innerErr instanceof DextercardNoAccountError) {
                stage = "onboarding_required";
              } else throw innerErr;
            }
          } else throw err;
        }

        // If we have a card, classify by frozen flag if present.
        if (card) {
          const status = String(
            (card as { status?: string })?.status ?? "",
          ).toLowerCase();
          stage = status === "frozen" ? "frozen" : "active";

          // Best-effort: fetch wallets + recent txns. These are
          // non-fatal — if they fail, the card stays renderable.
          const [walletsResult, txnResult] = await Promise.allSettled([
            client.cardWalletList(),
            client.cardTransactionList({}),
          ]);
          if (walletsResult.status === "fulfilled") {
            wallets = walletsResult.value?.wallets ?? [];
          }
          if (txnResult.status === "fulfilled") {
            recentTransactions = txnResult.value?.transactions ?? [];
          }
        }

        const data = {
          stage,
          user,
          card,
          onboarding,
          wallets,
          recentTransactions,
        };
        return wrap(data, meta);
      } catch (err: any) {
        const loginRequired = maybeLoginRequiredResult(err, meta);
        if (loginRequired) return loginRequired;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: err.message || String(err) },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  ).update({ _meta: meta });
}

type CardStage =
  | "no_session"
  | "onboarding_required"
  | "pending_kyc"
  | "pending_finalize"
  | "not_issued"
  | "active"
  | "frozen";

function wrap(data: Record<string, unknown>, meta: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    _meta: meta,
  } as any;
}
