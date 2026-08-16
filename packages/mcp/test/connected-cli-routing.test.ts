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
import { cliFetch, cliStatus } from "../src/tools/fetch.js";
import { callHostedRuntimeTool } from "../src/connect/wallet.js";
import { loadOrCreateWallet } from "../src/wallet/index.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(callHostedRuntimeTool).mockReset();
  vi.mocked(callHostedRuntimeTool).mockImplementation(async ({
    toolName,
    arguments: args,
    onDispatch,
  }) => {
    onDispatch?.();
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, toolName, args }) }],
      structuredContent: { ok: true, toolName, args },
    };
  });
  vi.mocked(loadOrCreateWallet).mockClear();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
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
    expect(callHostedRuntimeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "x402_fetch",
      arguments: {
        intentId: "intent_exact",
        maxAmountAtomic: "250000",
      },
      dev: false,
      retryRejectedBearer: false,
      onDispatch: expect.any(Function),
    }));
    expect(loadOrCreateWallet).not.toHaveBeenCalled();
  });

  it("routes wallet-proof access as a fresh hosted legacy one-call operation", async () => {
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

  it("forwards one exact intent to the read-only hosted status tool", async () => {
    await cliStatus({ dev: false, intentId: "intent_exact" });
    expect(callHostedRuntimeTool).toHaveBeenCalledTimes(1);
    expect(callHostedRuntimeTool).toHaveBeenCalledWith({
      toolName: "x402_status",
      arguments: { intentId: "intent_exact" },
      dev: false,
    });
    expect(loadOrCreateWallet).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([undefined, "x".repeat(257)])(
    "rejects an invalid status intent before hosted dispatch",
    async (intentId) => {
      await cliStatus({ dev: false, intentId });
      expect(callHostedRuntimeTool).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    },
  );

  it("prints the exact same intent and a pinned no-retry command after an ambiguous fetch", async () => {
    const intentId = "intent 'quoted' $HOME `cmd` ; stop";
    vi.mocked(callHostedRuntimeTool).mockImplementationOnce(async ({ onDispatch }) => {
      onDispatch?.();
      throw new Error("transport closed after dispatch");
    });

    await cliFetch({
      dev: false,
      intentId,
      maxAmountAtomic: "250000",
    });

    expect(callHostedRuntimeTool).toHaveBeenCalledTimes(1);
    expect(callHostedRuntimeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "x402_fetch",
      arguments: { intentId, maxAmountAtomic: "250000" },
      dev: false,
      retryRejectedBearer: false,
      onDispatch: expect.any(Function),
    }));
    const output = JSON.parse(
      String(vi.mocked(console.log).mock.calls.at(-1)?.[0]),
    ) as {
      noRetry: boolean;
      intentId: string;
      recovery: { tool: string; argv: string[]; command: string };
    };
    expect(output).toMatchObject({
      noRetry: true,
      intentId,
      recovery: { tool: "x402_status" },
    });
    expect(output.recovery.argv).toEqual([
      "npx",
      "-y",
      "@dexterai/opendexter@1.24.0-rc.0",
      "status",
      "--intent-id",
      intentId,
    ]);
    expect(output.recovery.command).toContain(
      "npx -y @dexterai/opendexter@1.24.0-rc.0 status --intent-id",
    );
    expect(output.recovery.command).toBe(
      "npx -y @dexterai/opendexter@1.24.0-rc.0 status --intent-id "
        + "'intent '\"'\"'quoted'\"'\"' $HOME `cmd` ; stop'",
    );
    expect(process.exitCode).toBe(1);
  });

  it("treats an error result as ambiguous without automatic status or retry", async () => {
    vi.mocked(callHostedRuntimeTool).mockImplementationOnce(async ({ onDispatch }) => {
      onDispatch?.();
      return {
        isError: true,
        content: [{ type: "text" as const, text: '{"error":"unknown_after_dispatch"}' }],
        structuredContent: { error: "unknown_after_dispatch" },
      };
    });
    await cliFetch({
      dev: false,
      intentId: "intent_error",
      maxAmountAtomic: "1",
    });
    expect(callHostedRuntimeTool).toHaveBeenCalledTimes(1);
    expect(callHostedRuntimeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "x402_fetch",
      arguments: { intentId: "intent_error", maxAmountAtomic: "1" },
    }));
    const output = JSON.parse(
      String(vi.mocked(console.log).mock.calls.at(-1)?.[0]),
    );
    expect(output).toMatchObject({
      noRetry: true,
      intentId: "intent_error",
      recovery: { tool: "x402_status" },
    });
    expect(process.exitCode).toBe(1);
  });

  it("does not claim ambiguity when the wrapper fails before hosted dispatch", async () => {
    vi.mocked(callHostedRuntimeTool).mockRejectedValueOnce(
      new Error("Invalid URL"),
    );
    await cliFetch({
      dev: false,
      intentId: "intent_not_dispatched",
      maxAmountAtomic: "1",
    });
    const output = JSON.parse(
      String(vi.mocked(console.log).mock.calls.at(-1)?.[0]),
    );
    expect(output).toEqual({ error: "Invalid URL" });
    expect(callHostedRuntimeTool).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
