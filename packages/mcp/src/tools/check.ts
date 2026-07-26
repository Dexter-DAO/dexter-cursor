import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { registerCheckTool } from "@dexterai/x402-mcp-tools";
import type { WalletAdapter } from "@dexterai/x402-mcp-tools";
import { CAPABILITY_PATH, WALLET_FILE, getApiBase } from "../config.js";
import { createPurchaseAttemptStore } from "../purchase-attempt-ledger.js";
import { createTabLane } from "../tabs/lane.js";
import { loadSettings } from "../settings.js";
import { recordSpend, spentLast24h } from "../spend-ledger.js";

type PaymentSigners = ReturnType<WalletAdapter["getPaymentSigners"]>;

function validSolanaPrivateKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    Keypair.fromSecretKey(bs58.decode(value));
    return value;
  } catch {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return undefined;
      Keypair.fromSecretKey(Uint8Array.from(parsed));
      return value;
    } catch {
      return undefined;
    }
  }
}

function validEvmPrivateKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    privateKeyToAccount(value as `0x${string}`);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Read payment capability without creating, migrating, backing up, or
 * rewriting the wallet. A read-only price check must never mutate custody.
 */
export function readConfiguredPaymentSigners(
  walletFile: string = WALLET_FILE,
  env: NodeJS.ProcessEnv = process.env,
): PaymentSigners {
  let stored: Record<string, unknown> = {};
  if (existsSync(walletFile)) {
    try {
      const parsed = JSON.parse(readFileSync(walletFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        stored = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt configuration is an unavailable capability. Unlike
      // loadOrCreateWallet, this read-only path never repairs or replaces it.
    }
  }
  const configuredSolana =
    env.DEXTER_PRIVATE_KEY
    ?? env.SOLANA_PRIVATE_KEY
    ?? stored.solanaPrivateKey;
  const configuredEvm =
    env.EVM_PRIVATE_KEY
    ?? stored.evmPrivateKey;
  return {
    solanaPrivateKey: validSolanaPrivateKey(configuredSolana),
    evmPrivateKey: validEvmPrivateKey(configuredEvm),
  };
}

/**
 * CLI entrypoint for the `opendexter check` subcommand.
 *
 * The MCP tool registration for `x402_check` lives in the shared
 * @dexterai/x402-mcp-tools package and is mounted in src/server/index.ts.
 * This file owns only the npm-CLI-flavored output.
 */
export async function cliCheck(
  url: string,
  opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    body?: string;
    dev: boolean;
  },
): Promise<void> {
  try {
    let sampleInputBody: Record<string, unknown> | undefined;
    if (opts.body !== undefined) {
      const parsed = JSON.parse(opts.body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--body must be a JSON object");
      }
      sampleInputBody = parsed as Record<string, unknown>;
    }
    const paymentSigners = readConfiguredPaymentSigners();
    const walletAdapter = paymentSigners.solanaPrivateKey
      || paymentSigners.evmPrivateKey
      ? ({
          getPaymentSigners: () => paymentSigners,
        } as WalletAdapter)
      : null;
    const tabLane = createTabLane({
      getMaxAmountUsdc: () => loadSettings().maxAmountUsdc,
      getBudgetRuntime: () => ({
        dailyBudgetUsdc: loadSettings().dailyBudgetUsdc,
        spentLast24hUsdc: spentLast24h(),
        recordSpend,
      }),
    });
    const purchaseAttempts = createPurchaseAttemptStore();
    let handler:
      | ((args: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | null = null;
    const registrationServer = {
      registerTool(
        _name: string,
        _definition: unknown,
        toolHandler: (
          args: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>,
      ) {
        handler = toolHandler;
      },
    };
    registerCheckTool(registrationServer as never, {
      apiBaseUrl: getApiBase(opts.dev),
      capabilityPath: CAPABILITY_PATH,
      metas: { check: {} } as never,
      wallet: walletAdapter,
      getTabLane: () => tabLane,
      getPurchaseAttemptStore: () => purchaseAttempts,
    });
    const registeredHandler = handler as unknown as
      | ((args: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | null;
    if (!registeredHandler) throw new Error("x402_check_registration_failed");
    const response = await registeredHandler({
      url,
      method: opts.method,
      ...(sampleInputBody ? { sampleInputBody } : {}),
    });
    const output =
      response.structuredContent
      ?? (() => {
        const first = Array.isArray(response.content)
          ? response.content[0]
          : null;
        if (
          first
          && typeof first === "object"
          && (first as { type?: unknown }).type === "text"
        ) {
          return JSON.parse(
            String((first as { text?: unknown }).text ?? "{}"),
          );
        }
        return response;
      })();
    console.log(JSON.stringify(output, null, 2));
    if (response.isError === true) process.exit(1);
  } catch (err: any) {
    console.log(JSON.stringify({ error: err.message || String(err) }, null, 2));
    process.exit(1);
  }
}
