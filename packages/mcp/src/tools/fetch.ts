import {
  callHostedRuntimeTool,
  structuredToolResult,
} from "../connect/wallet.js";

/**
 * CLI entrypoint for the `opendexter fetch` and `opendexter pay`
 * subcommands.
 *
 * This path accepts only the opaque hosted intent and a caller-approved atomic
 * ceiling. It never reads wallet.json or environment signers and never retries
 * after a possibly dispatched payment call.
 */
export async function cliFetch(
  opts: {
    dev: boolean;
    maxAmountAtomic?: string;
    intentId?: string;
  },
): Promise<void> {
  try {
    if (!opts.intentId) {
      throw new Error(
        "--intent-id is required for the hosted governed runtime; run `opendexter check <url>` first",
      );
    }
    if (!opts.maxAmountAtomic) {
      throw new Error("--max-amount-atomic is required for the hosted governed runtime");
    }
    if (opts.intentId.length > 256) {
      throw new Error("--intent-id exceeds the hosted runtime limit");
    }
    if (!/^[1-9]\d{0,19}$/.test(opts.maxAmountAtomic)) {
      throw new Error(
        "--max-amount-atomic must be a positive atomic-unit integer of at most 20 digits",
      );
    }
    const response = await callHostedRuntimeTool({
      toolName: "x402_fetch",
      arguments: {
        intentId: opts.intentId,
        maxAmountAtomic: opts.maxAmountAtomic,
      },
      dev: opts.dev,
      retryRejectedBearer: false,
    });
    console.log(JSON.stringify(structuredToolResult(response), null, 2));
    if (response.isError === true) process.exit(1);
  } catch (err: any) {
    const msg = err.message || String(err);
    console.log(JSON.stringify({ error: msg }, null, 2));
    process.exit(1);
  }
}
