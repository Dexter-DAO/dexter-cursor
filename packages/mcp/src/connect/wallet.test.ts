import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  callHostedTool,
  callHostedRuntimeTool,
  projectRuntimeAuthorityStatus,
  readGovernedAuthorityStatus,
  refreshVaultToken,
  showConnectedWallet,
  type HostedWalletResult,
} from "./wallet.js";
import {
  readLegacyWalletPublicInfo,
  showWalletInfo,
} from "../wallet/index.js";
import { loadSession, saveSession, type VaultSession } from "./store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexterai-cwallet-test-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
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
  it("prints the hosted deposit address, USDC balance, and explicit read-only link", async () => {
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
    expect(out).toContain("x402 path: hosted governed runtime");
    expect(out).toContain("status: unavailable");
    expect(out).toContain("Automatic fallback: never");
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

describe("connect/wallet — governed runtime authority", () => {
  const NOW = Date.parse("2026-08-05T00:00:30.000Z");
  const exactEvidence = {
    namespace: "dexter-governed-agent-surface-authority/v1",
    mode: "bounded_payment_authority",
    active: true,
    inactiveReason: null,
    logicalGrantActive: true,
    principal: {
      actor: "agent",
      vaultPda: "vault-pda",
      walletAddress: DEPOSIT_PDA,
      agentId: "agent-1",
    },
    source: "mcp-link-token",
    grantId: "grant-1",
    grantRevision: 3,
    expiresAt: "2026-08-06T00:00:00.000Z",
    scopes: {
      network: "solana-mainnet",
      assetId: "usdc",
      action: "send",
      protocolId: "x402-exact-v2",
      counterpartyScope: "any-valid-x402-seller",
    },
    capacity: {
      maximumPerCallAmountAtomic: "1000000",
      remainingPerCallAmountAtomic: "750000",
      maximumDailyAmountAtomic: "5000000",
      usedDailyAmountAtomic: "1250000",
      remainingDailyAmountAtomic: "3750000",
      maximumAggregateAmountAtomic: "10000000",
      usedAggregateAmountAtomic: "2250000",
      remainingAggregateAmountAtomic: "7750000",
      evaluatedAt: new Date(NOW).toISOString(),
      snapshotDigest: "a".repeat(64),
    },
    revoked: false,
    activeRole: {
      status: "active",
      roleId: 7,
      authoritySigner: "authority",
      sessionExpirySlot: 99,
      currentSlot: 50,
      resolutionDigest: "b".repeat(64),
    },
    fallback: false,
  };

  it("projects the exact v1 evidence tuple without inferring from balances", () => {
    const status = projectRuntimeAuthorityStatus({
      balances: { usdc: 12.34 },
      authority: exactEvidence,
    }, () => NOW);
    expect(status).toMatchObject({
      status: "active",
      active: true,
      authoritySource: "mcp-link-token",
      grantId: "grant-1",
      grantRevision: 3,
      logicalGrantActive: true,
      principal: { agentId: "agent-1" },
      limits: {
        maximumPerCallAmountAtomic: "1000000",
        maximumDailyAmountAtomic: "5000000",
        maximumAggregateAmountAtomic: "10000000",
      },
      remaining: {
        perCallAmountAtomic: "750000",
        dailyAmountAtomic: "3750000",
        aggregateAmountAtomic: "7750000",
      },
      expiresAt: "2026-08-06T00:00:00.000Z",
      scopes: { protocolId: "x402-exact-v2" },
      activeRole: { status: "active", roleId: 7 },
      revocation: { revoked: false },
      fallback: { active: false, automatic: false },
    });
    expect(projectRuntimeAuthorityStatus({ balances: { usdc: 12.34 } }, () => NOW))
      .toMatchObject({ status: "unavailable", active: null, grantId: null });
    expect(projectRuntimeAuthorityStatus({
      authority: {
        namespace: "dexter-governed-agent-surface-authority/v1",
        mode: "bounded_payment_authority",
        active: true,
      },
    }, () => NOW)).toMatchObject({
      status: "unavailable",
      active: null,
      reason: "governed_authority_evidence_incomplete",
    });
    expect(projectRuntimeAuthorityStatus({
      authority: {
        ...exactEvidence,
        capacity: {
          ...exactEvidence.capacity,
          remainingDailyAmountAtomic: "4000000",
        },
      },
    }, () => NOW)).toMatchObject({
      status: "unavailable",
      active: null,
      reason: "governed_authority_evidence_incomplete",
    });
  });

  it.each([
    ["capacity 60,001ms old", {
      capacity: {
        ...exactEvidence.capacity,
        evaluatedAt: new Date(NOW - 60_001).toISOString(),
      },
    }, "governed_authority_capacity_stale"],
    ["capacity 5,001ms in the future", {
      capacity: {
        ...exactEvidence.capacity,
        evaluatedAt: new Date(NOW + 5_001).toISOString(),
      },
    }, "governed_authority_capacity_stale"],
    ["malformed expiry", { expiresAt: "not-a-time" }, "governed_authority_evidence_incomplete"],
    ["malformed capacity time", {
      capacity: { ...exactEvidence.capacity, evaluatedAt: "not-a-time" },
    }, "governed_authority_evidence_incomplete"],
  ] as const)("fails closed for %s", (_label, override, reason) => {
    expect(projectRuntimeAuthorityStatus({
      authority: { ...exactEvidence, ...override },
    }, () => NOW)).toMatchObject({
      status: "unavailable",
      active: null,
      reason,
    });
  });

  it.each([
    ["expiry equal to now", NOW],
    ["expired evidence", NOW - 1],
  ])("projects %s as deterministically inactive", (_label, expiresAt) => {
    expect(projectRuntimeAuthorityStatus({
      authority: {
        ...exactEvidence,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    }, () => NOW)).toMatchObject({
      status: "inactive",
      active: false,
      reason: "governed_authority_expired",
    });
  });

  it.each([
    ["capacity exactly 60,000ms old", NOW - 60_000],
    ["capacity exactly 5,000ms in the future", NOW + 5_000],
  ])("accepts %s", (_label, evaluatedAt) => {
    expect(projectRuntimeAuthorityStatus({
      authority: {
        ...exactEvidence,
        capacity: {
          ...exactEvidence.capacity,
          evaluatedAt: new Date(evaluatedAt).toISOString(),
        },
      },
    }, () => NOW)).toMatchObject({ status: "active", active: true });
  });

  it("reads exact status with only the stored bearer and no caller identity", async () => {
    seedSession();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(exactEvidence), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const status = await readGovernedAuthorityStatus({
      dataDir: dir,
      apiBase: "https://api.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(status.status).toBe("active");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestedUrl, requestInit] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(requestedUrl).toBe(
      "https://api.example/api/connector/oauth/authority",
    );
    expect(requestInit).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer at.original.sig" },
    });
  });

  it("never auth-retries x402_fetch after a possibly dispatched call", async () => {
    seedSession();
    const callHosted = vi.fn(async () => {
      throw authError();
    });
    await expect(callHostedRuntimeTool({
      toolName: "x402_fetch",
      arguments: { intentId: "intent-1", maxAmountAtomic: "1" },
      dataDir: dir,
      retryRejectedBearer: false,
      callHosted,
    })).rejects.toThrow(/no_automatic_retry/);
    expect(callHosted).toHaveBeenCalledTimes(1);
  });

  it("cannot enable auth retry for a non-GET check after possible dispatch", async () => {
    seedSession();
    const callHosted = vi.fn(async () => {
      throw authError();
    });
    await expect(callHostedRuntimeTool({
      toolName: "x402_check",
      arguments: {
        url: "https://seller.example/check",
        method: "POST",
        body: '{"action":"reserve"}',
      },
      dataDir: dir,
      retryRejectedBearer: true,
      callHosted,
    })).rejects.toThrow(/no_automatic_retry/);
    expect(callHosted).toHaveBeenCalledTimes(1);
  });

  it("rejects disconnected fetch before dispatch even when a legacy signer env name exists", async () => {
    vi.stubEnv("DEXTER_PRIVATE_KEY", "legacy-material-must-not-be-read");
    const callHosted = vi.fn();
    await expect(callHostedRuntimeTool({
      toolName: "x402_fetch",
      arguments: { intentId: "intent-1", maxAmountAtomic: "1" },
      dataDir: dir,
      callHosted,
    })).rejects.toThrow("connect_required_for_hosted_x402_fetch");
    expect(callHosted).not.toHaveBeenCalled();
  });

  it("keeps every account-bound hosted tool behind the connected bearer", async () => {
    const callHosted = vi.fn();
    for (const toolName of [
      "x402_status",
      "x402_wallet",
      "dexter_portfolio",
    ] as const) {
      await expect(callHostedRuntimeTool({
        toolName,
        dataDir: dir,
        callHosted,
      })).rejects.toThrow(`connect_required_for_hosted_${toolName}`);
    }
    expect(callHosted).not.toHaveBeenCalled();
  });

  it.each(["x402_search", "x402_access"] as const)(
    "always dispatches %s once anonymously without refreshing OAuth",
    async (toolName) => {
      seedSession({ expiresAt: 0 });
      const fetchImpl = vi.fn();
      const callHosted = vi.fn(async () => ({
        content: [{ type: "text" as const, text: '{"ok":true}' }],
      }));
      await callHostedRuntimeTool({
        toolName,
        arguments: { url: "https://seller.example/read", method: "GET" },
        dataDir: dir,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        callHosted,
      });
      expect(callHosted).toHaveBeenCalledTimes(1);
      expect(callHosted).toHaveBeenCalledWith(
        null,
        toolName,
        { url: "https://seller.example/read", method: "GET" },
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("strips every legacy access credential field and value from the returned result", async () => {
    const sessionToken = "open_access_token_secret";
    const sessionKey = "open_access_key_secret";
    const callHosted = vi.fn(async () => ({
      _meta: {
        sessionToken,
        session_key: sessionKey,
        preserved: "meta-safe",
      },
      structuredContent: {
        ok: true,
        nested: {
          sessionToken,
          preserved: "structured-safe",
        },
      },
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            sessionKey,
            preserved: "json-safe",
          }),
        },
        {
          type: "text" as const,
          text: `sessionToken=${sessionToken}; session_key=${sessionKey}; visible`,
        },
      ],
    }));

    const result = await callHostedRuntimeTool({
      toolName: "x402_access",
      arguments: { url: "https://seller.example/private", method: "GET" },
      dataDir: dir,
      callHosted,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sessionToken);
    expect(serialized).not.toContain(sessionKey);
    expect(serialized).not.toMatch(/session[_-]?(?:token|key)/i);
    expect(result).toMatchObject({
      _meta: { preserved: "meta-safe" },
      structuredContent: {
        ok: true,
        nested: { preserved: "structured-safe" },
      },
    });
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("json-safe") }),
      expect.objectContaining({ text: expect.stringContaining("visible") }),
    ]));
  });

  it("does not mark dispatch when the production hosted wrapper rejects its URL", async () => {
    const onDispatch = vi.fn();
    await expect(callHostedTool({
      accessToken: "at.test.sig",
      toolName: "x402_fetch",
      arguments: { intentId: "intent-not-dispatched", maxAmountAtomic: "1" },
      serverUrl: "not a URL",
      onDispatch,
    })).rejects.toThrow();
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("degrades an expired unrefreshable check to one anonymous dispatch", async () => {
    seedSession({ expiresAt: NOW - 1 });
    const callHosted = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    }));
    await callHostedRuntimeTool({
      toolName: "x402_check",
      arguments: { url: "https://seller.example/price", method: "GET" },
      dataDir: dir,
      apiBase: "https://api.example",
      now: () => NOW,
      fetchImpl: tokenFetch(400, { error: "invalid_grant" }) as unknown as typeof fetch,
      callHosted,
    });
    expect(callHosted).toHaveBeenCalledTimes(1);
    expect(callHosted).toHaveBeenCalledWith(
      null,
      "x402_check",
      { url: "https://seller.example/price", method: "GET" },
    );
    expect(loadSession(dir)).toBeNull();
  });

  it("uses a refreshed bearer for an expired check when refresh succeeds", async () => {
    seedSession({ expiresAt: NOW - 1 });
    const callHosted = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    }));
    await callHostedRuntimeTool({
      toolName: "x402_check",
      arguments: { url: "https://seller.example/price", method: "GET" },
      dataDir: dir,
      apiBase: "https://api.example",
      now: () => NOW,
      fetchImpl: tokenFetch(200, {
        access_token: "at.refreshed.sig",
        refresh_token: "dlt_refreshed",
        expires_in: 3600,
      }) as unknown as typeof fetch,
      callHosted,
    });
    expect(callHosted).toHaveBeenCalledOnce();
    expect(callHosted).toHaveBeenCalledWith(
      "at.refreshed.sig",
      "x402_check",
      { url: "https://seller.example/price", method: "GET" },
    );
  });

  it("falls back once anonymously when a GET check bearer is rejected and cannot refresh", async () => {
    seedSession({ expiresAt: NOW + 3600_000 });
    const callHosted = vi.fn(async (accessToken: string | null) => {
      if (accessToken) throw authError();
      return { content: [{ type: "text" as const, text: '{"ok":true}' }] };
    });
    await callHostedRuntimeTool({
      toolName: "x402_check",
      arguments: { url: "https://seller.example/price", method: "GET" },
      dataDir: dir,
      apiBase: "https://api.example",
      now: () => NOW,
      fetchImpl: tokenFetch(400, { error: "invalid_grant" }) as unknown as typeof fetch,
      callHosted,
    });
    expect(callHosted).toHaveBeenCalledTimes(2);
    expect(callHosted.mock.calls).toEqual([
      ["at.original.sig", "x402_check", {
        url: "https://seller.example/price",
        method: "GET",
      }],
      [null, "x402_check", {
        url: "https://seller.example/price",
        method: "GET",
      }],
    ]);
  });

  it("never redispatches a failed anonymous legacy access call", async () => {
    seedSession();
    const callHosted = vi.fn(async () => {
      throw new Error("legacy access outcome unknown");
    });
    await expect(callHostedRuntimeTool({
      toolName: "x402_access",
      arguments: {
        url: "https://seller.example/private",
        method: "POST",
        body: '{"action":"issue"}',
      },
      dataDir: dir,
      callHosted,
    })).rejects.toThrow("legacy access outcome unknown");
    expect(callHosted).toHaveBeenCalledTimes(1);
    expect(callHosted).toHaveBeenCalledWith(null, "x402_access", {
      url: "https://seller.example/private",
      method: "POST",
      body: '{"action":"issue"}',
    });
  });

  it("degrades an invalid stored session for check but keeps account tools fail-closed", async () => {
    writeFileSync(join(dir, "vault.json"), JSON.stringify({
      version: 1,
      accessToken: "",
      refreshToken: "",
      expiresAt: "invalid",
    }));
    const callHosted = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    }));
    await callHostedRuntimeTool({
      toolName: "x402_check",
      arguments: { url: "https://seller.example/price" },
      dataDir: dir,
      callHosted,
    });
    expect(callHosted).toHaveBeenCalledOnce();
    expect(callHosted).toHaveBeenLastCalledWith(
      null,
      "x402_check",
      { url: "https://seller.example/price" },
    );

    writeFileSync(join(dir, "vault.json"), JSON.stringify({
      version: 1,
      accessToken: "",
      refreshToken: "",
      expiresAt: "invalid",
    }));
    callHosted.mockClear();
    await expect(callHostedRuntimeTool({
      toolName: "x402_wallet",
      dataDir: dir,
      callHosted,
    })).rejects.toThrow("connect_required_for_hosted_x402_wallet");
    expect(callHosted).not.toHaveBeenCalled();
  });

  it.each(["x402_fetch", "x402_status", "x402_wallet", "dexter_portfolio"] as const)(
    "fails an expired unrefreshable %s before dispatch",
    async (toolName) => {
      seedSession({ expiresAt: NOW - 1 });
      const callHosted = vi.fn();
      await expect(callHostedRuntimeTool({
        toolName,
        dataDir: dir,
        apiBase: "https://api.example",
        now: () => NOW,
        fetchImpl: tokenFetch(400, { error: "invalid_grant" }) as unknown as typeof fetch,
        callHosted,
      })).rejects.toThrow("connected_session_expired_reconnect_required");
      expect(callHosted).not.toHaveBeenCalled();
    },
  );

  it("sends the stored OAuth bearer with the exact status-recovery intent", async () => {
    seedSession();
    const callHosted = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    }));
    await callHostedRuntimeTool({
      toolName: "x402_status",
      arguments: { intentId: "intent-1" },
      dataDir: dir,
      callHosted,
    });
    expect(callHosted).toHaveBeenCalledWith(
      "at.original.sig",
      "x402_status",
      { intentId: "intent-1" },
    );
  });

  it("allows anonymous hosted checks without inspecting local signer material", async () => {
    vi.stubEnv("DEXTER_PRIVATE_KEY", "legacy-material-must-not-be-read");
    const callHosted = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    }));
    await callHostedRuntimeTool({
      toolName: "x402_check",
      arguments: { url: "https://seller.example/price" },
      dataDir: dir,
      callHosted,
    });
    expect(callHosted).toHaveBeenCalledWith(
      null,
      "x402_check",
      { url: "https://seller.example/price" },
    );
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
    expect(log.join("\n")).toContain("x402 path: hosted governed runtime");
    expect(log.join("\n")).toContain(DEPOSIT_PDA);
  });

  it("does not read or create a local wallet when disconnected by default", async () => {
    const log: string[] = [];
    const hint: string[] = [];
    const renderLegacyRecovery = vi.fn(async (out: (l: string) => void) => {
      out("[[legacy-recovery-json]]");
    });

    await showWalletInfo({
      dev: false,
      dataDir: dir,
      log: (l) => log.push(l),
      hint: (l) => hint.push(l),
      renderLegacyRecovery,
    });

    expect(renderLegacyRecovery).not.toHaveBeenCalled();
    expect(log.join("\n")).toContain('"status": "disconnected"');
    expect(log.join("\n")).toContain('"available": false');
    const copy = hint.join("\n");
    expect(copy).toContain("opendexter connect");
    expect(copy).toContain("--legacy-recovery");
    expect(copy).toContain("not payment executors");
    expect(copy).not.toContain("OPENDEXTER_LOCAL_SIGNER_FALLBACK");
  });

  it("offers only an explicit read-only legacy recovery view", async () => {
    const walletFile = join(dir, "wallet.json");
    writeFileSync(walletFile, JSON.stringify({
      solanaAddress: "11111111111111111111111111111111",
      evmAddress: "0x1111111111111111111111111111111111111111",
      solanaPrivateKey: "must-not-leave-file",
      evmPrivateKey: "0xmust-not-leave-file",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    expect(readLegacyWalletPublicInfo(walletFile)).toEqual({
      solanaAddress: "11111111111111111111111111111111",
      evmAddress: "0x1111111111111111111111111111111111111111",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const log: string[] = [];
    const hint: string[] = [];
    const readLegacyBalances = vi.fn(async (wallet) => {
      expect(wallet).toEqual({
        solanaAddress: "11111111111111111111111111111111",
        evmAddress: "0x1111111111111111111111111111111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      return {
        totalUsdc: 1.25,
        chains: {
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
            name: "Solana",
            usdc: 1.25,
          },
        },
        degraded: false,
        unavailableChains: [],
      };
    });
    await showWalletInfo({
      dev: false,
      legacyRecovery: true,
      legacyWalletFile: walletFile,
      dataDir: dir,
      log: (line) => log.push(line),
      hint: (line) => hint.push(line),
      readLegacyBalances,
    });
    expect(readLegacyBalances).toHaveBeenCalledTimes(1);
    expect(log.join("\n")).toContain('"paymentEnabled": false');
    expect(log.join("\n")).toContain('"privateKeysExported": false');
    expect(log.join("\n")).toContain('"usdc": 1.25');
    expect(log.join("\n")).not.toContain("must-not-leave-file");
    expect(hint.join("\n")).toContain("read-only");
    expect(hint.join("\n")).toContain("cannot execute payments");

    writeFileSync(walletFile, JSON.stringify({
      solanaAddress: "must-not-be-echoed-as-an-address",
      solanaPrivateKey: "must-not-leave-file",
    }));
    expect(readLegacyWalletPublicInfo(walletFile)).toBeNull();
  });
});
