import { describe, expect, it, vi } from "vitest";

import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
} from "@dexterai/x402/tab";
import { createManagedFinalVoucherV2Reservation } from "../../x402-mcp-tools/src/native-tab-v2.js";

const DIGEST = "a".repeat(64);
const ROOT_OPERATION = `native-tab-open:${"b".repeat(64)}`;

function input(): FinalVoucherV2ReservationInput {
  return {
    network: "solana:mainnet",
    programId: "Program1111111111111111111111111111111111",
    buyerSwigAddress: "Buyer11111111111111111111111111111111111",
    vaultPda: "Vault11111111111111111111111111111111111",
    sessionPda: "Session111111111111111111111111111111111",
    seller: "Seller1111111111111111111111111111111111",
    channelId: "c".repeat(64),
    sessionNonce: 0x8000_002a,
    reservationAmountAtomic: "10000",
    previousCumulativeAtomic: "20000",
    voucherDigest: DIGEST,
    idempotencyKey: ROOT_OPERATION,
    voucher: {
      payload: {
        channelId: "c".repeat(64),
        cumulativeAmount: "30000",
        sequenceNumber: 0x8000_0001,
      },
      sessionPublicKey: new Uint8Array(32).fill(1),
      sessionSignature: new Uint8Array(64).fill(2),
      sessionRegistration: new Uint8Array(188).fill(3),
    },
  };
}

function receipt(overrides: Partial<FinalVoucherV2ReservationReceipt> = {}): FinalVoucherV2ReservationReceipt {
  return {
    contract: "dexter-native-tab-open-receipt/v2",
    operationId: "d".repeat(64),
    callerOperationId: ROOT_OPERATION,
    network: "solana:mainnet",
    transaction: "FINALIZED_TRANSACTION",
    commitment: "finalized",
    confirmationSlot: 100,
    postStateSlot: 101,
    buyerSwigAddress: input().buyerSwigAddress,
    vaultPda: input().vaultPda,
    sessionPda: input().sessionPda,
    seller: input().seller,
    channelId: input().channelId,
    sessionPublicKey: "01".repeat(32),
    voucherDigest: DIGEST,
    cumulativeAmountAtomic: "30000",
    sequenceNumber: 0x8000_0001,
    providerReceiptId: `opendexter:${DIGEST}`,
    reservationAmountAtomic: "10000",
    pendingVoucherCountBefore: 0,
    pendingVoucherCountAfter: 1,
    currentOutstandingBeforeAtomic: "0",
    currentOutstandingAfterAtomic: "10000",
    ...overrides,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("managed FINAL V2 reservation transport", () => {
  it("requires a server-only internal credential before constructing the provider", () => {
    expect(() => createManagedFinalVoucherV2Reservation({
      facilitatorUrl: "https://facilitator.example",
      internalToken: "   ",
    })).toThrow("native_tab_v2_internal_token_required");
  });

  it("posts the exact voucher identity, waits through provider recovery, and returns only finalized evidence", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init: init ?? {},
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return calls.length === 1
        ? json({ error: "lifecycle_pending", retry_after_ms: 5 }, 202)
        : json({ receipt: receipt() }, 200);
    }) as typeof fetch;
    const sleep = vi.fn(async () => {});
    let now = 1_000;
    const reserve = createManagedFinalVoucherV2Reservation({
      facilitatorUrl: "https://facilitator.example/",
      internalToken: "server-secret",
      fetchImpl,
      sleep,
      now: () => now++,
    });

    await expect(reserve(input())).resolves.toEqual(receipt());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
    expect(calls[0].url).toBe("https://facilitator.example/tab/open");
    expect(new Headers(calls[0].init.headers).get("x-internal-token"))
      .toBe("server-secret");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].body).toMatchObject({
      operation_id: ROOT_OPERATION,
      buyer_swig_address: input().buyerSwigAddress,
      vault_pda: input().vaultPda,
      seller: input().seller,
      channel_id: input().channelId,
      session_public_key: "01".repeat(32),
      session_signature: "02".repeat(64),
      session_registration: "03".repeat(188),
      voucher_digest: DIGEST,
      cumulative_amount_atomic: "30000",
      sequence_number: 0x8000_0001,
      provider_receipt_id: `opendexter:${DIGEST}`,
      reservation_amount_atomic: "10000",
      network: "solana:mainnet",
      mode: "lock",
    });
  });

  it("uses a provider-certified expired-unlanded release to derive one successor request", async () => {
    const lifecycleOperationId = "e".repeat(64);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const release = {
      contract: "dexter-native-tab-open-release/v1",
      rootOperationId: ROOT_OPERATION,
      predecessorCallerOperationId: ROOT_OPERATION,
      predecessorLifecycleOperationId: lifecycleOperationId,
      voucherDigest: DIGEST,
      state: "expired_unlanded",
      reservationDisposition: "released",
      generation: 1,
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return calls.length === 1
        ? json({
            error: "tab_open_expired_unlanded",
            lifecycle: { operationId: lifecycleOperationId },
            release,
          }, 409)
        : json({ receipt: receipt({
            rootOperationId: ROOT_OPERATION,
            generation: 2,
            predecessorCallerOperationId: ROOT_OPERATION,
            predecessorLifecycleOperationId: lifecycleOperationId,
          }) }, 200);
    }) as typeof fetch;
    let now = 5_000;
    const reserve = createManagedFinalVoucherV2Reservation({
      facilitatorUrl: "https://facilitator.example",
      internalToken: "server-secret",
      fetchImpl,
      sleep: async () => {},
      now: () => now++,
    });

    await reserve(input());
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://facilitator.example/tab/open/successor");
    expect(calls[1].body).toMatchObject({
      root_operation_id: ROOT_OPERATION,
      generation: 2,
      predecessor_caller_operation_id: ROOT_OPERATION,
      predecessor_lifecycle_operation_id: lifecycleOperationId,
      predecessor_release: release,
    });
    expect(String(calls[1].body.operation_id)).toMatch(/^native-tab-open:[0-9a-f]{64}$/);
    expect(String(calls[1].body.predecessor_release_digest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a provider receipt that has not reached finalized commitment", async () => {
    const reserve = createManagedFinalVoucherV2Reservation({
      facilitatorUrl: "https://facilitator.example",
      internalToken: "server-secret",
      fetchImpl: (async () => json({
        receipt: receipt({ commitment: "confirmed" as "finalized" }),
      }, 200)) as typeof fetch,
    });
    await expect(reserve(input())).rejects.toThrow(
      "native_tab_v2_provider_receipt_not_finalized",
    );
  });
});
