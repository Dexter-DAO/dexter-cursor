import {
  preparedPurchaseSchema,
  x402Fetch,
  type PreparedPurchaseV1,
} from "@dexterai/x402-mcp-tools";
import { loadOrCreateWallet } from "../wallet/index.js";
import { createNpmWalletAdapter } from "../wallet/adapter.js";
import { loadSettings } from "../settings.js";
import { recordSpend, spentLast24h } from "../spend-ledger.js";
import { createTabLane } from "../tabs/lane.js";
import { createPurchaseAttemptStore } from "../purchase-attempt-ledger.js";

/**
 * CLI entrypoint for the `opendexter fetch` and `opendexter pay`
 * subcommands.
 *
 * The canonical MCP `x402_fetch` registration lives in the shared
 * @dexterai/x402-mcp-tools package and is mounted without its historical alias
 * in src/server/index.ts. This file owns only the npm-CLI-flavored output.
 *
 * New calls pass one prepared purchase from `opendexter check`; its explicit
 * mode selects exactly one adapter and never falls through to another mode.
 * Calls without `--purchase` retain the prior automatic Tab/Exact behavior
 * for compatibility only.
 */
export async function cliFetch(
  url: string,
  opts: {
    method: string;
    body?: string;
    dev: boolean;
    maxAmountUsdc?: number;
    maxAmountAtomic?: string;
    purchase?: string;
    noTab?: boolean;
  },
): Promise<void> {
  try {
    const wallet = await loadOrCreateWallet();
    const adapter = wallet ? createNpmWalletAdapter(wallet) : null;
    const settings = loadSettings();
    const effectiveMax = opts.maxAmountUsdc ?? settings.maxAmountUsdc;
    const budgetRuntime = {
      dailyBudgetUsdc: settings.dailyBudgetUsdc,
      spentLast24hUsdc: spentLast24h(),
      recordSpend,
    };
    let purchase: PreparedPurchaseV1 | undefined;
    if (opts.purchase) {
      const parsed = preparedPurchaseSchema.safeParse(JSON.parse(opts.purchase));
      if (!parsed.success) {
        throw new Error("--purchase must contain one preparedPurchase returned by opendexter check");
      }
      purchase = parsed.data as PreparedPurchaseV1;
      if (!opts.maxAmountAtomic) {
        throw new Error("--max-amount-atomic is required with --purchase");
      }
    }
    const tabLane = opts.noTab
      ? null
      : createTabLane({
          getMaxAmountUsdc: () => effectiveMax,
          getBudgetRuntime: () => budgetRuntime,
        });
    const purchaseAttempts = createPurchaseAttemptStore();
    const result = await x402Fetch(
      { url, method: opts.method, body: opts.body, purchase },
      adapter,
      {
        maxAmountUsdc: effectiveMax,
        maxAmountAtomic: opts.maxAmountAtomic,
        purchaseAttempts,
        dailyBudgetUsdc: settings.dailyBudgetUsdc,
        spentLast24hUsdc: budgetRuntime.spentLast24hUsdc,
        recordSpend,
        ...(tabLane ? { tabLane } : {}),
      },
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    const msg =
      err.cause?.code === "ENOTFOUND"
        ? `Could not reach ${url} — DNS lookup failed`
        : err.name === "TimeoutError"
          ? `Request to ${url} timed out`
          : err.message || String(err);
    console.log(JSON.stringify({ error: msg }, null, 2));
    process.exit(1);
  }
}
