import { afterEach, describe, expect, it, vi } from "vitest";

import { x402Fetch } from "../../x402-mcp-tools/src/tools/fetch.js";
import type {
  GatewayPurchaseAdapterV1,
  GatewayPurchaseModeV1,
} from "../../x402-mcp-tools/src/types.js";
import {
  buildPurchaseOptions,
  sellerAcceptSha256,
  type PurchaseAttemptStoreV1,
  type PreparedPurchaseV1,
} from "../../x402-mcp-tools/src/purchase-contract.js";

const URL = "https://merchant.example/data";
const OFFER = {
  scheme: "exact",
  network: "solana:mainnet",
  asset: "USDC_MINT",
  amountAtomic: "10000",
  payTo: "SELLER",
  facilitator: null,
  expiresAt: null,
};
const TAB_OFFER = { ...OFFER, scheme: "tab" };

function rawAccept(offer: typeof OFFER | typeof TAB_OFFER) {
  return {
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    amount: offer.amountAtomic,
    payTo: offer.payTo,
    extra: { decimals: 6 },
  };
}

function purchase(
  mode: "direct_exact" | "native_tab" | "gateway_cash" | "gateway_credit",
  resolvedUrl = URL,
) {
  const selected = mode === "native_tab" ? TAB_OFFER : OFFER;
  const option = buildPurchaseOptions({
    checkResult: {
      requiresPayment: true,
      x402Version: 2,
      resolvedUrl,
      paymentOptions: [{
        ...selected,
        rawAcceptSha256: sellerAcceptSha256(rawAccept(selected)),
      }],
    },
    url: URL,
    method: "GET",
    payload: null,
    surface: "local",
    idFactory: () => `prepared-${mode}`,
  }).find((entry) => entry.mode === mode);
  if (!option) throw new Error(`missing ${mode} fixture`);
  return option.preparedPurchase;
}

function responseFor(accepts: Array<Record<string, unknown>>) {
  return new Response(
    JSON.stringify({
      x402Version: 2,
      accepts: accepts.map((offer) =>
        rawAccept(offer as typeof OFFER)),
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

const testExternalFetch: typeof fetch = (input, init) => fetch(input, init);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("explicit purchase routing", () => {
  it.each(["gateway_cash", "gateway_credit"] as const)(
    "%s fails before even probing the seller when its adapter is absent",
    async (mode) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const result = await x402Fetch(
        { url: URL, method: "GET", purchase: purchase(mode) },
        null,
        { maxAmountUsdc: 5, maxAmountAtomic: "10000" },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        mode: "purchase_mode_integration_required",
        payment: { dispatched: false, settled: false },
        purchaseReceipt: {
          mode,
          dispatch: "not_dispatched",
        },
      });
    },
  );

  it.each(["gateway_cash", "gateway_credit"] as const)(
    "%s continues the same prepared purchase through one matching adapter and exact ceiling",
    async (mode) => {
      const sellerProbe = vi.fn(async () => responseFor([OFFER]));
      vi.stubGlobal("fetch", sellerProbe);
      const events: string[] = [];
      const complete = vi.fn();
      const store: PurchaseAttemptStoreV1 = {
        begin: () => ({ acquired: true }),
        markDispatching: () => { events.push("dispatch-marked"); },
        complete,
      };
      const execute = vi.fn(async ({ purchase: validated }) => {
        events.push("adapter-executed");
        return mode === "gateway_cash"
          ? {
              status: 200,
              data: { answer: "cash" },
              payment: {
                dispatched: true,
                correlationId: "gateway-cash-1",
                buyerCash: { state: "charged" },
                sellerSettlement: {
                  state: "settled",
                  transaction: "CASH_SETTLEMENT",
                },
              },
            }
          : {
              status: 200,
              data: { answer: "credit" },
              payment: {
                dispatched: true,
                correlationId: "gateway-credit-1",
                exposure: { state: "reserved" },
                buyerObligation: {
                  state: "finalized",
                  claimId: "CLAIM_1",
                },
                sellerSettlement: {
                  state: "settled",
                  transaction: "CREDIT_SETTLEMENT",
                },
              },
            };
      });
      const adapter: GatewayPurchaseAdapterV1 = {
        mode,
        readiness: () => ({ state: "ready", reason: null }),
        execute,
      };

      const result = await x402Fetch(
        { url: URL, method: "GET", purchase: purchase(mode) },
        null,
        {
          maxAmountUsdc: 5,
          maxAmountAtomic: "10000",
          purchaseAttempts: store,
          getGatewayPurchaseAdapter: (
            requested: GatewayPurchaseModeV1,
          ) => requested === mode ? adapter : null,
          explicitExternalFetch: testExternalFetch,
        },
      );

      expect(sellerProbe).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["dispatch-marked", "adapter-executed"]);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toMatchObject({
        purchase: {
          mode,
          approvedAmountCeilingAtomic: "10000",
          route: {
            resourceUrl: URL,
            resolvedUrl: URL,
            method: "GET",
          },
        },
        request: { url: URL, method: "GET" },
        seller: {
          x402Version: 2,
          accept: rawAccept(OFFER),
          requirements: {
            x402Version: 2,
            accepts: [rawAccept(OFFER)],
          },
        },
      });
      expect(result).toMatchObject({
        status: 200,
        purchaseReceipt: {
          mode,
          dispatch: "dispatched",
          retry: "none",
          approvedAmountCeilingAtomic: "10000",
        },
      });
      expect(complete).toHaveBeenCalledOnce();
    },
  );

  it("rejects a Gateway ceiling mismatch before seller probe, claim, or adapter dispatch", async () => {
    const sellerProbe = vi.fn();
    vi.stubGlobal("fetch", sellerProbe);
    const execute = vi.fn();
    const begin = vi.fn();
    const adapter: GatewayPurchaseAdapterV1 = {
      mode: "gateway_credit",
      readiness: () => ({ state: "ready", reason: null }),
      execute,
    };

    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: purchase("gateway_credit"),
      },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "9999",
        purchaseAttempts: {
          begin,
          markDispatching: vi.fn(),
          complete: vi.fn(),
        },
        getGatewayPurchaseAdapter: () => adapter,
      },
    );

    expect(result).toMatchObject({
      mode: "purchase_contract_error",
      error: "purchase_ceiling_exceeded",
      payment: { dispatched: false },
    });
    expect(sellerProbe).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps Gateway adapter failures provider-neutral and reconciliation-only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseFor([OFFER])));
    const adapter: GatewayPurchaseAdapterV1 = {
      mode: "gateway_credit",
      readiness: () => ({ state: "ready", reason: null }),
      execute: async () => {
        throw new Error("provider secret route /internal/credit/123");
      },
    };

    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: purchase("gateway_credit"),
      },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        getGatewayPurchaseAdapter: () => adapter,
        explicitExternalFetch: testExternalFetch,
      },
    );

    expect(result).toMatchObject({
      mode: "gateway_execution_unknown",
      error: "gateway_adapter_failed_after_dispatch_mark",
      retryable: false,
      purchaseReceipt: {
        mode: "gateway_credit",
        dispatch: "unknown",
        retry: "reconcile_only",
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider secret route");
    expect(JSON.stringify(result)).not.toContain("/internal/credit/123");
  });

  it("rejects and redacts a non-throwing Gateway result with private fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseFor([OFFER])));
    const adapter: GatewayPurchaseAdapterV1 = {
      mode: "gateway_cash",
      readiness: () => ({ state: "ready", reason: null }),
      execute: async () => ({
        status: 500,
        errorDetail: "provider secret /internal/cash/123",
        payment: {
          dispatched: true,
          buyerCash: { state: "charge_unconfirmed" },
          sellerSettlement: { state: "unconfirmed" },
        },
      } as never),
    };
    const result = await x402Fetch(
      { url: URL, method: "GET", purchase: purchase("gateway_cash") },
      null,
      {
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        getGatewayPurchaseAdapter: () => adapter,
        explicitExternalFetch: testExternalFetch,
      },
    );
    expect(result).toMatchObject({
      mode: "gateway_execution_invalid",
      error: "gateway_adapter_result_invalid",
      purchaseReceipt: { retry: "reconcile_only", dispatch: "unknown" },
    });
    expect(JSON.stringify(result)).not.toContain("provider secret");
    expect(JSON.stringify(result)).not.toContain("errorDetail");
  });

  it.each([false, undefined] as const)(
    "keeps terminal Gateway facts reconciliation-only when dispatched is %s",
    async (dispatched) => {
      vi.stubGlobal("fetch", vi.fn(async () => responseFor([OFFER])));
      const complete = vi.fn();
      const adapter: GatewayPurchaseAdapterV1 = {
        mode: "gateway_credit",
        readiness: () => ({ state: "ready", reason: null }),
        execute: async () => ({
          status: 200,
          payment: {
            ...(dispatched === undefined ? {} : { dispatched }),
            exposure: { state: "reserved" },
            buyerObligation: { state: "finalized", claimId: "CLAIM_1" },
            sellerSettlement: { state: "settled", transaction: "TX_1" },
          },
        } as never),
      };
      const result = await x402Fetch(
        { url: URL, method: "GET", purchase: purchase("gateway_credit") },
        null,
        {
          maxAmountAtomic: "10000",
          purchaseAttempts: {
            begin: () => ({ acquired: true }),
            markDispatching: () => {},
            complete,
          },
          getGatewayPurchaseAdapter: () => adapter,
          explicitExternalFetch: testExternalFetch,
        },
      );
      expect(result).toMatchObject({
        retryable: false,
        purchaseReceipt: { retry: "reconcile_only" },
      });
      expect(complete).toHaveBeenCalledWith(
        expect.anything(),
        "reconciliation_required",
        expect.objectContaining({ retry: "reconcile_only" }),
      );
    },
  );

  it.each([
    [
      "gateway_cash",
      {
        dispatched: false,
        buyerCash: { state: "charged" },
        sellerSettlement: { state: "unconfirmed" },
      },
    ],
    [
      "gateway_credit",
      {
        dispatched: false,
        exposure: { state: "reserved" },
        buyerObligation: { state: "not_finalized" },
        sellerSettlement: { state: "not_dispatched" },
      },
    ],
  ] as const)(
    "keeps partial %s economic facts reconciliation-only",
    async (mode, payment) => {
      vi.stubGlobal("fetch", vi.fn(async () => responseFor([OFFER])));
      const complete = vi.fn();
      const adapter: GatewayPurchaseAdapterV1 = {
        mode,
        readiness: () => ({ state: "ready", reason: null }),
        execute: async () => ({ status: 409, payment } as never),
      };
      const result = await x402Fetch(
        { url: URL, method: "GET", purchase: purchase(mode) },
        null,
        {
          maxAmountAtomic: "10000",
          purchaseAttempts: {
            begin: () => ({ acquired: true }),
            markDispatching: () => {},
            complete,
          },
          getGatewayPurchaseAdapter: () => adapter,
          explicitExternalFetch: testExternalFetch,
        },
      );
      expect(result).toMatchObject({
        phase: "dispatch_unknown",
        purchaseReceipt: { retry: "reconcile_only" },
      });
      expect(complete).toHaveBeenCalledWith(
        expect.anything(),
        "reconciliation_required",
        expect.objectContaining({ retry: "reconcile_only" }),
      );
    },
  );

  it("does not expose an arbitrary Gateway readiness reason", async () => {
    const sellerProbe = vi.fn();
    vi.stubGlobal("fetch", sellerProbe);
    const adapter: GatewayPurchaseAdapterV1 = {
      mode: "gateway_cash",
      readiness: () => ({
        state: "unavailable",
        reason: "private route /internal/cash",
      } as never),
      execute: vi.fn(),
    };
    const result = await x402Fetch(
      { url: URL, method: "GET", purchase: purchase("gateway_cash") },
      null,
      {
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        getGatewayPurchaseAdapter: () => adapter,
      },
    );
    expect(result).toMatchObject({
      error: "gateway_adapter_readiness_invalid",
      payment: { dispatched: false },
    });
    expect(JSON.stringify(result)).not.toContain("private route");
    expect(sellerProbe).not.toHaveBeenCalled();
  });

  it("Direct Exact never invokes the Tab adapter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseFor([OFFER])));
    const tabLane = vi.fn();
    const result = await x402Fetch(
      { url: URL, method: "GET", purchase: purchase("direct_exact") },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        tabLane,
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
      },
    );
    expect(tabLane).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 402,
      purchaseReceipt: {
        mode: "direct_exact",
        dispatch: "not_dispatched",
      },
    });
  });

  it("Native Tab pending/setup state stops and never falls through to Exact", async () => {
    const fetchSpy = vi.fn(async () => responseFor([TAB_OFFER, OFFER]));
    vi.stubGlobal("fetch", fetchSpy);
    const tabLane = vi.fn(async () => ({
      done: false as const,
      offer: {
        mode: "tab_pending" as const,
        connectUrl: "https://dexter.cash/tab/approve",
      },
    }));
    const result = await x402Fetch(
      { url: URL, method: "GET", purchase: purchase("native_tab") },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        tabLane,
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
      },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(tabLane).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      mode: "tab_pending",
      message: expect.stringContaining("resume this same prepared purchase"),
      payment: { dispatched: false, settled: false },
      purchaseReceipt: {
        mode: "native_tab",
        dispatch: "not_dispatched",
        retry: "same_prepared_only",
        voucher: { state: "not_issued" },
        sellerCashSettlement: "not_settled",
      },
    });
  });

  it("Native Tab dispatch returns a voucher receipt without invoking Exact", async () => {
    const fetchSpy = vi.fn(async () => responseFor([TAB_OFFER, OFFER]));
    vi.stubGlobal("fetch", fetchSpy);
    const tabLane = vi.fn(async () => ({
      done: true as const,
      result: {
        status: 200,
        data: { answer: "via-tab" },
        payment: {
          rail: "tab",
          settled: "accrued_to_tab",
          incrementAtomic: "10000",
          cumulativeAtomic: "30000",
          channelId: "channel-1",
          sequenceNumber: "3",
        },
      },
    }));
    const result = await x402Fetch(
      { url: URL, method: "GET", purchase: purchase("native_tab") },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        tabLane,
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(tabLane).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 200,
      data: { answer: "via-tab" },
      purchaseReceipt: {
        mode: "native_tab",
        dispatch: "dispatched",
        retry: "none",
        voucher: {
          state: "accepted",
          incrementAtomic: "10000",
          cumulativeAtomic: "30000",
        },
        sellerCashSettlement: "not_settled",
      },
    });
  });

  it("Native Tab adapter failure is final for that prepared mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseFor([TAB_OFFER, OFFER])));
    const result = await x402Fetch(
      { url: URL, method: "GET", purchase: purchase("native_tab") },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
        tabLane: async () => {
          throw new Error("lane exploded");
        },
      },
    );
    expect(result).toMatchObject({
      mode: "native_tab_error",
      error: "native_tab_adapter_failed",
      phase: "dispatch_unknown",
      retryable: false,
      payment: { settled: "unknown", retrySafe: false },
      purchaseReceipt: {
        mode: "native_tab",
        dispatch: "unknown",
        retry: "reconcile_only",
        voucher: { state: "unconfirmed" },
      },
    });
  });

  it("changed seller terms fail before any selected adapter can dispatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor([{ ...OFFER, asset: "PYUSD_MINT" }]),
      ),
    );
    const tabLane = vi.fn();
    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: purchase("direct_exact") as PreparedPurchaseV1,
      },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        tabLane,
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
      },
    );
    expect(tabLane).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "purchase_terms_changed",
      error: "selected_seller_offer_not_found",
      payment: { dispatched: false, settled: false },
    });
  });

  it("a failed initial seller probe is explicitly pre-dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network offline");
    }));
    const result = await x402Fetch(
      { url: URL, method: "GET", purchase: purchase("direct_exact") },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
      },
    );
    expect(result).toMatchObject({
      mode: "purchase_probe_failed",
      error: "seller_probe_failed",
      payment: { dispatched: false, settled: false },
      purchaseReceipt: {
        mode: "direct_exact",
        dispatch: "not_dispatched",
        retry: "new_prepare_required",
      },
    });
  });

  it("probes only the prepared resolved route and disables redirects", async () => {
    const resolvedUrl = "https://merchant.example/resolved-data";
    const fetchSpy = vi.fn(async () => responseFor([OFFER]));
    vi.stubGlobal("fetch", fetchSpy);
    await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: purchase("direct_exact", resolvedUrl),
      },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(resolvedUrl);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects a changed redirect result before an adapter can dispatch", async () => {
    const changed = responseFor([OFFER]);
    Object.defineProperty(changed, "url", {
      configurable: true,
      value: "https://different-merchant.example/data",
    });
    const fetchSpy = vi.fn(async () => changed);
    vi.stubGlobal("fetch", fetchSpy);
    const tabLane = vi.fn();
    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: purchase("direct_exact"),
      },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        tabLane,
        purchaseAttempts: attemptStore(),
        explicitExternalFetch: testExternalFetch,
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(tabLane).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "purchase_route_changed",
      error: "seller_resolved_url_changed",
      payment: { dispatched: false, settled: false },
    });
  });

  it("rejects private prepared destinations without making a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await x402Fetch(
      {
        url: URL,
        method: "GET",
        purchase: purchase("direct_exact", "https://127.0.0.1/private"),
      },
      null,
      {
        maxAmountUsdc: 5,
        maxAmountAtomic: "10000",
        purchaseAttempts: attemptStore(),
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "purchase_contract_error",
      error: "prepared_resolved_url_not_public_https",
      payment: { dispatched: false, settled: false },
    });
  });
});
