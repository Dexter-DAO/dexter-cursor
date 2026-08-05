import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/connect/store.js", () => ({
  loadSession: vi.fn(() => ({
    version: 1,
    accessToken: "at.connected.sig",
    refreshToken: "dlt_connected",
    vaultAddress: "vault",
    vaultPda: "handle",
    expiresAt: Date.now() + 60_000,
    deviceLabel: "opendexter-cli",
  })),
}));

vi.mock("../src/connect/wallet.js", () => ({
  callHostedRuntimeTool: vi.fn(async ({ toolName, arguments: args }) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, toolName, args }) }],
    structuredContent: { ok: true, toolName, args },
  })),
  structuredToolResult: vi.fn((result) => result.structuredContent ?? {}),
}));

vi.mock("../src/wallet/index.js", () => ({
  loadOrCreateWallet: vi.fn(() => {
    throw new Error("connected path must not read or create wallet.json");
  }),
}));

import { cliAccess } from "../src/tools/access.js";
import { cliCheck } from "../src/tools/check.js";
import { cliFetch } from "../src/tools/fetch.js";
import { callHostedRuntimeTool } from "../src/connect/wallet.js";
import { loadOrCreateWallet } from "../src/wallet/index.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(callHostedRuntimeTool).mockClear();
  vi.mocked(loadOrCreateWallet).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connected CLI routing", () => {
  it("routes check through the hosted runtime without inspecting local signers", async () => {
    await cliCheck("https://seller.example/price", {
      method: "POST",
      body: '{"symbol":"SOL"}',
      dev: false,
    });
    expect(callHostedRuntimeTool).toHaveBeenCalledWith({
      toolName: "x402_check",
      arguments: {
        url: "https://seller.example/price",
        method: "POST",
        body: '{"symbol":"SOL"}',
      },
      dev: false,
      retryRejectedBearer: false,
    });
    expect(loadOrCreateWallet).not.toHaveBeenCalled();
  });

  it("routes fetch by opaque intent and disables rejected-bearer retry", async () => {
    await cliFetch({
      dev: false,
      intentId: "intent_exact",
      maxAmountAtomic: "250000",
    });
    expect(callHostedRuntimeTool).toHaveBeenCalledWith({
      toolName: "x402_fetch",
      arguments: {
        intentId: "intent_exact",
        maxAmountAtomic: "250000",
      },
      dev: false,
      retryRejectedBearer: false,
    });
    expect(loadOrCreateWallet).not.toHaveBeenCalled();
  });

  it("routes wallet-proof access through the connected hosted principal", async () => {
    await cliAccess("https://seller.example/private", {
      method: "GET",
      network: "solana-mainnet",
      dev: false,
    });
    expect(callHostedRuntimeTool).toHaveBeenCalledWith({
      toolName: "x402_access",
      arguments: {
        url: "https://seller.example/private",
        method: "GET",
        network: "solana-mainnet",
      },
      dev: false,
      retryRejectedBearer: true,
    });
    expect(loadOrCreateWallet).not.toHaveBeenCalled();
  });

  it("does not retry a mutating wallet-proof request after bearer rejection", async () => {
    await cliAccess("https://seller.example/private", {
      method: "POST",
      body: '{"action":"issue"}',
      dev: false,
    });
    expect(callHostedRuntimeTool).toHaveBeenCalledWith({
      toolName: "x402_access",
      arguments: {
        url: "https://seller.example/private",
        method: "POST",
        body: '{"action":"issue"}',
      },
      dev: false,
      retryRejectedBearer: false,
    });
    expect(loadOrCreateWallet).not.toHaveBeenCalled();
  });
});
