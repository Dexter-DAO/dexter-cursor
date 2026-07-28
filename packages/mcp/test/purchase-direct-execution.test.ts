import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WalletAdapter } from "../../x402-mcp-tools/src/wallet-adapter.js";
import {
  buildPurchaseOptions,
  sellerAcceptSha256,
  type PurchaseAttemptStoreV1,
  type PreparedPurchaseV1,
} from "../../x402-mcp-tools/src/purchase-contract.js";

const mocks = vi.hoisted(() => ({
  pay: vi.fn(),
  parseChallenge: vi.fn(),
  detectStrategy: vi.fn(),
  buildV1PaymentHeader: vi.fn(),
  toNetworkRef: vi.fn(),
  buildTransaction: vi.fn(),
  adapter: {
    name: "Solana",
    canHandle: vi.fn(() => true),
    isConnected: vi.fn(() => true),
    getDefaultRpcUrl: vi.fn(() => "https://rpc.example"),
    buildTransaction: vi.fn(),
  },
}));

vi.mock("@dexterai/x402/client", () => ({
  payAndFetch: vi.fn(),
  detectStrategy: mocks.detectStrategy,
  buildV1PaymentHeader: mocks.buildV1PaymentHeader,
  createKeypairWallet: vi.fn(async () => ({ kind: "solana" })),
  createEvmKeypairWallet: vi.fn(async () => ({ kind: "evm" })),
  createSolanaAdapter: vi.fn(() => mocks.adapter),
  createEvmAdapter: vi.fn(() => mocks.adapter),
  toNetworkRef: mocks.toNetworkRef,
  getSponsoredRecommendations: vi.fn(() => null),
  fireImpressionBeacon: vi.fn(async () => {}),
}));

import {
  registerFetchTool,
  x402Fetch,
} from "../../x402-mcp-tools/src/tools/fetch.js";

const URL = "https://merchant.example/data";
const SELECTED = {
  scheme: "exact",
  network: "solana:mainnet",
  asset: "USDC_MINT",
  amountAtomic: "10000",
  payTo: "SELLER",
  facilitator: null,
  expiresAt: null,
};
const OTHER_ASSET = {
  ...SELECTED,
  asset: "PYUSD_MINT",
};
const EVM_SELECTED = {
  ...SELECTED,
  network: "eip155:8453",
  asset: "0xUSDC",
  payTo: "0x0000000000000000000000000000000000000001",
};

function rawAccept(
  offer: typeof SELECTED | typeof OTHER_ASSET | typeof EVM_SELECTED,
  extra: Record<string, unknown> = {},
) {
  return {
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    amount: offer.amountAtomic,
    payTo: offer.payTo,
    extra: { decimals: 6, ...extra },
  };
}

function directPurchase(
  x402Version: 1 | 2 = 2,
  selected: typeof SELECTED | typeof EVM_SELECTED = SELECTED,
): PreparedPurchaseV1 {
  const option = buildPurchaseOptions({
    checkResult: {
      requiresPayment: true,
      x402Version,
      resolvedUrl: URL,
      paymentOptions: [{
        ...selected,
        rawAcceptSha256: sellerAcceptSha256(rawAccept(selected)),
      }],
    },
    url: URL,
    method: "GET",
    payload: null,
    surface: "local",
    idFactory: () => "prepared-direct-exact",
  }).find((entry) => entry.mode === "direct_exact");
  if (!option) throw new Error("missing direct fixture");
  return option.preparedPurchase;
}

function challengeOption(
  offer: typeof SELECTED | typeof OTHER_ASSET | typeof EVM_SELECTED,
) {
  return {
    scheme: offer.scheme,
    network: { caip2: offer.network, bare: "solana" },
    amount: offer.amountAtomic,
    asset: offer.asset,
    payTo: offer.payTo,
  };
}

function paymentRequiredResponse(x402Version: 1 | 2 = 2): Response {
  return new Response(
    JSON.stringify({
      x402Version,
      accepts: [
        rawAccept(SELECTED),
        rawAccept(SELECTED, { feePayer: "CHANGED_FEE_PAYER" }),
        rawAccept(OTHER_ASSET),
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

function attemptStore(): PurchaseAttemptStoreV1 {
  return {
    begin: () => ({ acquired: true }),
    markDispatching: () => {},
    complete: () => {},
  };
}

const wallet: WalletAdapter = {
  getInfo: () => ({}),
  getAvailableUsdc: async () => 10,
  getAllBalances: async () => ({ totalUsdc: 10, chains: {} }),
  getPaymentSigners: () => ({ solanaPrivateKey: "test-private-key" }),
  getSolanaSigner: () => null,
  getEvmSigner: () => null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.adapter.name = "Solana";
  mocks.toNetworkRef.mockImplementation((network: string) => ({
    caip2: network,
    bare: "solana",
    family: "svm",
  }));
});

describe("Direct Exact selected-offer execution", () => {
  it("dispatches only the prepared asset and returns a typed Direct Exact receipt", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("PAYMENT-SIGNATURE")) {
        return paymentRequiredResponse();
      }
      return new Response(JSON.stringify({ answer: 42 }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "payment-response": Buffer.from(
            JSON.stringify({ success: true, transaction: "DIRECT_TX" }),
          ).toString("base64"),
        },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    mocks.parseChallenge.mockResolvedValue({
      x402Version: 2,
      options: [challengeOption(SELECTED), challengeOption(OTHER_ASSET)],
    });
    mocks.detectStrategy.mockResolvedValue({
      parseChallenge: mocks.parseChallenge,
      pay: mocks.pay,
    });
    mocks.adapter.buildTransaction.mockResolvedValue({
      serialized: "SIGNED_SELECTED_TRANSACTION",
    });

    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: directPurchase(),
      },
      wallet,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: fetch,
      },
    );

    expect(mocks.pay).not.toHaveBeenCalled();
    expect(mocks.adapter.buildTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.adapter.buildTransaction.mock.calls[0]?.[0]).toMatchObject({
      asset: "USDC_MINT",
      amount: "10000",
      payTo: "SELLER",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
    const paidHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
    const signature = JSON.parse(
      Buffer.from(
        paidHeaders.get("PAYMENT-SIGNATURE") ?? "",
        "base64",
      ).toString("utf8"),
    );
    expect(signature.accepted).toMatchObject({
      asset: "USDC_MINT",
      amount: "10000",
      payTo: "SELLER",
    });
    expect(result).toMatchObject({
      status: 200,
      data: { answer: 42 },
      purchaseReceipt: {
        mode: "direct_exact",
        dispatch: "dispatched",
        retry: "none",
        sellerSettlement: {
          state: "settled",
          amountAtomic: "10000",
          network: "solana:mainnet",
          asset: "USDC_MINT",
          transaction: "DIRECT_TX",
        },
      },
    });
  });

  it("executes the selected EVM v2 offer without changing the route or asset", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("PAYMENT-SIGNATURE")) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [rawAccept(EVM_SELECTED)],
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ answer: "evm" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "payment-response": Buffer.from(
            JSON.stringify({ transaction: "EVM_TRANSACTION" }),
          ).toString("base64"),
        },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    mocks.adapter.name = "EVM";
    mocks.toNetworkRef.mockImplementation((network: string) => ({
      caip2: network,
      bare: "base",
      family: "evm",
    }));
    mocks.parseChallenge.mockResolvedValue({
      x402Version: 2,
      options: [challengeOption(EVM_SELECTED)],
    });
    mocks.detectStrategy.mockResolvedValue({
      parseChallenge: mocks.parseChallenge,
      pay: mocks.pay,
    });
    mocks.adapter.buildTransaction.mockResolvedValue({
      serialized: JSON.stringify({ signature: "SIGNED_EVM_AUTHORIZATION" }),
    });
    const evmWallet: WalletAdapter = {
      ...wallet,
      getPaymentSigners: () => ({ evmPrivateKey: "0xprivate-key" }),
    };

    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: directPurchase(2, EVM_SELECTED),
      },
      evmWallet,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: fetch,
      },
    );

    expect(mocks.adapter.buildTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.adapter.buildTransaction.mock.calls[0]?.[0]).toMatchObject({
      network: "eip155:8453",
      asset: "0xUSDC",
      payTo: EVM_SELECTED.payTo,
      amount: "10000",
    });
    expect(result).toMatchObject({
      status: 200,
      purchaseReceipt: {
        mode: "direct_exact",
        dispatch: "dispatched",
        retry: "none",
        sellerSettlement: {
          state: "settled",
          network: "eip155:8453",
          asset: "0xUSDC",
          transaction: "EVM_TRANSACTION",
        },
      },
    });
  });

  it("registers x402_fetch and x402_pay with the same prepared-purchase schema", () => {
    const schemas = new Map<string, unknown>();
    const server = {
      tool: (
        name: string,
        _description: string,
        schema: unknown,
        _handler: unknown,
      ) => {
        schemas.set(name, schema);
        return { update: vi.fn() };
      },
    };
    registerFetchTool(server as never, {
      apiBaseUrl: "https://x402.dexter.cash",
      metas: { fetch: {} } as never,
      wallet: null,
    });

    expect(schemas.get("x402_fetch")).toBe(schemas.get("x402_pay"));
    expect(schemas.get("x402_fetch")).toMatchObject({
      purchase: expect.anything(),
      maxAmountAtomic: expect.anything(),
    });
  });

  it("can suppress the historical x402_pay alias on canonical model surfaces", () => {
    const names: string[] = [];
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        _handler: unknown,
      ) => {
        names.push(name);
        return { update: vi.fn() };
      },
    };
    registerFetchTool(server as never, {
      apiBaseUrl: "https://x402.dexter.cash",
      metas: { fetch: {} } as never,
      wallet: null,
      registerPayAlias: false,
    });

    expect(names).toEqual(["x402_fetch"]);
  });

  it.each([1, 2] as const)(
    "rejects a v%s seller offer whose hidden fee-payer term changed",
    async (x402Version) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              x402Version,
              accepts: [
                rawAccept(SELECTED, {
                  feePayer: "CHANGED_FEE_PAYER_ONLY",
                }),
              ],
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          )),
      );

      const result = await x402Fetch(
        {
          url: URL,
          method: "GET",
          purchase: directPurchase(x402Version),
        },
        wallet,
        {
          maxAmountUsdc: 5,
          maxAmountAtomic: "10000",
          purchaseAttempts: attemptStore(),
          explicitExternalFetch: fetch,
        },
      );

      expect(mocks.detectStrategy).not.toHaveBeenCalled();
      expect(mocks.adapter.buildTransaction).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: 409,
        mode: "purchase_terms_changed",
        error: "selected_seller_offer_not_found",
        payment: { dispatched: false, settled: false },
      });
    },
  );

  it("executes one selected v1 offer through the guarded route", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("X-PAYMENT")) return paymentRequiredResponse(1);
      return new Response(JSON.stringify({ answer: "v1" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-payment-response": Buffer.from(
            JSON.stringify({ transaction: "V1_TRANSACTION" }),
          ).toString("base64"),
        },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    mocks.parseChallenge.mockResolvedValue({
      x402Version: 1,
      options: [challengeOption(SELECTED), challengeOption(OTHER_ASSET)],
    });
    mocks.detectStrategy.mockResolvedValue({
      parseChallenge: mocks.parseChallenge,
      pay: mocks.pay,
    });
    mocks.buildV1PaymentHeader.mockResolvedValue({
      ok: true,
      headerValue: "SIGNED_V1_PROOF",
      option: challengeOption(SELECTED),
    });

    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: directPurchase(1),
      },
      wallet,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: fetch,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
    const paidHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
    expect(paidHeaders.get("X-PAYMENT")).toBe("SIGNED_V1_PROOF");
    expect(result).toMatchObject({
      status: 200,
      data: { answer: "v1" },
      purchaseReceipt: {
        mode: "direct_exact",
        dispatch: "dispatched",
        retry: "none",
        sellerSettlement: {
          state: "settled",
          transaction: "V1_TRANSACTION",
        },
      },
    });
  });

  it("treats an unphased SDK error after the dispatch seam as reconciliation-only", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return paymentRequiredResponse(1);
        throw new Error("socket closed");
      }),
    );
    mocks.parseChallenge.mockResolvedValue({
      x402Version: 1,
      options: [challengeOption(SELECTED)],
    });
    mocks.detectStrategy.mockResolvedValue({
      parseChallenge: mocks.parseChallenge,
      pay: mocks.pay,
    });
    mocks.buildV1PaymentHeader.mockResolvedValue({
      ok: true,
      headerValue: "SIGNED_V1_PROOF",
      option: challengeOption(SELECTED),
    });

    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: directPurchase(1),
      },
      wallet,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: fetch,
      },
    );

    expect(mocks.pay).not.toHaveBeenCalled();
    expect(mocks.buildV1PaymentHeader).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      retryable: false,
      payment: { settled: "unconfirmed", retrySafe: false },
      purchaseReceipt: {
        mode: "direct_exact",
        dispatch: "unknown",
        retry: "reconcile_only",
        sellerSettlement: { state: "unconfirmed" },
      },
    });
  });
});
