import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  fetchPublicExternalUrl: vi.fn(),
}));

vi.mock("@dexterai/x402-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dexterai/x402-core")>()),
  fetchPublicExternalUrl: coreMocks.fetchPublicExternalUrl,
}));

import {
  attachPurchaseReceipt,
  buildPurchaseOptions,
  registerFetchTool,
  sellerAcceptSha256,
  validatePurchaseExecution,
  type PreparedPurchaseV1,
  type PurchaseReceiptV1,
  type ValidatedPurchaseV1,
} from "../../x402-mcp-tools/src/index.js";
import { createPurchaseAttemptStore } from "../src/purchase-attempt-ledger.js";

const URL = "https://merchant.example/tab";
const TAB_OFFER = {
  scheme: "tab",
  network: "solana:mainnet",
  asset: "USDC_MINT",
  amountAtomic: "10000",
  payTo: "SELLER",
  facilitator: null,
  expiresAt: null,
};

function rawTabAccept() {
  return {
    scheme: TAB_OFFER.scheme,
    network: TAB_OFFER.network,
    asset: TAB_OFFER.asset,
    amount: TAB_OFFER.amountAtomic,
    payTo: TAB_OFFER.payTo,
    extra: { decimals: 6 },
  };
}

function preparedTab(): PreparedPurchaseV1 {
  const option = buildPurchaseOptions({
    checkResult: {
      requiresPayment: true,
      x402Version: 2,
      resolvedUrl: URL,
      paymentOptions: [{
        ...TAB_OFFER,
        rawAcceptSha256: sellerAcceptSha256(rawTabAccept()),
      }],
    },
    url: URL,
    method: "GET",
    payload: null,
    surface: "local",
    idFactory: () => "prepared-durable-tab",
  }).find((entry) => entry.mode === "native_tab");
  if (!option) throw new Error("missing Native Tab fixture");
  return option.preparedPurchase;
}

function validated(
  prepared: PreparedPurchaseV1 = preparedTab(),
): ValidatedPurchaseV1 {
  const result = validatePurchaseExecution({
    purchase: prepared,
    url: URL,
    method: "GET",
    payload: null,
    approvedAmountCeilingAtomic: "10000",
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function receipt(
  purchase: ValidatedPurchaseV1,
  result: Record<string, unknown>,
): PurchaseReceiptV1 {
  return attachPurchaseReceipt(result, purchase)
    .purchaseReceipt as PurchaseReceiptV1;
}

function paymentRequiredResponse(): Response {
  return new Response(
    JSON.stringify({
      x402Version: 2,
      accepts: [rawTabAccept()],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

let directory = "";

afterEach(() => {
  vi.unstubAllGlobals();
  coreMocks.fetchPublicExternalUrl.mockReset();
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    directory = "";
  }
});

describe("durable prepared-purchase attempts", () => {
  it("fails closed across concurrent, dispatched, and completed claims", () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-attempt-"));
    const store = createPurchaseAttemptStore(directory);
    store.prepare(preparedTab());
    const purchase = validated();

    expect(store.begin(purchase)).toEqual({ acquired: true });
    expect(store.begin(purchase)).toMatchObject({
      acquired: false,
      state: "claimed",
      receipt: null,
    });

    store.markDispatching(purchase);
    expect(store.begin(purchase)).toMatchObject({
      acquired: false,
      state: "dispatching",
    });

    const completedReceipt = receipt(purchase, {
      status: 200,
      payment: {
        rail: "tab",
        settled: "accrued_to_tab",
        incrementAtomic: "10000",
        cumulativeAtomic: "10000",
      },
    });
    store.complete(purchase, "completed", completedReceipt);
    expect(store.begin(purchase)).toMatchObject({
      acquired: false,
      state: "completed",
      receipt: completedReceipt,
    });
  });

  it("allows only the same prepared identity to resume an approval wait", () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-wait-"));
    const store = createPurchaseAttemptStore(directory);
    store.prepare(preparedTab());
    const purchase = validated();
    expect(store.begin(purchase)).toEqual({ acquired: true });
    const waitingReceipt = receipt(purchase, {
      status: 402,
      mode: "tab_pending",
      connect_url: "https://dexter.cash/tab/approve",
      payment: { dispatched: false, settled: false },
    });
    expect(waitingReceipt.retry).toBe("same_prepared_only");
    store.complete(purchase, "awaiting_action", waitingReceipt);
    expect(store.begin(purchase)).toEqual({ acquired: true });
  });

  it("treats a corrupt durable record as unresolved instead of overwriting it", () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-corrupt-"));
    const store = createPurchaseAttemptStore(directory);
    store.prepare(preparedTab());
    const purchase = validated();
    expect(store.begin(purchase)).toEqual({ acquired: true });
    const completedReceipt = receipt(purchase, {
      status: 200,
      payment: {
        rail: "tab",
        settled: "accrued_to_tab",
        incrementAtomic: "10000",
        cumulativeAtomic: "10000",
      },
    });
    store.complete(purchase, "completed", completedReceipt);

    const attemptDirectory = join(directory, "purchase-attempts-v1");
    const [record] = readdirSync(attemptDirectory).filter((name) =>
      name.endsWith(".json"),
    );
    expect(record).toBeTruthy();
    writeFileSync(join(attemptDirectory, record), "{not-json}\n", "utf8");

    expect(store.begin(purchase)).toEqual({
      acquired: false,
      state: "unknown",
      receipt: null,
    });
  });

  it("x402_fetch and x402_pay cannot dispatch the same prepared identity twice", async () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-alias-"));
    const store = createPurchaseAttemptStore(directory);
    store.prepare(preparedTab());
    const handlers = new Map<
      string,
      (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
      ) => {
        handlers.set(name, handler);
        return { update: vi.fn() };
      },
    };
    const tabLane = vi.fn(async () => ({
      done: true as const,
      result: {
        status: 200,
        data: { via: "tab" },
        payment: {
          rail: "tab",
          settled: "accrued_to_tab",
          incrementAtomic: "10000",
          cumulativeAtomic: "10000",
        },
      },
    }));
    coreMocks.fetchPublicExternalUrl.mockResolvedValue(
      paymentRequiredResponse(),
    );

    registerFetchTool(server as never, {
      apiBaseUrl: "https://x402.dexter.cash",
      metas: { fetch: {} } as never,
      wallet: null,
      getTabLane: () => tabLane,
      getPurchaseAttemptStore: () => store,
    });
    const args = {
      url: URL,
      method: "GET",
      maxAmountAtomic: "10000",
      purchase: preparedTab(),
    };
    const first = await handlers.get("x402_fetch")!(args);
    const second = await handlers.get("x402_pay")!(args);

    expect(first.structuredContent).toMatchObject({
      status: 200,
      purchaseReceipt: {
        mode: "native_tab",
        retry: "none",
      },
    });
    expect(second.structuredContent).toMatchObject({
      status: 409,
      mode: "purchase_attempt_already_recorded",
      purchaseReceipt: {
        mode: "native_tab",
        retry: "none",
      },
    });
    expect(coreMocks.fetchPublicExternalUrl).toHaveBeenCalledTimes(1);
    expect(tabLane).toHaveBeenCalledTimes(1);
  });

  it("resumes one pending Native Tab attempt with the same prepared identity", async () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-resume-"));
    const store = createPurchaseAttemptStore(directory);
    store.prepare(preparedTab());
    const handlers = new Map<
      string,
      (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
      ) => {
        handlers.set(name, handler);
        return { update: vi.fn() };
      },
    };
    const tabLane = vi
      .fn()
      .mockResolvedValueOnce({
        done: false as const,
        offer: {
          mode: "tab_pending" as const,
          connectUrl: "https://dexter.cash/tab/approve",
        },
      })
      .mockResolvedValueOnce({
        done: true as const,
        result: {
          status: 200,
          data: { via: "resumed-tab" },
          payment: {
            rail: "tab",
            settled: "accrued_to_tab",
            incrementAtomic: "10000",
            cumulativeAtomic: "20000",
            channelId: "channel-resumed",
            sequenceNumber: "2",
          },
        },
      });
    coreMocks.fetchPublicExternalUrl.mockImplementation(async () =>
      paymentRequiredResponse()
    );

    registerFetchTool(server as never, {
      apiBaseUrl: "https://x402.dexter.cash",
      metas: { fetch: {} } as never,
      wallet: null,
      getTabLane: () => tabLane,
      getPurchaseAttemptStore: () => store,
    });
    const args = {
      url: URL,
      method: "GET",
      maxAmountAtomic: "10000",
      purchase: preparedTab(),
    };
    const pending = await handlers.get("x402_fetch")!(args);
    const resumed = await handlers.get("x402_fetch")!(args);

    expect(pending.structuredContent).toMatchObject({
      status: 402,
      mode: "tab_pending",
      purchaseReceipt: {
        mode: "native_tab",
        dispatch: "not_dispatched",
        retry: "same_prepared_only",
      },
    });
    expect(resumed.structuredContent).toMatchObject({
      status: 200,
      data: { via: "resumed-tab" },
      purchaseReceipt: {
        mode: "native_tab",
        dispatch: "dispatched",
        retry: "none",
        voucher: {
          state: "accepted",
          channelId: "channel-resumed",
          sequenceNumber: "2",
        },
      },
    });
    expect(coreMocks.fetchPublicExternalUrl).toHaveBeenCalledTimes(2);
    expect(tabLane).toHaveBeenCalledTimes(2);
  });

  it("rejects a caller-synthesized prepared identity that check never persisted", () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-synthesized-"));
    const store = createPurchaseAttemptStore(directory);

    expect(store.begin(validated())).toEqual({
      acquired: false,
      state: "unknown",
      receipt: null,
    });
  });

  it("binds an approval resume to the first approved atomic ceiling", () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-ceiling-"));
    const store = createPurchaseAttemptStore(directory);
    store.prepare(preparedTab());
    const purchase = validated();
    expect(store.begin(purchase)).toEqual({ acquired: true });
    const waitingReceipt = receipt(purchase, {
      status: 402,
      mode: "tab_pending",
      connect_url: "https://dexter.cash/tab/approve",
      payment: { dispatched: false, settled: false },
    });
    store.complete(purchase, "awaiting_action", waitingReceipt);

    expect(store.begin({
      ...purchase,
      approvedAmountCeilingAtomic: "20000",
    })).toEqual({
      acquired: false,
      state: "awaiting_action",
      receipt: waitingReceipt,
    });
  });

  it("prunes only old untouched preparations and preserves terminal history", () => {
    directory = mkdtempSync(join(tmpdir(), "opendexter-purchase-prune-"));
    const store = createPurchaseAttemptStore(directory);
    const untouched = {
      ...preparedTab(),
      preparedId: "prepared-expired-tab",
    };
    const terminal = {
      ...preparedTab(),
      preparedId: "prepared-completed-tab",
    };
    store.prepare(untouched);
    store.prepare(terminal);
    const completed = validated(terminal);
    expect(store.begin(completed)).toEqual({ acquired: true });
    store.complete(
      completed,
      "completed",
      receipt(completed, {
        status: 200,
        payment: {
          rail: "tab",
          settled: "accrued_to_tab",
          incrementAtomic: "10000",
          cumulativeAtomic: "10000",
        },
      }),
    );

    const attemptDirectory = join(directory, "purchase-attempts-v1");
    for (const name of readdirSync(attemptDirectory).filter((entry) =>
      entry.endsWith(".json"),
    )) {
      const path = join(attemptDirectory, name);
      const record = JSON.parse(readFileSync(path, "utf8"));
      record.updatedAt = "2000-01-01T00:00:00.000Z";
      writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    }

    createPurchaseAttemptStore(directory).prepare({
      ...preparedTab(),
      preparedId: "prepared-fresh-tab",
    });
    const survivors = readdirSync(attemptDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        JSON.parse(readFileSync(join(attemptDirectory, entry), "utf8")),
      );
    expect(survivors.map((record) => record.preparedId).sort()).toEqual([
      "prepared-completed-tab",
      "prepared-fresh-tab",
    ]);
  });
});
