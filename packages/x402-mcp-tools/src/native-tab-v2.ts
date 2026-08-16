import { createHash } from "node:crypto";

import type {
  FinalVoucherV2ReservationInput,
  FinalVoucherV2ReservationReceipt,
  ReserveFinalVoucherV2,
} from "@dexterai/x402/tab";

type JsonRecord = Record<string, unknown>;

interface TabOpenResponse {
  receipt?: FinalVoucherV2ReservationReceipt;
  error?: string;
  retry_after_ms?: number;
  lifecycle?: JsonRecord;
  release?: JsonRecord;
}

export interface ManagedFinalVoucherV2ReservationOptions {
  /** Server-side Dexter facilitator origin. Never put the internal token in a browser. */
  facilitatorUrl: string;
  /** Credential for the facilitator's money-moving `/tab/open` boundary. */
  internalToken: string;
  /** Test/server transport seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overall lifecycle deadline, including confirmed readback retries. */
  timeoutMs?: number;
  /** Maximum duration of one HTTP attempt. */
  requestTimeoutMs?: number;
  /** Test seams for deterministic retry coverage. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Durable provider receipt identity. Defaults to the exact voucher digest. */
  providerReceiptId?: (input: FinalVoucherV2ReservationInput) => string;
}

const HEX_32 = /^[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_non_finite_number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  throw new Error("canonical_value_unsupported");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function successorCallerOperationId(input: {
  rootOperationId: string;
  generation: number;
  predecessorLifecycleOperationId: string;
}): string {
  return `native-tab-open:${sha256([
    "dexter-native-tab-open-generation/v1",
    input.rootOperationId,
    String(input.generation),
    input.predecessorLifecycleOperationId,
  ].join("\0"))}`;
}

function retryDelay(payload: TabOpenResponse): number {
  return Number.isSafeInteger(payload.retry_after_ms) && payload.retry_after_ms! > 0
    ? Math.min(payload.retry_after_ms!, 5_000)
    : 1_000;
}

function buildSuccessorRequest(input: {
  rootOperationId: string;
  commonRequest: JsonRecord;
  currentRequest: JsonRecord;
  voucherDigest: string;
  payload: TabOpenResponse;
}): JsonRecord {
  const release = input.payload.release;
  const lifecycleOperationId = input.payload.lifecycle?.operationId;
  const predecessorCallerOperationId = input.currentRequest.operation_id;
  const currentGeneration = input.currentRequest.generation ?? 1;
  if (
    !release
    || release.contract !== "dexter-native-tab-open-release/v1"
    || release.rootOperationId !== input.rootOperationId
    || release.predecessorCallerOperationId !== predecessorCallerOperationId
    || release.predecessorLifecycleOperationId !== lifecycleOperationId
    || release.voucherDigest !== input.voucherDigest
    || release.state !== "expired_unlanded"
    || release.reservationDisposition !== "released"
    || typeof lifecycleOperationId !== "string"
    || !HEX_32.test(lifecycleOperationId)
    || typeof predecessorCallerOperationId !== "string"
    || !Number.isSafeInteger(release.generation)
    || release.generation !== currentGeneration
  ) {
    throw new Error("native_tab_v2_invalid_release_certificate");
  }
  const generation = Number(release.generation) + 1;
  if (generation < 2 || generation > 0x7fff_ffff) {
    throw new Error("native_tab_v2_invalid_successor_generation");
  }
  return {
    ...input.commonRequest,
    operation_id: successorCallerOperationId({
      rootOperationId: input.rootOperationId,
      generation,
      predecessorLifecycleOperationId: lifecycleOperationId,
    }),
    root_operation_id: input.rootOperationId,
    generation,
    predecessor_caller_operation_id: predecessorCallerOperationId,
    predecessor_lifecycle_operation_id: lifecycleOperationId,
    predecessor_release: release,
    predecessor_release_digest: canonicalHash(release),
  };
}

async function responsePayload(response: Response): Promise<TabOpenResponse> {
  try {
    const parsed = await response.json();
    return parsed && typeof parsed === "object"
      ? parsed as TabOpenResponse
      : { error: "invalid_json_body" };
  } catch {
    return { error: "invalid_json_body" };
  }
}

/**
 * Build the server-side provider callback required by x402 v6 grant tabs.
 *
 * This function obtains a provider receipt; it does not declare that receipt
 * true. `tabFromGrant` validates the receipt fields and then independently
 * reads the Solana transaction and post-state at least at `confirmed` through
 * its own `Connection` before `signNextVoucher` can return the FINAL voucher.
 */
export function createManagedFinalVoucherV2Reservation(
  options: ManagedFinalVoucherV2ReservationOptions,
): ReserveFinalVoucherV2 {
  const baseUrl = options.facilitatorUrl.replace(/\/$/, "");
  const internalToken = options.internalToken.trim();
  if (!baseUrl) throw new Error("native_tab_v2_facilitator_url_required");
  if (!internalToken) throw new Error("native_tab_v2_internal_token_required");

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("native_tab_v2_timeout_invalid");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("native_tab_v2_request_timeout_invalid");
  }

  return async (input: FinalVoucherV2ReservationInput) => {
    const providerReceiptId = (
      options.providerReceiptId?.(input) ?? `opendexter:${input.voucherDigest}`
    ).trim();
    if (
      providerReceiptId.length < 1
      || providerReceiptId.length > 200
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(providerReceiptId)
    ) {
      throw new Error("native_tab_v2_provider_receipt_id_invalid");
    }

    const commonRequest: JsonRecord = {
      buyer_swig_address: input.buyerSwigAddress,
      vault_pda: input.vaultPda,
      seller: input.seller,
      channel_id: input.channelId,
      session_public_key: hex(input.voucher.sessionPublicKey),
      session_signature: hex(input.voucher.sessionSignature),
      session_registration: hex(input.voucher.sessionRegistration),
      voucher_digest: input.voucherDigest,
      cumulative_amount_atomic: input.voucher.payload.cumulativeAmount,
      sequence_number: input.voucher.payload.sequenceNumber,
      provider_receipt_id: providerReceiptId,
      reservation_amount_atomic: input.reservationAmountAtomic,
      network: input.network,
      mode: "lock",
    };
    const rootOperationId = input.idempotencyKey;
    let request: JsonRecord = {
      ...commonRequest,
      operation_id: rootOperationId,
    };
    let endpoint = `${baseUrl}/tab/open`;
    const deadline = now() + timeoutMs;

    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("native_tab_v2_reservation_deadline_exceeded");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        // Never forward the internal actuator credential through a redirect.
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-internal-token": internalToken,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
      });
      const payload = await responsePayload(response);
      if (response.ok && payload.receipt) {
        if (
          payload.receipt.commitment !== "confirmed"
          && payload.receipt.commitment !== "finalized"
        ) {
          throw new Error("native_tab_v2_provider_receipt_commitment_invalid");
        }
        return payload.receipt;
      }
      if ((response.status === 202 || response.status === 503) && now() < deadline) {
        await sleep(Math.min(retryDelay(payload), Math.max(0, deadline - now())));
        continue;
      }
      if (
        response.status === 409
        && payload.error === "tab_open_expired_unlanded"
        && now() < deadline
      ) {
        request = buildSuccessorRequest({
          rootOperationId,
          commonRequest,
          currentRequest: request,
          voucherDigest: input.voucherDigest,
          payload,
        });
        endpoint = `${baseUrl}/tab/open/successor`;
        continue;
      }
      throw new Error(
        `native_tab_v2_reservation_failed:${response.status}:${payload.error ?? "unknown_error"}`,
      );
    }
  };
}
