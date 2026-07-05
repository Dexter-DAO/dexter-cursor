import { x402Fetch } from "@dexterai/x402-mcp-tools";
import { loadOrCreateWallet } from "../wallet/index.js";
import { createNpmWalletAdapter } from "../wallet/adapter.js";
import { loadSettings } from "../settings.js";
import { recordSpend, spentLast24h } from "../spend-ledger.js";
import { createTabLane } from "../tabs/lane.js";

/**
 * CLI entrypoint for the `opendexter fetch` and `opendexter pay`
 * subcommands.
 *
 * The MCP tool registrations for `x402_fetch` and `x402_pay` live in the
 * shared @dexterai/x402-mcp-tools package and are mounted in
 * src/server/index.ts. This file owns only the npm-CLI-flavored output.
 *
 * Payment order: when the 402 offers scheme 'tab' AND this CLI custodies
 * an active grant for the seller (`opendexter tab connect`), the call pays
 * by tab voucher; otherwise exact, exactly as before. `--no-tab` forces
 * the exact path.
 */
export async function cliFetch(
  url: string,
  opts: {
    method: string;
    body?: string;
    dev: boolean;
    maxAmountUsdc?: number;
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
    const tabLane = opts.noTab
      ? null
      : createTabLane({
          getMaxAmountUsdc: () => effectiveMax,
          getBudgetRuntime: () => budgetRuntime,
        });
    const result = await x402Fetch(
      { url, method: opts.method, body: opts.body },
      adapter,
      {
        maxAmountUsdc: effectiveMax,
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
