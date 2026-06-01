/**
 * Wallet adapter contract.
 *
 * The registrars in this package never reach into a global wallet object
 * or a filesystem-backed key store. Each consumer (npm CLI, hosted public
 * server, hosted authenticated server) provides a wallet adapter that
 * exposes only what the registrars need. This keeps the registrars
 * environment-agnostic and lets each consumer wire its own wallet
 * implementation behind a uniform surface.
 *
 * Implementations:
 *   - npm @dexterai/opendexter: file-backed local keypair (LoadedWallet)
 *   - hosted public server:     anonymous session-bound wallet
 *   - hosted authenticated server: Supabase-backed managed wallet
 *
 * The adapter returns null from any method when the underlying wallet
 * does not support that capability (e.g., no EVM signer on a Solana-only
 * wallet). Registrars are responsible for handling null gracefully.
 */

/** Minimal Solana signer. Used by x402_access for Sign-In-With-X. */
export interface SolanaSigner {
  /** Solana public key, in base58 format. */
  publicKey: { toBase58(): string } | string;
  /** Sign an arbitrary message. Returns the 64-byte detached signature. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** Minimal EVM signer. Used by x402_access for Sign-In-With-X. */
export interface EvmSigner {
  /** Checksummed EVM address. */
  address: string;
  /** Sign a message string per EIP-191. */
  signMessage(args: { message: string }): Promise<string>;
}

/**
 * Wallet info reported by x402_wallet. All fields optional — return only
 * what your wallet implementation actually has.
 */
export interface WalletInfo {
  solanaAddress?: string | null;
  evmAddress?: string | null;
  /** Optional consumer-specific descriptor (file path, session id, etc). */
  descriptor?: string | null;
}

/**
 * Balance breakdown reported by x402_wallet. Mirrors the canonical shape
 * the hosted servers and ChatGPT widgets already consume.
 */
export interface WalletBalances {
  /** Sum of VERIFIED chains only. Chains whose balance read failed are
   *  excluded (see `degraded`) — never silently counted as 0. */
  totalUsdc: number;
  /** Per-chain balance. `usdc: null` means the read failed (RPC error /
   *  rate-limit), distinct from a verified 0. Consumers must not render a
   *  null as "$0" or sum it into spendable funds. */
  chains: Record<string, { name: string; usdc: number | null }>;
  /** True when one or more chains could not be verified — `totalUsdc` is then
   *  a floor, not the full balance. Optional for backward compatibility with
   *  adapters that predate this field. */
  degraded?: boolean;
  /** CAIP-2 ids of the chains that could not be verified this read. */
  unavailableChains?: string[];
}

/**
 * Full wallet adapter consumed by every registrar that needs wallet
 * access. Each method is async and may return null/undefined where the
 * underlying wallet doesn't support that capability.
 */
export interface WalletAdapter {
  /** Read-only descriptive info, surfaced by x402_wallet. */
  getInfo(): WalletInfo;

  /** USDC balance for a given network ID (solana:... or eip155:...). */
  getAvailableUsdc(network: string): Promise<number>;

  /** Aggregate balances across every supported network. */
  getAllBalances(): Promise<WalletBalances>;

  /**
   * Private keys for the @dexterai/x402 client's auto-pay flow.
   * Hosted servers that don't expose private keys (e.g., custodial
   * managed wallets that sign through an internal API) should return
   * empty strings or undefined and rely on a separate signing path.
   */
  getPaymentSigners(): { solanaPrivateKey?: string; evmPrivateKey?: string };

  /** Solana signer for SIWX. Returns null if no Solana key is available. */
  getSolanaSigner(): SolanaSigner | null;

  /** EVM signer for SIWX. Returns null if no EVM key is available. */
  getEvmSigner(): EvmSigner | null;
}

/**
 * Spend policy callback. Returns the per-call USDC cap. The npm CLI
 * reads from ~/.dexterai-mcp/settings.json; hosted servers return
 * Number.POSITIVE_INFINITY (no cap) or a deployment-specific value.
 */
export type GetMaxAmountUsdc = () => number;
