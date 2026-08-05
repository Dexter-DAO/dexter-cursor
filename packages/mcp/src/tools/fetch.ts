import {
  callHostedRuntimeTool,
  structuredToolResult,
} from "../connect/wallet.js";
import { VERSION } from "../config.js";

function requireIntentId(intentId: string | undefined): string {
  if (!intentId) {
    throw new Error(
      "--intent-id is required for the hosted governed runtime; run `opendexter check <url>` first",
    );
  }
  if (intentId.length > 256) {
    throw new Error("--intent-id exceeds the hosted runtime limit");
  }
  return intentId;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function fetchRecovery(intentId: string): Record<string, unknown> {
  const argv = [
    "npx",
    "-y",
    `@dexterai/opendexter@${VERSION}`,
    "status",
    "--intent-id",
    intentId,
  ];
  return {
    noRetry: true,
    intentId,
    recovery: {
      tool: "x402_status",
      argv,
      command: argv.slice(0, -1).join(" ") + ` ${shellQuote(intentId)}`,
    },
  };
}

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
  let dispatchedIntentId: string | null = null;
  try {
    const intentId = requireIntentId(opts.intentId);
    if (!opts.maxAmountAtomic) {
      throw new Error("--max-amount-atomic is required for the hosted governed runtime");
    }
    if (!/^[1-9]\d{0,19}$/.test(opts.maxAmountAtomic)) {
      throw new Error(
        "--max-amount-atomic must be a positive atomic-unit integer of at most 20 digits",
      );
    }
    const response = await callHostedRuntimeTool({
      toolName: "x402_fetch",
      arguments: {
        intentId,
        maxAmountAtomic: opts.maxAmountAtomic,
      },
      dev: opts.dev,
      retryRejectedBearer: false,
      onDispatch: () => {
        dispatchedIntentId = intentId;
      },
    });
    const result = structuredToolResult(response);
    console.log(JSON.stringify(
      response.isError === true
        ? { ...result, ...fetchRecovery(intentId) }
        : result,
      null,
      2,
    ));
    if (response.isError === true) process.exitCode = 1;
  } catch (err: any) {
    const msg = err.message || String(err);
    console.log(JSON.stringify({
      error: msg,
      ...(dispatchedIntentId ? fetchRecovery(dispatchedIntentId) : {}),
    }, null, 2));
    process.exitCode = 1;
  }
}

/** Read-only same-surface recovery for one exact hosted purchase intent. */
export async function cliStatus(opts: {
  dev: boolean;
  intentId?: string;
}): Promise<void> {
  try {
    const intentId = requireIntentId(opts.intentId);
    const response = await callHostedRuntimeTool({
      toolName: "x402_status",
      arguments: { intentId },
      dev: opts.dev,
    });
    console.log(JSON.stringify(structuredToolResult(response), null, 2));
    if (response.isError === true) process.exitCode = 1;
  } catch (err: any) {
    const msg = err.message || String(err);
    console.log(JSON.stringify({ error: msg }, null, 2));
    process.exitCode = 1;
  }
}
