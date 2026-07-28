/**
 * Connected-mode wallet read — `opendexter wallet` when a `connect` session exists.
 *
 * The load-bearing rule: this file NEVER derives the vault's on-chain address
 * or reads chain balances itself. The vault has a Swig two-address split — the
 * token's `dexter.vault` claim is the Swig STATE address, but user funds live
 * at a DERIVED wallet-PDA. Re-deriving locally would strand deposits at the
 * wrong address. Instead we call the HOSTED MCP server's `x402_wallet` tool
 * (which already computes the correct wallet-PDA deposit address + balances +
 * activation state) with the stored ES256 bearer, and display exactly what it
 * returns. Zero client-side address derivation.
 *
 * Auth lifecycle: the bearer is short-lived. On a 401 we refresh once against
 * dexter-api's connector token endpoint using the stored dlt_ refresh token,
 * persist the rotated pair, and retry the hosted call a single time. If the
 * refresh is refused, we tell the user to reconnect — we never fall back to
 * local derivation.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getApiBase, VERSION } from "../config.js";
import { saveSession, type VaultSession } from "./store.js";

/** The connector rail's OAuth token endpoint (device grant + refresh). */
const TOKEN_PATH = "/api/connector/oauth/token";
/** The client_id the connector rail knows this CLI by (matches connect.ts). */
const CLIENT_ID = "opendexter-cli";
/**
 * The hosted MCP server. The bearer's `aud` claim is minted for this exact
 * origin, so we always target it (a dev dexter-api still issues prod-aud vault
 * tokens). `OPENDEXTER_MCP_URL` overrides for local server testing.
 */
const HOSTED_MCP_URL = process.env.OPENDEXTER_MCP_URL || "https://open.dexter.cash/mcp";

/**
 * The subset of the hosted `x402_wallet` structuredContent we read. Kept loose
 * (index signature) because the hosted server owns the full shape — we map
 * defensively and never assume fields beyond address + balance are present.
 */
export interface HostedWalletResult {
  /** The wallet-PDA deposit address (NOT the dexter.vault state address). */
  address?: string | null;
  solanaAddress?: string | null;
  evmAddress?: string | null;
  network?: string;
  chainBalances?: Record<
    string,
    { available: string | null; name?: string; tier?: string; unavailable?: boolean }
  >;
  balances?: {
    usdc?: number;
    fundedAtomic?: string;
    spentAtomic?: string;
    availableAtomic?: string;
    degraded?: boolean;
    unavailableChains?: string[];
  };
  supportedNetworks?: string[];
  /** Some hosted builds surface vault activation state; render it if present. */
  activated?: boolean;
  activation?: { activated?: boolean; state?: string } | string | boolean;
  /** Enrollment signals: present when the vault itself isn't set up yet. */
  vault_status?: string;
  mode?: string;
  enroll_url?: string;
  pairing_url?: string;
  [key: string]: unknown;
}

/**
 * Open an MCP client to the hosted server with the ES256 bearer and call
 * `x402_wallet`. Returns the tool's structuredContent (or the parsed text
 * content as a fallback). Throws on transport/auth failure — a 401 surfaces as
 * a StreamableHTTPError with `.code === 401`, which `isAuthError` recognizes.
 */
export async function callHostedAccountTool<T extends Record<string, unknown> = Record<string, unknown>>(opts: {
  accessToken: string;
  toolName: "x402_wallet" | "dexter_portfolio";
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const url = new URL(opts.serverUrl ?? HOSTED_MCP_URL);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    },
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl as unknown as typeof fetch } : {}),
  });
  const client = new Client(
    { name: "opendexter-cli", version: VERSION },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const res = (await client.callTool({ name: opts.toolName, arguments: {} })) as {
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (res.structuredContent && typeof res.structuredContent === "object") {
      return res.structuredContent as T;
    }
    // Fallback: the tool always mirrors structuredContent into a text block.
    const text = Array.isArray(res.content)
      ? res.content.find((c) => c?.type === "text")?.text
      : undefined;
    if (text) {
      try {
        return JSON.parse(text) as T;
      } catch {
        /* fall through to empty */
      }
    }
    return {} as T;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function callHostedWalletTool(opts: {
  accessToken: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<HostedWalletResult> {
  return callHostedAccountTool<HostedWalletResult>({
    ...opts,
    toolName: "x402_wallet",
  });
}

/** True when an error from the hosted call means "bearer rejected / expired". */
export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: unknown; name?: unknown; message?: unknown };
  if (anyErr.code === 401) return true;
  if (String(anyErr.name ?? "") === "UnauthorizedError") return true;
  return /\b401\b|unauthorized|token.?expired|invalid_token/i.test(String(anyErr.message ?? ""));
}

/**
 * Exchange the stored dlt_ refresh token for a fresh access token against the
 * connector rail. Returns null on any refusal or network failure (the caller
 * then tells the user to reconnect — it never retries blindly).
 */
export async function refreshVaultToken(opts: {
  refreshToken: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number } | null> {
  if (!opts.refreshToken) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiBase.replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: opts.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) return null;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
    };
  } catch {
    return null;
  }
}

export interface ConnectedWalletOpts {
  session: VaultSession;
  dev?: boolean;
  dataDir?: string;
  log?: (line: string) => void;
  now?: () => number;
  serverUrl?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Test seam — the hosted x402_wallet call (default: real MCP client). */
  callHostedWallet?: (accessToken: string) => Promise<HostedWalletResult>;
}

/**
 * The connected-mode `opendexter wallet` body: call the hosted wallet tool,
 * refresh-and-retry once on a 401, then render the deposit address + balance.
 */
export async function showConnectedWallet(opts: ConnectedWalletOpts): Promise<void> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => Date.now());
  const serverUrl = opts.serverUrl ?? HOSTED_MCP_URL;
  const apiBase = opts.apiBase ?? getApiBase(opts.dev ?? false);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const callHosted =
    opts.callHostedWallet ??
    ((accessToken: string) => callHostedWalletTool({ accessToken, serverUrl, fetchImpl }));

  let session = opts.session;
  let result: HostedWalletResult;

  try {
    result = await callHosted(session.accessToken);
  } catch (err) {
    if (!isAuthError(err)) {
      // Transport/server hiccup — not an auth problem. Don't touch the session.
      log("Couldn't reach your Dexter vault just now. Try `opendexter wallet` again in a moment.");
      return;
    }
    // Bearer rejected — refresh once, persist, retry a single time.
    const refreshed = await refreshVaultToken({
      refreshToken: session.refreshToken,
      apiBase,
      fetchImpl,
    });
    if (!refreshed) {
      log("Your session expired — run `opendexter connect` again.");
      return;
    }
    session = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? session.refreshToken,
      expiresAt:
        now() + (refreshed.expiresIn && refreshed.expiresIn > 0 ? refreshed.expiresIn : 3600) * 1000,
    };
    saveSession(session, opts.dataDir);
    try {
      result = await callHosted(session.accessToken);
    } catch {
      log("Your session expired — run `opendexter connect` again.");
      return;
    }
  }

  renderConnectedWallet(result, log);
}

/** Atomic (6-dp) USDC string → number, or null when unparseable. */
function atomicToUsdc(atomic: string | undefined | null): number | null {
  if (atomic == null) return null;
  const n = Number(atomic);
  if (!Number.isFinite(n)) return null;
  return n / 1e6;
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Read activation state from whatever shape the hosted result carries. */
function readActivated(result: HostedWalletResult): boolean | null {
  if (typeof result.activated === "boolean") return result.activated;
  const a = result.activation;
  if (typeof a === "boolean") return a;
  if (a && typeof a === "object" && typeof a.activated === "boolean") return a.activated;
  return null;
}

/**
 * Apple-polished, no-emoji render of the connected vault. The deposit address
 * is always the hosted result's `address` (the wallet-PDA) — never the
 * dexter.vault state address on the session.
 */
function renderConnectedWallet(result: HostedWalletResult, log: (line: string) => void): void {
  // The session is connected, but the vault itself isn't set up yet — a user
  // who ran `connect` before finishing wallet setup. Guide them to finish;
  // never imply a service outage (that message is for a genuine no-data read).
  if (result.vault_status === "not_enrolled" || result.mode === "vault_required") {
    const setupUrl = result.enroll_url || result.pairing_url || "https://dexter.cash/wallet";
    log("");
    log("Dexter Wallet account view");
    log("  link: read-only");
    log("");
    log("  Your wallet isn't set up yet.");
    log(`  Finish setup at ${setupUrl}`);
    log("  then run `opendexter wallet` again.");
    log("");
    log("Payments in this local client still use its separately configured local signer.");
    log("Revoke this read-only link anytime at dexter.cash/wallet.");
    return;
  }

  const address = result.address || result.solanaAddress || null;
  const usdc =
    typeof result.balances?.usdc === "number"
      ? result.balances.usdc
      : atomicToUsdc(result.balances?.availableAtomic);
  const degraded = result.balances?.degraded === true;
  const activated = readActivated(result);

  log("");
  log("Dexter Wallet account view");
  log("  link: read-only");

  log("");
  log("  USDC balance");
  if (usdc == null) {
    log("    unavailable — the balance service didn't respond. Try again shortly.");
  } else {
    log(`    ${formatUsd(usdc)}${degraded ? "  (some chains unverified)" : ""}`);
  }

  if (address) {
    log("");
    log("  Deposit address");
    log(`    ${address}`);
  }

  if (activated === false) {
    log("");
    log("  Your vault activates automatically on your first deposit.");
  }

  log("");
  log("Payments in this local client still use its separately configured local signer.");
  log("Revoke this read-only link anytime at dexter.cash/wallet.");
}
