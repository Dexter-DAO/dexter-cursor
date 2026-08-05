import { describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  checkEndpointPricing: vi.fn(),
}));

vi.mock("@dexterai/x402-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dexterai/x402-core")>()),
  checkEndpointPricing: coreMocks.checkEndpointPricing,
}));

import type { WalletAdapter } from "../../x402-mcp-tools/src/wallet-adapter.js";
import type {
  GatewayPurchaseAdapterV1,
  GatewayPurchaseModeV1,
} from "../../x402-mcp-tools/src/types.js";
import {
  buildPurchaseOptions,
  sellerAcceptSha256,
  type PreparedPurchaseOptionV1,
  type PurchaseAttemptStoreV1,
} from "../../x402-mcp-tools/src/purchase-contract.js";
import {
  preparePurchaseOptionsForCapabilities,
  registerCheckTool,
} from "../../x402-mcp-tools/src/tools/check.js";

const URL = "https://merchant.example/data";

function paymentOption(
  scheme: "exact" | "tab",
  network = "solana:mainnet",
) {
  const raw = {
    scheme,
    network,
    asset: "USDC_MINT",
    amount: "10000",
    payTo: "SELLER",
    extra: { decimals: 6 },
  };
  return {
    scheme,
    network,
    asset: "USDC_MINT",
    amountAtomic: "10000",
    payTo: "SELLER",
    facilitator: null,
    expiresAt: null,
    rawAcceptSha256: sellerAcceptSha256(raw),
  };
}

function options(
  paymentOptions: Array<Record<string, unknown>> = [
    paymentOption("exact"),
    paymentOption("tab"),
  ],
): PreparedPurchaseOptionV1[] {
  let id = 0;
  return buildPurchaseOptions({
    checkResult: {
      requiresPayment: true,
      x402Version: 2,
      resolvedUrl: URL,
      paymentOptions,
    },
    url: URL,
    method: "GET",
    payload: null,
    surface: "local",
    idFactory: () => `prepared-capability-${++id}`,
  });
}

function wallet(
  signers: { solanaPrivateKey?: string; evmPrivateKey?: string },
): WalletAdapter {
  return {
    getInfo: () => ({}),
    getAvailableUsdc: async () => 0,
    getAllBalances: async () => ({ totalUsdc: 0, chains: {} }),
    getPaymentSigners: () => signers,
    getSolanaSigner: () => null,
    getEvmSigner: () => null,
  };
}

function preparationStore(
  prepare: (purchase: PreparedPurchaseOptionV1["preparedPurchase"]) => void,
) {
  const attempts: PurchaseAttemptStoreV1 = {
    begin: () => ({ acquired: false, state: "unknown", receipt: null }),
    markDispatching: () => {},
    complete: () => {},
  };
  return { ...attempts, prepare };
}

function byMode(result: PreparedPurchaseOptionV1[]) {
  return Object.fromEntries(
    result.map((option) => [option.mode, option]),
  ) as Record<string, PreparedPurchaseOptionV1>;
}

function gatewayAdapter(
  mode: GatewayPurchaseModeV1,
): GatewayPurchaseAdapterV1 {
  return {
    mode,
    readiness: () => ({ state: "ready", reason: null }),
    execute: vi.fn(),
  };
}

describe("x402_check executable capability truth", () => {
  it("persists ready identities in the registered x402_check path", async () => {
    coreMocks.checkEndpointPricing.mockResolvedValue({
      requiresPayment: true,
      x402Version: 2,
      resolvedUrl: URL,
      paymentOptions: [
        paymentOption("exact"),
        paymentOption("tab"),
      ],
    });
    const prepare = vi.fn();
    let handler:
      | ((args: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | null = null;
    const server = {
      registerTool(
        _name: string,
        _definition: unknown,
        registered: (
          args: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>,
      ) {
        handler = registered;
      },
    };
    registerCheckTool(server as never, {
      apiBaseUrl: "https://x402.dexter.cash",
      metas: { check: {} } as never,
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
      getPurchaseAttemptStore: () => preparationStore(prepare),
    });

    const registered = handler as unknown as
      | ((args: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | null;
    expect(registered).not.toBeNull();
    const response = await registered!({ url: URL, method: "GET" });
    const purchaseOptions = (
      response.structuredContent as {
        purchaseOptions: PreparedPurchaseOptionV1[];
      }
    ).purchaseOptions;

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(purchaseOptions
      .filter((option) => option.availability.state === "ready")
      .map((option) => option.mode)).toEqual([
      "direct_exact",
      "native_tab",
    ]);
  });

  it("advertises Direct and Native Tab ready only after persisting both identities", () => {
    const prepare = vi.fn();
    const result = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
      getPurchaseAttemptStore: () => preparationStore(prepare),
    }));

    expect(result.direct_exact.availability).toEqual({
      state: "ready",
      reason: null,
    });
    expect(result.native_tab.availability).toEqual({
      state: "ready",
      reason: null,
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.map(([purchase]) => purchase.mode)).toEqual([
      "direct_exact",
      "native_tab",
    ]);
    expect(result.gateway_cash.availability.state).toBe(
      "integration_required",
    );
    expect(result.gateway_credit.availability.state).toBe(
      "integration_required",
    );
  });

  it("advertises a Gateway mode only from its matching fresh adapter and durable identity", () => {
    const prepare = vi.fn();
    const result = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
      getGatewayPurchaseAdapter: (mode) => gatewayAdapter(mode),
      getPurchaseAttemptStore: () => preparationStore(prepare),
    }));

    expect(result.gateway_cash.availability).toEqual({
      state: "ready",
      reason: null,
    });
    expect(result.gateway_credit.availability).toEqual({
      state: "ready",
      reason: null,
    });
    expect(prepare.mock.calls.map(([purchase]) => purchase.mode)).toEqual([
      "direct_exact",
      "gateway_cash",
      "gateway_credit",
      "native_tab",
    ]);
  });

  it("fails closed on a missing, cross-mode, or broken Gateway adapter", () => {
    const store = preparationStore(() => {});
    const wrongMode = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
      getGatewayPurchaseAdapter: () => gatewayAdapter("gateway_credit"),
      getPurchaseAttemptStore: () => store,
    }));
    expect(wrongMode.gateway_cash.availability).toEqual({
      state: "integration_required",
      reason: "gateway_cash_adapter_required",
    });

    const broken = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
      getGatewayPurchaseAdapter: (mode) => ({
        ...gatewayAdapter(mode),
        readiness: () => {
          throw new Error("backend unavailable");
        },
      }),
      getPurchaseAttemptStore: () => store,
    }));
    expect(broken.gateway_cash.availability).toEqual({
      state: "integration_required",
      reason: "gateway_adapter_readiness_failed",
    });
    expect(broken.gateway_credit.availability).toEqual({
      state: "integration_required",
      reason: "gateway_adapter_readiness_failed",
    });

    const malformed = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
      getGatewayPurchaseAdapter: (mode) => ({
        ...gatewayAdapter(mode),
        readiness: () => ({
          state: "ready",
          reason: "not-a-valid-ready-result",
        } as unknown as ReturnType<GatewayPurchaseAdapterV1["readiness"]>),
      }),
      getPurchaseAttemptStore: () => store,
    }));
    expect(malformed.gateway_cash.availability).toEqual({
      state: "integration_required",
      reason: "gateway_adapter_readiness_invalid",
    });
    expect(malformed.gateway_credit.availability).toEqual({
      state: "integration_required",
      reason: "gateway_adapter_readiness_invalid",
    });
  });

  it("downgrades ready modes when durable preparation is absent or fails", () => {
    const missing = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
    }));
    expect(missing.direct_exact.availability).toEqual({
      state: "integration_required",
      reason: "durable_purchase_preparation_store_required",
    });
    expect(missing.native_tab.availability).toEqual({
      state: "integration_required",
      reason: "durable_purchase_preparation_store_required",
    });

    const failing = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getTabLane: () => vi.fn(),
      getPurchaseAttemptStore: () =>
        preparationStore(() => {
          throw new Error("disk unavailable");
        }),
    }));
    expect(failing.direct_exact.availability).toEqual({
      state: "integration_required",
      reason: "durable_purchase_preparation_failed",
    });
    expect(failing.native_tab.availability).toEqual({
      state: "integration_required",
      reason: "durable_purchase_preparation_failed",
    });
  });

  it("distinguishes wallet, network, and Native Tab executor capabilities", () => {
    const store = preparationStore(() => {});
    const noWallet = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: null,
      getTabLane: () => vi.fn(),
      getPurchaseAttemptStore: () => store,
    }));
    expect(noWallet.direct_exact.availability).toEqual({
      state: "unavailable",
      reason: "local_direct_solana_wallet_required",
    });
    expect(noWallet.native_tab.availability.state).toBe("ready");

    const noTab = byMode(preparePurchaseOptionsForCapabilities(options(), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getPurchaseAttemptStore: () => store,
    }));
    expect(noTab.direct_exact.availability.state).toBe("ready");
    expect(noTab.native_tab.availability).toEqual({
      state: "integration_required",
      reason: "local_native_tab_adapter_required",
    });

    const unsupported = byMode(preparePurchaseOptionsForCapabilities(
      options([paymentOption("exact", "eip155:1")]),
      {
        wallet: wallet({ evmPrivateKey: "evm-secret" }),
        getPurchaseAttemptStore: () => store,
      },
    ));
    expect(unsupported.direct_exact.availability).toEqual({
      state: "unavailable",
      reason: "local_direct_network_not_supported",
    });
  });

  it("caps the number of durable ready identities produced by one check", () => {
    const prepare = vi.fn();
    const many = Array.from({ length: 18 }, (_, index) =>
      paymentOption("exact", index % 2 === 0 ? "solana" : "solana:mainnet"),
    );
    const result = preparePurchaseOptionsForCapabilities(options(many), {
      wallet: wallet({ solanaPrivateKey: "solana-secret" }),
      getPurchaseAttemptStore: () => preparationStore(prepare),
    }).filter((option) => option.mode === "direct_exact");

    expect(result.filter((option) =>
      option.availability.state === "ready")).toHaveLength(16);
    expect(result.slice(16).map((option) => option.availability)).toEqual([
      {
        state: "unavailable",
        reason: "prepared_purchase_option_limit_exceeded",
      },
      {
        state: "unavailable",
        reason: "prepared_purchase_option_limit_exceeded",
      },
    ]);
    expect(prepare).toHaveBeenCalledTimes(16);
  });

});
