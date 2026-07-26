import { afterEach, describe, expect, it, vi } from "vitest";

import { x402Fetch } from "../../x402-mcp-tools/src/tools/fetch.js";
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
