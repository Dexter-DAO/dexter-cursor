import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cliConnect, cliConnectStatus, cliConnectDisconnect } from "./connect.js";
import { loadSession, saveSession, type VaultSession } from "./store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dexterai-connect-test-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const VAULT_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
// sub = base64url of a 16-byte passkey handle (the identity root the token carries).
const SUB = Buffer.from("passkey-handle16").toString("base64url");

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** A CLI-own access token: header.payload.sig, payload carries the dexter claim. */
function makeAccessJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: "dx-2026-07-a", typ: "JWT" };
  const payload = {
    iss: "https://dexter.cash",
    sub: SUB,
    aud: "https://open.dexter.cash/mcp",
    iat: now,
    exp: now + 3600,
    dexter: { ver: 1, vault: VAULT_ADDRESS, userHandle: SUB, agentGrant: null },
  };
  return `${b64url(header)}.${b64url(payload)}.c2ln`;
}

const DEVICE_AUTH_BODY = {
  device_code: "dvc_deadbeef",
  user_code: "K7Q2-9F3M",
  verification_uri: "https://dexter.cash/wallet/connect",
  verification_uri_complete: "https://dexter.cash/wallet/connect?code=K7Q2-9F3M",
  expires_in: 600,
  interval: 5,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Mock the two endpoints: device_authorization returns a code; /token returns
 * the supplied token-response sequence (one entry consumed per poll).
 */
function makeFetch(tokenSeq: Array<() => Response>) {
  let tokenCall = 0;
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/connector/oauth/device_authorization")) {
      return jsonResponse(200, DEVICE_AUTH_BODY);
    }
    if (url.endsWith("/api/connector/oauth/token")) {
      const make = tokenSeq[Math.min(tokenCall, tokenSeq.length - 1)];
      tokenCall += 1;
      return make();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

const pending = () => jsonResponse(400, { error: "authorization_pending" });
const slowDown = () => jsonResponse(400, { error: "slow_down" });
const success = () =>
  jsonResponse(200, {
    token_type: "bearer",
    access_token: makeAccessJwt(),
    expires_in: 3600,
    refresh_token: "dlt_abc123",
    scope: "vault",
  });

describe("connect/connect — cliConnect device flow", () => {
  it("polls through authorization_pending then persists the decoded session", async () => {
    const log: string[] = [];
    const fetchImpl = makeFetch([pending, pending, success]);
    const openBrowser = vi.fn(() => false);

    await cliConnect({
      dataDir: dir,
      log: (l) => log.push(l),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openBrowser,
      renderQrImpl: () => "[qr]",
      sleep: () => Promise.resolve(),
    });

    // 1 device_authorization + 3 /token polls.
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const session = loadSession(dir) as VaultSession;
    expect(session).not.toBeNull();
    expect(session.version).toBe(1);
    expect(session.vaultAddress).toBe(VAULT_ADDRESS);
    expect(session.vaultPda).toBe(SUB);
    expect(session.accessToken).toContain(".");
    expect(session.refreshToken).toBe("dlt_abc123");
    expect(session.deviceLabel).toBe("opendexter-cli");
    expect(session.expiresAt).toBeGreaterThan(Date.now());

    // The three approval paths all surface: link, QR, and the typed code.
    const out = log.join("\n");
    expect(out).toContain(DEVICE_AUTH_BODY.verification_uri_complete);
    expect(out).toContain("[qr]");
    expect(out).toContain(DEVICE_AUTH_BODY.user_code);
    expect(out).toContain(VAULT_ADDRESS);
    expect(out).toContain("Connected your Dexter Wallet to the hosted governed x402 runtime");
    expect(out).toContain("No bounded payment authority is claimed");
    expect(out).toContain("not payment executors");
    expect(out).not.toContain("OPENDEXTER_LOCAL_SIGNER_FALLBACK");
    const deviceRequest = JSON.parse(
      ((fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1]).body as string,
    );
    expect(deviceRequest.scope).toBe("vault");
  });

  it("offers to open the browser unless noBrowser is set", async () => {
    const openBrowser = vi.fn(() => true);
    await cliConnect({
      dataDir: dir,
      log: () => {},
      fetchImpl: makeFetch([success]) as unknown as typeof fetch,
      openBrowser,
      renderQrImpl: () => "[qr]",
      sleep: () => Promise.resolve(),
    });
    expect(openBrowser).toHaveBeenCalledWith(DEVICE_AUTH_BODY.verification_uri_complete);
  });

  it("never opens a browser when noBrowser is set (headless-safe)", async () => {
    const openBrowser = vi.fn(() => true);
    await cliConnect({
      dataDir: dir,
      noBrowser: true,
      log: () => {},
      fetchImpl: makeFetch([success]) as unknown as typeof fetch,
      openBrowser,
      renderQrImpl: () => "[qr]",
      sleep: () => Promise.resolve(),
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("handles slow_down by widening the interval and still succeeds", async () => {
    const sleeps: number[] = [];
    await cliConnect({
      dataDir: dir,
      log: () => {},
      fetchImpl: makeFetch([slowDown, success]) as unknown as typeof fetch,
      openBrowser: () => false,
      renderQrImpl: () => "[qr]",
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    // First (and only) sleep after slow_down must exceed the 5s base interval.
    expect(sleeps[0]).toBeGreaterThan(5000);
    expect(loadSession(dir)?.vaultAddress).toBe(VAULT_ADDRESS);
  });

  it("stops cleanly on expired_token without persisting a session", async () => {
    const log: string[] = [];
    await cliConnect({
      dataDir: dir,
      log: (l) => log.push(l),
      fetchImpl: makeFetch([() => jsonResponse(400, { error: "expired_token" })]) as unknown as typeof fetch,
      openBrowser: () => false,
      renderQrImpl: () => "[qr]",
      sleep: () => Promise.resolve(),
    });
    expect(loadSession(dir)).toBeNull();
    expect(log.join("\n").toLowerCase()).toContain("expired");
  });
});

describe("connect/connect — status + disconnect", () => {
  function seed(): VaultSession {
    const s: VaultSession = {
      version: 1,
      accessToken: "at.b.c",
      refreshToken: "dlt_x",
      vaultAddress: VAULT_ADDRESS,
      vaultPda: SUB,
      expiresAt: Date.now() + 3600_000,
      deviceLabel: "opendexter-cli",
    };
    saveSession(s, dir);
    return s;
  }

  it("status reports the vault address when connected", async () => {
    seed();
    const log: string[] = [];
    await cliConnectStatus({
      dataDir: dir,
      log: (l) => log.push(l),
      readAuthorityStatus: async () => ({
        namespace: "opendexter-runtime-authority/v1",
        runtimeSource: "hosted_governed_x402",
        status: "active",
        active: true,
        authoritySource: "mcp-link-token",
        grantId: "grant-1",
        grantRevision: 3,
        logicalGrantActive: true,
        principal: { actor: "agent", agentId: "agent-1" },
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
        scopes: {
          action: "pay",
          protocolId: "x402",
          protocolVersion: 2,
          allowedSchemes: ["exact", "tab"],
        },
        activeRole: { status: "active", roleId: 7 },
        revocation: { revoked: false, manageUrl: "https://dexter.cash/wallet" },
        fallback: {
          available: false,
          enabled: false,
          active: false,
          automatic: false,
        },
        evidenceNamespace: "dexter-governed-agent-surface-authority/v2",
        reason: null,
      }),
    });
    expect(log.join("\n")).toContain(VAULT_ADDRESS);
    expect(log.join("\n")).toContain("Dexter Wallet connected runtime");
    expect(log.join("\n")).toContain("Authority status: active");
    expect(log.join("\n")).toContain("Grant ID: grant-1");
    expect(log.join("\n")).toContain("Remaining:");
    expect(log.join("\n")).toContain("Revocation: not revoked");
  });

  it("status reports Not connected when there is no session", async () => {
    const log: string[] = [];
    await cliConnectStatus({ dataDir: dir, log: (l) => log.push(l) });
    expect(log.join("\n")).toContain("Not connected.");
  });

  it("disconnect clears the session", async () => {
    seed();
    expect(loadSession(dir)).not.toBeNull();
    const log: string[] = [];
    await cliConnectDisconnect({ dataDir: dir, log: (l) => log.push(l) });
    expect(loadSession(dir)).toBeNull();
    expect(log.join("\n")).toContain("Disconnected.");
  });
});
