/**
 * WalletAdapter implementation for the npm @dexterai/opendexter CLI.
 *
 * Bridges the file-backed `LoadedWallet` (loaded via loadOrCreateWallet)
 * to the WalletAdapter contract consumed by @dexterai/x402-mcp-tools.
 *
 * This is the only adapter implementation in this package — the hosted
 * MCP servers will provide their own adapters that talk to their session
 * resolver and managed-wallet APIs.
 */

import type { WalletAdapter, SolanaSigner, EvmSigner } from "@dexterai/x402-mcp-tools";
import nacl from "tweetnacl";
import type { LoadedWallet } from "./index.js";
import { getAllBalances, getSolanaBalance, getEvmUsdcBalance } from "./index.js";

/**
 * Resolve a network identifier into a `{family, caip2}` pair. x402 v2 uses
 * CAIP-2 ids (`eip155:8453`, `solana:...`); x402 v1 uses bare names (`base`,
 * `polygon`, `solana`). A balance/signer lookup must understand both — keying
 * only on the CAIP-2 prefix silently reads $0 for every v1 endpoint.
 */
const BARE_EVM_CAIP2: Record<string, string> = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  avalanche: "eip155:43114",
  "avalanche-c": "eip155:43114",
  ethereum: "eip155:1",
  bsc: "eip155:56",
};
function resolveNetwork(
  network: string,
): { family: "evm" | "svm" | "unknown"; caip2: string | null } {
  const n = (network || "").toLowerCase().trim();
  if (n.startsWith("solana:") || n === "solana" || n === "svm") {
    return { family: "svm", caip2: n.includes(":") ? n : null };
  }
  if (n.startsWith("eip155:")) return { family: "evm", caip2: n };
  if (BARE_EVM_CAIP2[n]) return { family: "evm", caip2: BARE_EVM_CAIP2[n] };
  return { family: "unknown", caip2: null };
}

export function createNpmWalletAdapter(wallet: LoadedWallet): WalletAdapter {
  return {
    getInfo() {
      return {
        solanaAddress: wallet.info.solanaAddress ?? null,
        evmAddress: wallet.info.evmAddress ?? null,
      };
    },

    async getAvailableUsdc(network: string): Promise<number> {
      // x402 v2 sends CAIP-2 network ids (eip155:8453, solana:...); x402 v1
      // sends bare names (base, polygon, solana, ...). Resolve both, or a
      // v1 endpoint's balance check silently reads $0 — which would falsely
      // block a funded wallet on the entire v1 category.
      const resolved = resolveNetwork(network);
      if (resolved.family === "svm" && wallet.info.solanaAddress) {
        const { usdc } = await getSolanaBalance(wallet.info.solanaAddress);
        return usdc;
      }
      if (resolved.family === "evm" && resolved.caip2 && wallet.info.evmAddress) {
        return await getEvmUsdcBalance(wallet.info.evmAddress, resolved.caip2);
      }
      return 0;
    },

    async getAllBalances() {
      return await getAllBalances(wallet.info);
    },

    getPaymentSigners() {
      return {
        solanaPrivateKey: wallet.info.solanaPrivateKey,
        evmPrivateKey: wallet.info.evmPrivateKey,
      };
    },

    getSolanaSigner(): SolanaSigner | null {
      if (!wallet.solanaKeypair || !wallet.info.solanaAddress) return null;
      const keypair = wallet.solanaKeypair;
      return {
        publicKey: keypair.publicKey,
        signMessage: async (message: Uint8Array) =>
          nacl.sign.detached(message, keypair.secretKey),
      };
    },

    getEvmSigner(): EvmSigner | null {
      if (!wallet.info.evmPrivateKey || !wallet.info.evmAddress) return null;
      const evmAddress = wallet.info.evmAddress;
      const evmPrivateKey = wallet.info.evmPrivateKey as `0x${string}`;
      return {
        address: evmAddress,
        async signMessage({ message }: { message: string }): Promise<string> {
          const { privateKeyToAccount } = await import("viem/accounts");
          const account = privateKeyToAccount(evmPrivateKey);
          return account.signMessage({ message });
        },
      };
    },
  };
}
