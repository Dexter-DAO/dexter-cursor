import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  PURCHASE_CONTRACT_VERSION,
  PURCHASE_MODES,
  attachPurchaseReceipt,
  buildPurchaseOptions,
  sellerOfferMatches,
  validatePurchaseExecution,
} from "../../x402-mcp-tools/src/purchase-contract.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/purchase-contract-v1.json", import.meta.url), "utf8"),
);

function options(surface: "hosted" | "local" = "local") {
  let index = 0;
  return buildPurchaseOptions({
    checkResult: fixture.checkResult,
    url: fixture.resourceUrl,
    method: fixture.method,
    payload: fixture.payload,
    requestBound: true,
    surface,
    now: () => new Date(fixture.preparedAt),
    idFactory: () => fixture.preparedIds[index++],
  });
}

describe("opendexter.purchase.v1", () => {
  it("keeps the hosted/local fixture contract and all four modes aligned", () => {
    expect(PURCHASE_CONTRACT_VERSION).toBe(fixture.contractVersion);
    expect(PURCHASE_MODES).toEqual([
      "direct_exact",
      "native_tab",
      "gateway_cash",
      "gateway_credit",
    ]);
    expect(options().map((entry) => entry.mode)).toEqual([
      "direct_exact",
      "gateway_cash",
      "gateway_credit",
      "native_tab",
    ]);
  });

  it("matches the hosted fail-closed availability contract", () => {
    const hosted = Object.fromEntries(
      options("hosted").map((entry) => [entry.mode, entry.availability]),
    );
    expect(hosted.direct_exact).toEqual({
      state: "integration_required",
      reason: "hosted_direct_exact_contract_required",
    });
    expect(hosted.native_tab).toEqual({
      state: "integration_required",
      reason: "hosted_native_tab_adapter_required",
    });
    expect(hosted.gateway_cash).toEqual({
      state: "integration_required",
      reason: "gateway_cash_adapter_required",
    });
    expect(hosted.gateway_credit).toEqual({
      state: "integration_required",
      reason: "gateway_credit_adapter_required",
    });
  });

  it("preserves one seller Exact offer across Direct and both Gateway buyer modes", () => {
    const [direct, cash, credit, tab] = options();
    expect(direct.preparedPurchase.route.routeId).toBe(
      cash.preparedPurchase.route.routeId,
    );
    expect(cash.preparedPurchase.route.routeId).toBe(
      credit.preparedPurchase.route.routeId,
    );
    expect(tab.preparedPurchase.route.routeId).not.toBe(
      direct.preparedPurchase.route.routeId,
    );
    expect(direct.preparedPurchase.route.sellerOffer.amountAtomic).toBe("10000");
    expect(typeof direct.preparedPurchase.route.sellerOffer.amountAtomic).toBe(
      "string",
    );
  });

  it("pins request, mode, offer, route, amount, and ceiling", () => {
    const purchase = options()[0].preparedPurchase;
    expect(
      validatePurchaseExecution({
        purchase,
        url: fixture.resourceUrl,
        method: fixture.method,
        payload: fixture.payload,
        approvedAmountCeilingAtomic: "10000",
      }).ok,
    ).toBe(true);

    const bodyChanged = validatePurchaseExecution({
      purchase,
      url: fixture.resourceUrl,
      method: fixture.method,
      payload: '{"q":"stocks"}',
      approvedAmountCeilingAtomic: "10000",
    });
    expect(bodyChanged).toMatchObject({
      ok: false,
      code: "purchase_payload_mismatch",
    });

    const tooLow = validatePurchaseExecution({
      purchase,
      url: fixture.resourceUrl,
      method: fixture.method,
      payload: fixture.payload,
      approvedAmountCeilingAtomic: "9999",
    });
    expect(tooLow).toMatchObject({
      ok: false,
      code: "purchase_ceiling_exceeded",
    });

    const oversizedCeiling = validatePurchaseExecution({
      purchase,
      url: fixture.resourceUrl,
      method: fixture.method,
      payload: fixture.payload,
      approvedAmountCeilingAtomic: "123456789012345678901",
    });
    expect(oversizedCeiling).toMatchObject({
      ok: false,
      code: "purchase_ceiling_invalid",
    });

    const changedExpiry = structuredClone(purchase);
    changedExpiry.expiresAt = "2030-01-01T00:00:00.000Z";
    expect(
      validatePurchaseExecution({
        purchase: changedExpiry,
        url: fixture.resourceUrl,
        method: fixture.method,
        payload: fixture.payload,
        approvedAmountCeilingAtomic: "10000",
      }),
    ).toMatchObject({
      ok: false,
      code: "purchase_expiry_mismatch",
    });
  });

  it("compares facilitator and expiry as part of the fresh seller offer", () => {
    const selected = options()[0].preparedPurchase.route.sellerOffer;
    const candidate = {
      scheme: selected.scheme,
      network: selected.network,
      asset: selected.asset,
      amount: selected.amountAtomic,
      payTo: selected.payTo,
      extra: {
        facilitator: selected.facilitator,
        expiresAt: selected.expiresAt,
      },
    };
    expect(sellerOfferMatches(selected, candidate)).toBe(true);
    expect(
      sellerOfferMatches(selected, {
        ...candidate,
        extra: {
          ...candidate.extra,
          feePayer: "DIFFERENT_FEE_PAYER",
        },
      }),
    ).toBe(false);
    expect(
      sellerOfferMatches(selected, {
        ...candidate,
        extra: {
          ...candidate.extra,
          facilitator: "https://different-facilitator.example",
        },
      }),
    ).toBe(false);
    expect(
      sellerOfferMatches(selected, {
        ...candidate,
        extra: {
          ...candidate.extra,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("keeps Native Tab accrual separate from cash settlement", () => {
    const tab = options()[3].preparedPurchase;
    const validated = validatePurchaseExecution({
      purchase: tab,
      url: fixture.resourceUrl,
      method: fixture.method,
      payload: fixture.payload,
      approvedAmountCeilingAtomic: "10000",
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = attachPurchaseReceipt(
      {
        status: 200,
        payment: {
          rail: "tab",
          settled: "accrued_to_tab",
          incrementAtomic: "10000",
          cumulativeAtomic: "30000",
          channelId: "channel-1",
          sequenceNumber: "3",
        },
      },
      validated.value,
    );
    expect(result.purchaseReceipt).toMatchObject({
      mode: "native_tab",
      dispatch: "dispatched",
      retry: "none",
      voucher: {
        state: "accepted",
        incrementAtomic: "10000",
        cumulativeAtomic: "30000",
      },
      sellerCashSettlement: "not_settled",
    });
    expect(result).not.toHaveProperty("purchaseReceipt.sellerSettlement");
  });

  it("keeps Codex and Claude hosted routing references on the opaque-intent contract", () => {
    const files = [
      "../../../plugins/opendexter/skills/opendexter/SKILL.md",
      "../../../plugins/opendexter/skills/opendexter/references/routing-and-safety.md",
      "../../../plugins/opendexter/skills/x402-protocol/SKILL.md",
      "../../../opendexter-plugin/skills/opendexter/SKILL.md",
      "../../../opendexter-plugin/skills/opendexter/references/routing-and-safety.md",
      "../../../opendexter-plugin/skills/x402-protocol/SKILL.md",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toContain("x402_check");
      expect(source, file).toContain("intentId");
      expect(source, file).toContain("x402_fetch");
      expect(source, file).toContain("x402_status");
      expect(source, file).not.toContain("purchaseOptions");
      expect(source, file).not.toContain("preparedPurchase");
      expect(source, file).not.toContain("direct_exact");
      expect(source, file).not.toContain("native_tab");
      expect(source, file).not.toContain("gateway_cash");
      expect(source, file).not.toContain("gateway_credit");
      expect(source, file).not.toContain("integration_required");
    }
  });
});
