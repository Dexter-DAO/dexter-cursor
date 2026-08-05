import { existsSync, readFileSync } from "node:fs";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { createPublicClient, http, erc20Abi, isAddress } from "viem";
import { type Chain, base, polygon, arbitrum, optimism, avalanche, bsc, skaleBase } from "viem/chains";
import { WALLET_FILE, SOLANA_RPC_URL, EVM_RPC_URLS, EVM_USDC_ADDRESSES, CHAIN_NAMES, usdcDecimalsForChain } from "../config.js";
import { loadSession } from "../connect/store.js";
import {
  showConnectedWallet,
  type HostedWalletResult,
} from "../connect/wallet.js";

export interface WalletInfo {
  solanaPrivateKey?: string;
  solanaAddress?: string;
  evmPrivateKey?: string;
  evmAddress?: string;
  createdAt: string;
}

/** @deprecated Local wallet mutation is permanently unavailable. */
export function saveWalletInfo(_info: WalletInfo): void {
  throw new Error("legacy_local_wallet_mutation_unavailable");
}

export interface LoadedWallet {
  info: WalletInfo;
  solanaKeypair?: Keypair;
  status?: "env" | "existing" | "migrated" | "created";
}

// usdc is `null` when the chain's balance could NOT be verified (RPC error,
// rate-limit, timeout) — distinct from a verified 0. A null must never be
// summed into a spendable total or rendered as "$0", or a transient RPC blip
// makes a funded wallet look empty and can wrongly block a payment.
export type ChainBalances = Record<string, { name: string; usdc: number | null }>;

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const VIEM_CHAINS: Record<string, Chain> = {
  "eip155:8453": base,
  "eip155:137": polygon,
  "eip155:42161": arbitrum,
  "eip155:10": optimism,
  "eip155:43114": avalanche,
  "eip155:56": bsc,
  "eip155:1187947933": skaleBase,
};

/**
 * @deprecated Retained only so stale internal imports fail closed. No command
 * or MCP tool calls this function, and it never reads, creates, repairs, or
 * migrates wallet.json or environment signer material.
 */
export async function loadOrCreateWallet(
  _opts: { quiet?: boolean } = {},
): Promise<LoadedWallet | null> {
  throw new Error("legacy_local_wallet_executor_unavailable");
}

export async function getSolanaBalance(
  address: string,
  rpcUrl?: string,
): Promise<{ sol: number | null; usdc: number | null }> {
  try {
    const connection = new Connection(rpcUrl || SOLANA_RPC_URL, "confirmed");
    const pubkey = new PublicKey(address);

    // null = couldn't verify (RPC failure), NOT a confirmed zero.
    const [solBalance, usdcBalance] = await Promise.all([
      connection.getBalance(pubkey).then(b => b / 1e9).catch(() => null),
      getUsdcBalance(connection, pubkey),
    ]);

    return { sol: solBalance, usdc: usdcBalance };
  } catch (err: any) {
    console.error(`[dexter-mcp] RPC error fetching Solana balance: ${err.message}`);
    return { sol: null, usdc: null };
  }
}

// Returns null when the balance could not be read (RPC error). A genuinely
// empty token account resolves to 0 (the getTokenAccountBalance path), while
// a missing ATA throws and is also reported as null — we cannot tell "no
// account" from "RPC down" here, and the safe reading is "unverified".
async function getUsdcBalance(connection: Connection, owner: PublicKey): Promise<number | null> {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
    const info = await connection.getTokenAccountBalance(ata);
    return Number(info.value.uiAmount ?? 0);
  } catch {
    return null;
  }
}

export async function getEvmUsdcBalance(
  address: string,
  chainId: string,
): Promise<number | null> {
  const viemChain = VIEM_CHAINS[chainId];
  const usdcAddress = EVM_USDC_ADDRESSES[chainId];
  if (!viemChain || !usdcAddress) return null;
  try {
    const client = createPublicClient({
      chain: viemChain,
      transport: http(EVM_RPC_URLS[chainId]),
    });
    const raw = await client.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });
    // Per-chain decimals — BSC USDC is 18, every other chain we touch is 6.
    // The old hardcoded /1e6 would have under-reported a $5 BSC balance as
    // $0.000000000000005. See config.ts::usdcDecimalsForChain.
    const decimals = usdcDecimalsForChain(chainId);
    return Number(raw) / Math.pow(10, decimals);
  } catch {
    // RPC error / rate-limit / timeout — NOT a zero balance. Return null so
    // the caller can flag the chain "unavailable" instead of reporting $0.
    return null;
  }
}

export async function getAllBalances(
  wallet: WalletInfo,
): Promise<{ totalUsdc: number; chains: ChainBalances; degraded: boolean; unavailableChains: string[] }> {
  const chains: ChainBalances = {};

  const solPromise = wallet.solanaAddress
    ? getSolanaBalance(wallet.solanaAddress).then(b => {
        chains["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] = { name: "Solana", usdc: b.usdc };
      })
    : Promise.resolve();

  const evmPromises = wallet.evmAddress
    ? Object.entries(VIEM_CHAINS).map(async ([chainId]) => {
        const usdc = await getEvmUsdcBalance(wallet.evmAddress!, chainId);
        const meta = CHAIN_NAMES[chainId];
        chains[chainId] = { name: meta?.name || chainId, usdc };
      })
    : [];

  await Promise.all([solPromise, ...evmPromises]);

  // Sum only VERIFIED chains. A chain whose read failed (usdc === null) is
  // excluded from the spendable total and listed in unavailableChains, with
  // degraded=true so a consumer knows the total is a floor, not the truth.
  const unavailableChains = Object.entries(chains)
    .filter(([, c]) => c.usdc === null)
    .map(([caip2]) => caip2);
  const totalUsdc = Object.values(chains).reduce(
    (sum, c) => sum + (c.usdc ?? 0),
    0,
  );
  return { totalUsdc, chains, degraded: unavailableChains.length > 0, unavailableChains };
}

export interface ShowWalletOpts {
  dev: boolean;
  /** Explicit read-only view of an existing legacy wallet.json. */
  legacyRecovery?: boolean;
  /** Legacy wallet path override (test seam). */
  legacyWalletFile?: string;
  /** Session-store directory override (test seam). */
  dataDir?: string;
  /** Primary output sink (default console.log). */
  log?: (line: string) => void;
  /** Secondary sink for the connect hint — stderr so it can't corrupt JSON. */
  hint?: (line: string) => void;
  /** Legacy recovery renderer override (test seam). */
  renderLegacyRecovery?: (
    log: (line: string) => void,
    walletFile: string,
  ) => Promise<void>;
  /** Read-only balance reader override for legacy recovery tests. */
  readLegacyBalances?: typeof getAllBalances;
  /** Hosted x402_wallet call override (test seam, forwarded to connected mode). */
  callHostedWallet?: (accessToken: string) => Promise<HostedWalletResult>;
  /** HTTP client override (test seam, forwarded to connected mode). */
  fetchImpl?: typeof fetch;
  /** Clock override (test seam, forwarded to connected mode). */
  now?: () => number;
}

/**
 * `opendexter wallet`.
 *
 * Connected mode (a `connect` session exists): read the user's hosted wallet
 * and governed x402-authority evidence through the remote `x402_wallet` tool.
 * The same hosted runtime is the only payment executor. No-session mode is
 * non-custodial and never reads or creates wallet.json. An explicit
 * `--legacy-recovery` view may read public addresses and balances from an
 * existing wallet.json, but never loads, exports, or enables its signer.
 */
export async function showWalletInfo(opts: ShowWalletOpts): Promise<void> {
  const log = opts.log ?? console.log;
  const hint = opts.hint ?? ((line: string) => console.error(line));

  if (opts.legacyRecovery) {
    if (opts.renderLegacyRecovery) {
      await opts.renderLegacyRecovery(log, opts.legacyWalletFile ?? WALLET_FILE);
    } else {
      await renderLegacyWalletRecovery(
        log,
        opts.legacyWalletFile ?? WALLET_FILE,
        opts.readLegacyBalances,
      );
    }
    hint("");
    hint(
      "Legacy recovery is read-only. Its signer was not loaded and cannot execute payments; run `opendexter connect` for hosted governed x402 authority.",
    );
    return;
  }

  const session = loadSession(opts.dataDir);
  if (session) {
    await showConnectedWallet({
      session,
      dev: opts.dev,
      dataDir: opts.dataDir,
      log,
      callHostedWallet: opts.callHostedWallet,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    });
    return;
  }

  log(JSON.stringify({ runtimeAuthority: disconnectedRuntimeAuthority() }, null, 2));
  hint("");
  hint("Run `opendexter connect` to use your hosted governed x402 authority.");
  hint(
    "Legacy wallet.json/env signers are not payment executors. `opendexter wallet --legacy-recovery` is a read-only public-address and balance view only.",
  );
}

function disconnectedRuntimeAuthority() {
  return {
    namespace: "opendexter-runtime-authority/v1",
    runtimeSource: "hosted_governed_x402",
    status: "disconnected",
    active: false,
    authoritySource: null,
    grantId: null,
    grantRevision: null,
    logicalGrantActive: null,
    principal: null,
    limits: null,
    remaining: null,
    expiresAt: null,
    scopes: null,
    activeRole: null,
    revocation: {
      revoked: null,
      manageUrl: "https://dexter.cash/wallet",
    },
    fallback: {
      available: false,
      enabled: false,
      active: false,
      automatic: false,
    },
    evidenceNamespace: null,
    reason: "connect_required",
  } as const;
}

export function readLegacyWalletPublicInfo(
  walletFile: string = WALLET_FILE,
): Pick<WalletInfo, "solanaAddress" | "evmAddress" | "createdAt"> | null {
  if (!existsSync(walletFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(walletFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    let solanaAddress: string | undefined;
    if (typeof record.solanaAddress === "string") {
      try {
        const candidate = record.solanaAddress.trim();
        if (new PublicKey(candidate).toBase58() === candidate) {
          solanaAddress = candidate;
        }
      } catch {
        // Do not echo an arbitrary wallet-file field as a public address.
      }
    }
    const evmAddress =
      typeof record.evmAddress === "string" && isAddress(record.evmAddress)
        ? record.evmAddress
        : undefined;
    if (!solanaAddress && !evmAddress) return null;
    return {
      createdAt:
        typeof record.createdAt === "string" ? record.createdAt : "",
      ...(solanaAddress ? { solanaAddress } : {}),
      ...(evmAddress ? { evmAddress } : {}),
    };
  } catch {
    return null;
  }
}

async function renderLegacyWalletRecovery(
  log: (line: string) => void,
  walletFile: string,
  readBalances: typeof getAllBalances = getAllBalances,
): Promise<void> {
  const wallet = readLegacyWalletPublicInfo(walletFile);
  if (!wallet) {
    log(JSON.stringify({
      legacyWalletRecovery: {
        status: "unavailable",
        readOnly: true,
        paymentEnabled: false,
        signerLoaded: false,
        privateKeysExported: false,
        walletFile,
        reason: "existing_wallet_with_public_addresses_not_found",
      },
      runtimeAuthority: disconnectedRuntimeAuthority(),
    }, null, 2));
    return;
  }

  const { totalUsdc, chains, degraded, unavailableChains } =
    await readBalances(wallet);

  const result: Record<string, unknown> = {
    address: wallet.solanaAddress || wallet.evmAddress || null,
    solanaAddress: wallet.solanaAddress || null,
    evmAddress: wallet.evmAddress || null,
    network: "multichain",
    chainBalances: Object.fromEntries(
      Object.entries(chains).map(([caip2, data]) => [
        caip2,
        {
          // A chain whose read failed reports available:null + unavailable:true
          // rather than "0", so a transient RPC error can't masquerade as an
          // empty balance.
          available: data.usdc === null ? null : String(Math.round(data.usdc * 1e6)),
          ...(data.usdc === null ? { unavailable: true } : {}),
          name: data.name,
          tier: caip2 === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" || caip2 === "eip155:8453" ? "first" : "second",
        },
      ]),
    ),
    balances: {
      // usdc/availableAtomic are the VERIFIED total (errored chains excluded).
      // `degraded` flags that the real total may be higher than shown.
      usdc: totalUsdc,
      fundedAtomic: String(Math.round(totalUsdc * 1e6)),
      spentAtomic: "0",
      availableAtomic: String(Math.round(totalUsdc * 1e6)),
      degraded,
      ...(degraded ? { unavailableChains } : {}),
    },
    supportedNetworks: Object.keys(chains).length > 0
      ? Object.keys(chains).map((caip2) => CHAIN_NAMES[caip2]?.name?.toLowerCase() || caip2)
      : ["solana", "base", "polygon", "arbitrum", "optimism", "avalanche"],
    legacyWalletRecovery: {
      status: "available",
      readOnly: true,
      paymentEnabled: false,
      signerLoaded: false,
      privateKeysExported: false,
      walletFile,
    },
    runtimeAuthority: disconnectedRuntimeAuthority(),
  };
  if (degraded) {
    result.note = `Could not verify balances on ${unavailableChains.length} chain(s). This recovery view is non-payment and reports only verified balances.`;
  } else {
    result.note = "Legacy balances are shown for recovery only; connect a hosted governed runtime before any payment.";
  }

  log(JSON.stringify(result, null, 2));
}
