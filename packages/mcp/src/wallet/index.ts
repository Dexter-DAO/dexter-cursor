import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi } from "viem";
import { type Chain, base, polygon, arbitrum, optimism, avalanche, bsc, skaleBase } from "viem/chains";
import bs58 from "bs58";
import { DATA_DIR, WALLET_FILE, SOLANA_RPC_URL, EVM_RPC_URLS, EVM_USDC_ADDRESSES, CHAIN_NAMES, usdcDecimalsForChain } from "../config.js";

export interface WalletInfo {
  solanaPrivateKey?: string;
  solanaAddress?: string;
  evmPrivateKey?: string;
  evmAddress?: string;
  createdAt: string;
}

export function saveWalletInfo(info: WalletInfo): void {
  persistWalletFile(info);
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

function generateEvmWallet(): { evmPrivateKey: string; evmAddress: string } {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { evmPrivateKey: pk, evmAddress: account.address };
}

function persistWalletFile(info: WalletInfo): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(WALLET_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
}

function buildLoadedWallet(info: WalletInfo, status: LoadedWallet["status"] = "existing"): LoadedWallet {
  return {
    info,
    solanaKeypair: info.solanaPrivateKey ? keypairFromString(info.solanaPrivateKey) : undefined,
    status,
  };
}

export async function loadOrCreateWallet(opts: { quiet?: boolean } = {}): Promise<LoadedWallet | null> {
  const quiet = opts.quiet === true;
  const envKey = process.env.DEXTER_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  const envEvmKey = process.env.EVM_PRIVATE_KEY;

  if (envKey || envEvmKey) {
    const info: WalletInfo = {
      createdAt: new Date().toISOString(),
    };
    if (envKey) {
      const keypair = keypairFromString(envKey);
      info.solanaPrivateKey = bs58.encode(keypair.secretKey);
      info.solanaAddress = keypair.publicKey.toBase58();
    }
    if (envEvmKey) {
      const account = privateKeyToAccount(envEvmKey as `0x${string}`);
      info.evmPrivateKey = envEvmKey;
      info.evmAddress = account.address;
    }
    return buildLoadedWallet(info, "env");
  }

  if (existsSync(WALLET_FILE)) {
    try {
      const raw = readFileSync(WALLET_FILE, "utf-8");
      const data = JSON.parse(raw) as WalletInfo;
      if (!data.solanaPrivateKey && !data.evmPrivateKey) {
        throw new Error("Missing wallet private keys");
      }
      // Persist a one-time dual-wallet normalization so future processes read the
      // same addresses, but keep the migration logic explicit instead of hiding
      // shape changes in downstream tool code.
      if (!data.evmPrivateKey) {
        const evm = generateEvmWallet();
        data.evmPrivateKey = evm.evmPrivateKey;
        data.evmAddress = evm.evmAddress;
        persistWalletFile(data);
        if (!quiet) {
          console.error(`[opendexter] Added EVM wallet to existing file: ${evm.evmAddress}`);
        }
        return buildLoadedWallet(data, "migrated");
      }

      return buildLoadedWallet(data, "existing");
    } catch (err: any) {
      if (!quiet) {
        console.error(`[opendexter] Corrupted wallet file: ${err.message}`);
        console.error(`[opendexter] Backing up to ${WALLET_FILE}.bak and creating fresh wallet.`);
      }
      try { copyFileSync(WALLET_FILE, WALLET_FILE + ".bak"); } catch {}
    }
  }

  // Server mode: instant keypair, no vanity grind.
  // Vanity wallets are created via `opendexter wallet` CLI command (TTY with progress bars).
  const evm = generateEvmWallet();
  const keypair = Keypair.generate();
  const info: WalletInfo = {
    solanaPrivateKey: bs58.encode(keypair.secretKey),
    solanaAddress: keypair.publicKey.toBase58(),
    evmPrivateKey: evm.evmPrivateKey,
    evmAddress: evm.evmAddress,
    createdAt: new Date().toISOString(),
  };

  persistWalletFile(info);

  if (!quiet) {
    console.error(`[opendexter] New dual wallet created:`);
    console.error(`[opendexter]   Solana: ${info.solanaAddress}`);
    console.error(`[opendexter]   EVM:    ${evm.evmAddress}`);
    console.error(`[opendexter] Saved to ${WALLET_FILE}`);
    console.error(`[opendexter] Tip: Run \`opendexter wallet --vanity\` to regenerate with a branded dex/0x402 prefix.`);
    console.error(`[opendexter] Deposit USDC on Solana or any supported EVM chain to start paying for x402 APIs.`);
  }

  return buildLoadedWallet(info, "created");
}

function keypairFromString(key: string): Keypair {
  try {
    // Try base58
    return Keypair.fromSecretKey(bs58.decode(key));
  } catch {
    // Try JSON array
    try {
      const arr = JSON.parse(key);
      if (Array.isArray(arr)) {
        return Keypair.fromSecretKey(Uint8Array.from(arr));
      }
    } catch {}
    throw new Error("Invalid private key format. Expected base58 string or JSON byte array.");
  }
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

export async function showWalletInfo(opts: { dev: boolean }): Promise<void> {
  const wallet = await loadOrCreateWallet();
  if (!wallet) {
    console.log(JSON.stringify({ error: "Failed to load wallet" }));
    process.exit(1);
  }

  const { totalUsdc, chains, degraded, unavailableChains } = await getAllBalances(wallet.info);

  const result: Record<string, unknown> = {
    address: wallet.info.solanaAddress || wallet.info.evmAddress || null,
    solanaAddress: wallet.info.solanaAddress || null,
    evmAddress: wallet.info.evmAddress || null,
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
    walletFile: WALLET_FILE,
  };
  // Only suggest depositing when the wallet is VERIFIABLY empty — never when
  // the total is 0 merely because every chain read failed (that would tell a
  // funded user to deposit money they already have).
  if (totalUsdc === 0 && !degraded) {
    result.tip = `Deposit USDC to ${wallet.info.solanaAddress || "your Solana wallet"}${wallet.info.evmAddress ? ` or ${wallet.info.evmAddress}` : ""} to start paying for x402 APIs.`;
  } else if (totalUsdc === 0 && degraded) {
    result.tip = `Could not verify balances on ${unavailableChains.length} chain(s) (RPC unavailable). Retry before assuming the wallet is empty.`;
  }

  console.log(JSON.stringify(result, null, 2));
}
