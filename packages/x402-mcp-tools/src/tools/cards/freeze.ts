import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CardToolOpts } from "../../types.js";
import { maybeLoginRequiredResult } from "./_remote-failures.js";

/**
 * card_freeze — pause or resume Dextercard transactions.
 *
 * Single tool that takes `frozen: boolean` and dispatches to the
 * carrier's freeze or unfreeze endpoint. Returns the same shape as
 * card_status would, so the host can re-render the card-status
 * widget without a follow-up call.
 */
export function registerCardFreezeTool(server: McpServer, opts: CardToolOpts): void {
  const meta = opts.metas.status; // freeze mutates state then returns status
  const cards = opts.cards;
  const noSessionTip =
    opts.noSessionTip ??
    "No Dextercard session. Sign in to control card state.";

  server.tool(
    "card_freeze",
    "Pause or resume Dextercard transactions. Pass `frozen: true` to freeze, `frozen: false` to unfreeze. Returns the updated card metadata so the host can re-render card-status without a follow-up call.",
    {
      frozen: z
        .boolean()
        .describe(
          "Target frozen state. true freezes the card; false unfreezes it.",
        ),
    },
    async (args) => {
      if (!cards) return wrap({ ok: false, tip: noSessionTip }, meta, true);
      const client = await cards.getOperations();
      if (!client) return wrap({ ok: false, tip: noSessionTip }, meta, true);

      try {
        const card = args.frozen
          ? await client.cardFreeze()
          : await client.cardUnfreeze();
        const status = String(
          (card as { status?: string }).status ?? "",
        ).toLowerCase();
        const data = {
          ok: true as const,
          stage: status === "frozen" ? "frozen" : "active",
          card,
        };
        return wrap(data, meta);
      } catch (err: any) {
        const loginRequired = maybeLoginRequiredResult(err, meta);
        if (loginRequired) return loginRequired;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: err.message || String(err) }, null, 2) },
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
