import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { showConnectedWallet, refreshVaultToken, type HostedWalletResult } from "./wallet.js";
import { showWalletInfo } from "../wallet/index.js";
import { loadSession, saveSession, type VaultSession } from "./store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexterai-cwallet-test-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const VAULT_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
// The wallet-PDA the HOSTED x402_wallet returns as the deposit target — a
// DIFFERENT address from the dexter.vault (Swig state) claim above. Displaying
// the state address as a deposit target would strand funds; we only ever show
// this hosted-returned address.
const DEPOSIT_PDA = "DEpoS1tWa11etPDAzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

function seedSession(overrides: Partial<VaultSession> = {}): VaultSession {
  const s: VaultSession = {
    version: 1,
    accessToken: "at.original.sig",
    refreshToken: "dlt_refresh_original",
    vaultAddress: VAULT_ADDRESS,
    vaultPda: "passkey-handle-sub",
    expiresAt: Date.now() + 3600_000,
    deviceLabel: "opendexter-cli",
    ...overrides,
  };
  saveSession(s, dir);
  return s;
}

/** The structuredContent the hosted x402_wallet tool returns for a funded vault. */
function hostedResult(): HostedWalletResult {
  return {
    address: DEPOSIT_PDA,
    solanaAddress: DEPOSIT_PDA,
    evmAddress: null,
    network: "multichain",
    chainBalances: {
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
        available: "12340000",
        name: "Solana",
        tier: "first",
      },
    },
    balances: {
      usdc: 12.34,
      fundedAtomic: "12340000",
      spentAtomic: "0",
      availableAtomic: "12340000",
      degraded: false,
    },
    supportedNetworks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  };
}

function authError(): Error & { code: number } {
  return Object.assign(new Error("Error POSTing to endpoint: 401 Unauthorized"), {
    code: 401,
  });
}

function tokenFetch(status: number, body: unknown) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/connector/oauth/token")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

describe("connect/wallet — showConnectedWallet", () => {
  it("prints the hosted deposit address, USDC balance, and lane: connected", async () => {
    const session = seedSession();
    const log: string[] = [];
    const callHostedWallet = vi.fn(async () => hostedResult());

    await showConnectedWallet({
      session,
      dataDir: dir,
      log: (l) => log.push(l),
      callHostedWallet,
    });

    const out = log.join("\n");
    expect(callHostedWallet).toHaveBeenCalledTimes(1);
    expect(callHostedWallet).toHaveBeenCalledWith("at.original.sig");
    // Deposit target is the hosted wallet-PDA — NEVER the dexter.vault state addr.
    expect(out).toContain(DEPOSIT_PDA);
    expect(out).not.toContain(VAULT_ADDRESS);
    expect(out).toContain("$12.34");
    expect(out).toContain("lane: connected");
  });

  it("refreshes the bearer on a 401 and retries once with the new token", async () => {
    const session = seedSession();
    const log: string[] = [];
    let calls = 0;
    const callHostedWallet = vi.fn(async (_token: string) => {
      calls += 1;
      if (calls === 1) throw authError();
      return hostedResult();
    });
    const fetchImpl = tokenFetch(200, {
      token_type: "bearer",
      access_token: "at.refreshed.sig",
      refresh_token: "dlt_refresh_rotated",
      expires_in: 3600,
    });

    await showConnectedWallet({
      session,
      dataDir: dir,
      log: (l) => log.push(l),
      callHostedWallet,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // One refresh POST, and the wallet tool called twice (fail, then retry).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(callHostedWallet).toHaveBeenCalledTimes(2);
    // The retry used the freshly minted access token.
    expect(callHostedWallet.mock.calls[1][0]).toBe("at.refreshed.sig");
    // The rotated token pair was persisted.
    const saved = loadSession(dir) as VaultSession;
    expect(saved.accessToken).toBe("at.refreshed.sig");
    expect(saved.refreshToken).toBe("dlt_refresh_rotated");
    // And the balance still rendered.
    expect(log.join("\n")).toContain("$12.34");
  });

  it("prints the reconnect message when refresh fails", async () => {
    const session = seedSession();
    const log: string[] = [];
    const callHostedWallet = vi.fn(async () => {
      throw authError();
    });
    const fetchImpl = tokenFetch(400, { error: "invalid_grant" });

    await showConnectedWallet({
      session,
      dataDir: dir,
      log: (l) => log.push(l),
      callHostedWallet,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // No retry once refresh is refused.
    expect(callHostedWallet).toHaveBeenCalledTimes(1);
    const out = log.join("\n").toLowerCase();
    expect(out).toContain("session expired");
    expect(out).toContain("opendexter connect");
  });
});

describe("connect/wallet — refreshVaultToken", () => {
  it("POSTs grant_type=refresh_token and returns the new token pair", async () => {
    const fetchImpl = tokenFetch(200, {
      access_token: "at.new.sig",
      refresh_token: "dlt_new",
      expires_in: 1800,
    });
    const out = await refreshVaultToken({
      refreshToken: "dlt_old",
      apiBase: "https://x402.dexter.cash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({
      accessToken: "at.new.sig",
      refreshToken: "dlt_new",
      expiresIn: 1800,
    });
    // The request carried the grant type + stored refresh token.
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("dlt_old");
  });

  it("returns null when the refresh is refused", async () => {
    const fetchImpl = tokenFetch(400, { error: "invalid_grant" });
    const out = await refreshVaultToken({
      refreshToken: "dlt_old",
      apiBase: "https://x402.dexter.cash",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });
});

describe("wallet/index — showWalletInfo routing", () => {
  it("routes to connected mode when a session exists", async () => {
    seedSession();
    const log: string[] = [];
    const callHostedWallet = vi.fn(async () => hostedResult());

    await showWalletInfo({
      dev: false,
      dataDir: dir,
      log: (l) => log.push(l),
      callHostedWallet,
    });

    expect(callHostedWallet).toHaveBeenCalledTimes(1);
    expect(log.join("\n")).toContain("lane: connected");
    expect(log.join("\n")).toContain(DEPOSIT_PDA);
  });

  it("shows the quickstart wallet plus a connect hint when there is no session", async () => {
    const log: string[] = [];
    const hint: string[] = [];
    // Stub the quickstart renderer so the test never touches the real home
    // wallet file or live RPCs — we only assert routing + the added hint.
    const renderQuickstart = vi.fn(async (out: (l: string) => void) => {
      out("[[quickstart-wallet-json]]");
    });

    await showWalletInfo({
      dev: false,
      dataDir: dir,
      log: (l) => log.push(l),
      hint: (l) => hint.push(l),
      renderQuickstart,
    });

    expect(renderQuickstart).toHaveBeenCalledTimes(1);
    expect(log.join("\n")).toContain("[[quickstart-wallet-json]]");
    const copy = hint.join("\n");
    expect(copy).toContain("opendexter connect");
    expect(copy).toMatch(/view/i);
    expect(copy).toContain("does not change the payment signer");
    expect(copy).toMatch(/local paid calls still use the local wallet/i);
    expect(copy).not.toMatch(/pay from (?:your )?(?:vault|Dexter wallet)/i);
  });
});
