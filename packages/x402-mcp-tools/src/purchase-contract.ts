import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sellerAcceptSha256 as coreSellerAcceptSha256 } from "@dexterai/x402-core";

export const PURCHASE_CONTRACT_VERSION = "opendexter.purchase.v1" as const;
export const PURCHASE_MODES = [
  "direct_exact",
  "native_tab",
  "gateway_cash",
  "gateway_credit",
] as const;

export type PurchaseMode = (typeof PURCHASE_MODES)[number];
export type AtomicAmount = string;

export interface SellerOfferV1 {
  offerId: string;
  x402Version: 1 | 2;
  scheme: string;
  network: string;
  asset: string;
  amountAtomic: AtomicAmount;
  payTo: string;
  facilitator: string | null;
  expiresAt: string | null;
  rawAcceptSha256: string;
}

export interface PurchaseRouteV1 {
  routeId: string;
  resourceUrl: string;
  resolvedUrl: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  payloadSha256: string;
  sellerOffer: SellerOfferV1;
}

export interface PreparedPurchaseV1 {
  contractVersion: typeof PURCHASE_CONTRACT_VERSION;
  preparedId: string;
  state: "prepared";
  preparedAt: string;
  expiresAt: string | null;
  mode: PurchaseMode;
  route: PurchaseRouteV1;
}

export interface ValidatedPurchaseV1 {
  contractVersion: typeof PURCHASE_CONTRACT_VERSION;
  preparedId: string;
  mode: PurchaseMode;
  route: PurchaseRouteV1;
  approvedAmountCeilingAtomic: AtomicAmount;
}

export type PurchaseAvailability =
  | { state: "ready"; reason: null }
  | {
      state: "integration_required" | "request_required" | "unavailable";
      reason: string;
    };

export interface PreparedPurchaseOptionV1 {
  mode: PurchaseMode;
  availability: PurchaseAvailability;
  display: {
    price: number | null;
    priceFormatted: string | null;
  };
  preparedPurchase: PreparedPurchaseV1;
}

export interface ReceiptBaseV1 {
  contractVersion: typeof PURCHASE_CONTRACT_VERSION;
  receiptId: string;
  preparedId: string;
  routeId: string;
  sellerOfferId: string;
  mode: PurchaseMode;
  dispatch: "not_dispatched" | "dispatched" | "unknown";
  retry:
    | "same_prepared_only"
    | "new_prepare_required"
    | "integration_required"
    | "reconcile_only"
    | "none";
  correlationId: string | null;
  approvedAmountCeilingAtomic: AtomicAmount;
  reason?: string;
}

export interface SellerSettlementV1 {
  state: "not_dispatched" | "settled" | "unconfirmed";
  amountAtomic: AtomicAmount;
  network: string;
  asset: string;
  transaction: string | null;
}

export type PurchaseReceiptV1 =
  | (ReceiptBaseV1 & {
      mode: "direct_exact";
      sellerSettlement: SellerSettlementV1;
    })
  | (ReceiptBaseV1 & {
      mode: "native_tab";
      voucher: {
        state: "not_issued" | "refused" | "accepted" | "unconfirmed";
        incrementAtomic: AtomicAmount | null;
        cumulativeAtomic: AtomicAmount | null;
        channelId: string | null;
        sequenceNumber: string | null;
      };
      sellerCashSettlement: "not_settled" | "settled" | "unconfirmed";
    })
  | (ReceiptBaseV1 & {
      mode: "gateway_cash";
      buyerCash: {
        state:
          | "not_committed"
          | "reserved"
          | "charged"
          | "charge_unconfirmed"
          | "refund_pending"
          | "refunded";
      };
      sellerSettlement: SellerSettlementV1;
    })
  | (ReceiptBaseV1 & {
      mode: "gateway_credit";
      exposure: {
        state: "not_reserved" | "reserved" | "released" | "unconfirmed";
      };
      buyerObligation: {
        state: "not_finalized" | "finalized" | "reversed" | "unconfirmed";
        claimId: string | null;
      };
      sellerSettlement: SellerSettlementV1;
    });

export type PurchaseAttemptStateV1 =
  | "claimed"
  | "awaiting_action"
  | "failed_pre_dispatch"
  | "dispatching"
  | "reconciliation_required"
  | "completed";

export type PurchaseAttemptClaimV1 =
  | { acquired: true }
  | {
      acquired: false;
      state: PurchaseAttemptStateV1 | "unknown";
      receipt: PurchaseReceiptV1 | null;
    };

/**
 * Storage-owned idempotency seam. x402-mcp-tools never chooses an in-memory
 * fallback: a consumer must durably claim a prepared identity before an
 * explicit Direct Exact or Native Tab adapter can run.
 */
export interface PurchaseAttemptStoreV1 {
  begin(purchase: ValidatedPurchaseV1): PurchaseAttemptClaimV1;
  markDispatching(purchase: ValidatedPurchaseV1): void;
  complete(
    purchase: ValidatedPurchaseV1,
    state: Exclude<PurchaseAttemptStateV1, "claimed" | "dispatching">,
    receipt: PurchaseReceiptV1,
  ): void;
}

type UnknownRecord = Record<string, unknown>;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const POSITIVE_ATOMIC_RE = /^[1-9]\d*$/;
const APPROVED_CEILING_RE = /^[1-9]\d{0,19}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PREPARED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

export const preparedPurchaseSchema = z.object({
  contractVersion: z.literal(PURCHASE_CONTRACT_VERSION),
  preparedId: z.string().min(8).max(128),
  state: z.literal("prepared"),
  preparedAt: z.string(),
  expiresAt: z.string().nullable(),
  mode: z.enum(PURCHASE_MODES),
  route: z.object({
    routeId: z.string().min(8),
    resourceUrl: z.string().url(),
    resolvedUrl: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    payloadSha256: z.string().regex(SHA256_RE),
    sellerOffer: z.object({
      offerId: z.string().min(8),
      x402Version: z.union([z.literal(1), z.literal(2)]),
      scheme: z.string().min(1),
      network: z.string().min(1),
      asset: z.string().min(1),
      amountAtomic: z.string().regex(POSITIVE_ATOMIC_RE),
      payTo: z.string().min(1),
      facilitator: z.string().nullable(),
      expiresAt: z.string().nullable(),
      rawAcceptSha256: z.string().regex(SHA256_RE),
    }),
  }),
});

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : nonEmptyString(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as UnknownRecord;
  const keys = Object.keys(object).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function purchasePayloadSha256(payload: unknown): string {
  return sha256(payload == null ? "" : String(payload));
}

function identifier(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(canonicalJson(value))}`;
}

export function sellerAcceptSha256(value: unknown): string | null {
  return coreSellerAcceptSha256(value);
}

function offerSchemeForMode(mode: PurchaseMode): "tab" | "exact" {
  return mode === "native_tab" ? "tab" : "exact";
}

function normalizeVersion(value: unknown): 1 | 2 | null {
  return value === 1 ? 1 : value === 2 ? 2 : null;
}

function normalizeOffer(option: unknown, x402Version: unknown): SellerOfferV1 | null {
  if (!isRecord(option)) return null;
  const scheme = nonEmptyString(option.scheme);
  const network = nonEmptyString(option.network);
  const asset = nonEmptyString(option.asset);
  const amountAtomic = nonEmptyString(option.amountAtomic);
  const payTo = nonEmptyString(option.payTo);
  const rawAcceptSha256 = nonEmptyString(option.rawAcceptSha256);
  const version = normalizeVersion(x402Version);
  if (
    !scheme ||
    !network ||
    !asset ||
    !amountAtomic ||
    !POSITIVE_ATOMIC_RE.test(amountAtomic) ||
    !payTo ||
    !version ||
    !rawAcceptSha256 ||
    !SHA256_RE.test(rawAcceptSha256)
  ) {
    return null;
  }
  const base = {
    x402Version: version,
    scheme,
    network,
    asset,
    amountAtomic,
    payTo,
    facilitator: nullableString(option.facilitator),
    expiresAt: nullableString(option.expiresAt),
    rawAcceptSha256,
  };
  return { offerId: identifier("offer", base), ...base };
}

function availabilityFor(
  mode: PurchaseMode,
  surface: "hosted" | "local",
  offer: SellerOfferV1,
): PurchaseAvailability {
  if (offerSchemeForMode(mode) !== offer.scheme) {
    return {
      state: "unavailable",
      reason: `seller_does_not_offer_${offerSchemeForMode(mode)}`,
    };
  }
  const solana = offer.network.startsWith("solana");
  if (mode === "direct_exact") {
    if (surface === "hosted" && !solana) {
      return {
        state: "unavailable",
        reason: "hosted_direct_network_not_supported",
      };
    }
    if (surface === "hosted") {
      return {
        state: "integration_required",
        reason: "hosted_direct_exact_contract_required",
      };
    }
    return { state: "ready", reason: null };
  }
  if (mode === "native_tab" && !solana) {
    return {
      state: "unavailable",
      reason: "native_tab_network_not_supported",
    };
  }
  if (mode === "native_tab" && surface === "local") {
    return { state: "ready", reason: null };
  }
  if (mode === "native_tab") {
    return {
      state: "integration_required",
      reason: "hosted_native_tab_adapter_required",
    };
  }
  return {
    state: "integration_required",
    reason:
      mode === "gateway_cash"
        ? "gateway_cash_adapter_required"
        : "gateway_credit_adapter_required",
  };
}

export function buildPurchaseOptions(input: {
  checkResult: unknown;
  url: string;
  method?: string;
  payload?: string | null;
  requestBound?: boolean;
  surface?: "hosted" | "local";
  now?: () => Date;
  idFactory?: () => string;
}): PreparedPurchaseOptionV1[] {
  const {
    checkResult,
    url,
    method = "GET",
    payload = null,
    requestBound = true,
    surface = "local",
    now = () => new Date(),
    idFactory = randomUUID,
  } = input;
  if (!isRecord(checkResult) || checkResult.requiresPayment !== true) return [];
  const canonicalMethod = String(method || "GET").toUpperCase();
  if (!HTTP_METHODS.has(canonicalMethod)) return [];
  const resourceUrl = nonEmptyString(url);
  const x402Version = normalizeVersion(checkResult.x402Version);
  if (!resourceUrl || !x402Version) return [];
  const options = Array.isArray(checkResult.paymentOptions)
    ? checkResult.paymentOptions
    : [];
  const preparedAt = now().toISOString();
  const resolvedUrl =
    nonEmptyString(checkResult.resolvedUrl) ?? resourceUrl;
  const payloadDigest = purchasePayloadSha256(payload);
  const out: PreparedPurchaseOptionV1[] = [];

  for (const option of options) {
    const sellerOffer = normalizeOffer(option, x402Version);
    if (!sellerOffer) continue;
    const routeBase = {
      resourceUrl,
      resolvedUrl,
      method: canonicalMethod,
      payloadSha256: payloadDigest,
      sellerOfferId: sellerOffer.offerId,
    };
    const route: PurchaseRouteV1 = {
      routeId: identifier("route", routeBase),
      resourceUrl,
      resolvedUrl,
      method: canonicalMethod as PurchaseRouteV1["method"],
      payloadSha256: payloadDigest,
      sellerOffer,
    };
    for (const mode of PURCHASE_MODES) {
      if (offerSchemeForMode(mode) !== sellerOffer.scheme) continue;
      const availability = requestBound
        ? availabilityFor(mode, surface, sellerOffer)
        : {
            state: "request_required" as const,
            reason: "exact_request_body_must_be_priced",
          };
      out.push({
        mode,
        availability,
        display: {
          price:
            typeof (option as UnknownRecord).price === "number" &&
            Number.isFinite((option as UnknownRecord).price)
              ? ((option as UnknownRecord).price as number)
              : null,
          priceFormatted: nullableString(
            (option as UnknownRecord).priceFormatted,
          ),
        },
        preparedPurchase: {
          contractVersion: PURCHASE_CONTRACT_VERSION,
          preparedId: idFactory(),
          state: "prepared",
          preparedAt,
          expiresAt: sellerOffer.expiresAt,
          mode,
          route,
        },
      });
    }
  }
  return out;
}

type ValidationResult =
  | { ok: true; value: ValidatedPurchaseV1 }
  | { ok: false; code: string; message: string };

function validationError(code: string, message: string): ValidationResult {
  return { ok: false, code, message };
}

export function validatePurchaseExecution(input: {
  purchase: unknown;
  url: string;
  method?: string;
  payload?: string | null;
  approvedAmountCeilingAtomic: string;
  allowedModes?: readonly PurchaseMode[];
  now?: () => Date;
}): ValidationResult {
  const {
    purchase,
    url,
    method = "GET",
    payload = null,
    approvedAmountCeilingAtomic,
    allowedModes = PURCHASE_MODES,
    now = () => new Date(),
  } = input;
  const parsed = preparedPurchaseSchema.safeParse(purchase);
  if (!parsed.success) {
    return validationError(
      "prepared_purchase_invalid",
      "A valid prepared purchase from x402_check is required.",
    );
  }
  const prepared = parsed.data as PreparedPurchaseV1;
  if (!PREPARED_ID_RE.test(prepared.preparedId)) {
    return validationError("prepared_id_invalid", "The prepared purchase identity is malformed.");
  }
  if (!allowedModes.includes(prepared.mode)) {
    return validationError(
      "purchase_mode_integration_required",
      `${prepared.mode} is not connected on this surface yet. Nothing was dispatched.`,
    );
  }
  if (offerSchemeForMode(prepared.mode) !== prepared.route.sellerOffer.scheme) {
    return validationError(
      "purchase_mode_offer_mismatch",
      `${prepared.mode} cannot execute a seller ${prepared.route.sellerOffer.scheme} offer.`,
    );
  }
  const canonicalMethod = String(method || "GET").toUpperCase();
  if (
    prepared.route.resourceUrl !== url
    || !nonEmptyString(prepared.route.resolvedUrl)
    || prepared.route.method !== canonicalMethod
  ) {
    return validationError("purchase_request_mismatch", "The URL or method changed after pricing.");
  }
  if (prepared.route.payloadSha256 !== purchasePayloadSha256(payload)) {
    return validationError("purchase_payload_mismatch", "The request body changed after pricing.");
  }
  const ceiling = nonEmptyString(approvedAmountCeilingAtomic);
  const amount = prepared.route.sellerOffer.amountAtomic;
  if (!ceiling || !APPROVED_CEILING_RE.test(ceiling)) {
    return validationError("purchase_ceiling_invalid", "The approved ceiling is invalid.");
  }
  if (BigInt(amount) > BigInt(ceiling)) {
    return validationError("purchase_ceiling_exceeded", "The seller amount exceeds the approved ceiling.");
  }
  const normalizedOffer = normalizeOffer(
    prepared.route.sellerOffer,
    prepared.route.sellerOffer.x402Version,
  );
  if (!normalizedOffer || normalizedOffer.offerId !== prepared.route.sellerOffer.offerId) {
    return validationError("seller_offer_identity_mismatch", "The seller offer identity changed.");
  }
  const routeBase = {
    resourceUrl: prepared.route.resourceUrl,
    resolvedUrl: prepared.route.resolvedUrl,
    method: prepared.route.method,
    payloadSha256: prepared.route.payloadSha256,
    sellerOfferId: prepared.route.sellerOffer.offerId,
  };
  if (identifier("route", routeBase) !== prepared.route.routeId) {
    return validationError("purchase_route_identity_mismatch", "The purchase route identity changed.");
  }
  if (prepared.expiresAt !== prepared.route.sellerOffer.expiresAt) {
    return validationError(
      "purchase_expiry_mismatch",
      "The prepared expiry changed after pricing.",
    );
  }
  if (prepared.expiresAt) {
    const expiry = Date.parse(prepared.expiresAt);
    if (!Number.isFinite(expiry)) {
      return validationError("purchase_expiry_invalid", "The prepared purchase expiry is invalid.");
    }
    if (now().getTime() >= expiry) {
      return validationError(
        "prepared_purchase_expired",
        "The prepared purchase expired; check current terms again.",
      );
    }
  }
  return {
    ok: true,
    value: {
      contractVersion: PURCHASE_CONTRACT_VERSION,
      preparedId: prepared.preparedId,
      mode: prepared.mode,
      route: prepared.route,
      approvedAmountCeilingAtomic: ceiling,
    },
  };
}

export function sellerOfferMatches(
  selected: SellerOfferV1,
  candidate: unknown,
): boolean {
  if (!isRecord(candidate)) return false;
  return sellerAcceptSha256(candidate) === selected.rawAcceptSha256;
}

function receiptBase(
  purchase: ValidatedPurchaseV1,
  input: Partial<Pick<ReceiptBaseV1, "dispatch" | "retry" | "correlationId">> = {},
): ReceiptBaseV1 {
  return {
    contractVersion: PURCHASE_CONTRACT_VERSION,
    receiptId: randomUUID(),
    preparedId: purchase.preparedId,
    routeId: purchase.route.routeId,
    sellerOfferId: purchase.route.sellerOffer.offerId,
    mode: purchase.mode,
    dispatch: input.dispatch ?? "not_dispatched",
    retry: input.retry ?? "new_prepare_required",
    correlationId: input.correlationId ?? null,
    approvedAmountCeilingAtomic: purchase.approvedAmountCeilingAtomic,
  };
}

function sellerSettlement(
  purchase: ValidatedPurchaseV1,
  state: SellerSettlementV1["state"],
  transaction: string | null = null,
): SellerSettlementV1 {
  return {
    state,
    amountAtomic: purchase.route.sellerOffer.amountAtomic,
    network: purchase.route.sellerOffer.network,
    asset: purchase.route.sellerOffer.asset,
    transaction,
  };
}

export function buildUnavailablePurchaseReceipt(
  purchase: ValidatedPurchaseV1,
  reason: string,
  retry: ReceiptBaseV1["retry"] = "new_prepare_required",
): PurchaseReceiptV1 {
  const base = { ...receiptBase(purchase, { retry }), reason };
  if (purchase.mode === "native_tab") {
    return {
      ...base,
      mode: "native_tab",
      voucher: {
        state: "not_issued",
        incrementAtomic: null,
        cumulativeAtomic: null,
        channelId: null,
        sequenceNumber: null,
      },
      sellerCashSettlement: "not_settled",
    };
  }
  if (purchase.mode === "gateway_cash") {
    return {
      ...base,
      mode: "gateway_cash",
      buyerCash: { state: "not_committed" },
      sellerSettlement: sellerSettlement(purchase, "not_dispatched"),
    };
  }
  if (purchase.mode === "gateway_credit") {
    return {
      ...base,
      mode: "gateway_credit",
      exposure: { state: "not_reserved" },
      buyerObligation: { state: "not_finalized", claimId: null },
      sellerSettlement: sellerSettlement(purchase, "not_dispatched"),
    };
  }
  return {
    ...base,
    mode: "direct_exact",
    sellerSettlement: sellerSettlement(purchase, "not_dispatched"),
  };
}

function text(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return nonEmptyString(value);
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

function gatewayDispatch(payment: UnknownRecord): ReceiptBaseV1["dispatch"] {
  if (payment.dispatched === false) return "not_dispatched";
  if (payment.dispatched === true) return "dispatched";
  return "unknown";
}

export function attachPurchaseReceipt(
  result: Record<string, unknown>,
  purchase: ValidatedPurchaseV1,
): Record<string, unknown> {
  const payment = isRecord(result.payment) ? result.payment : {};
  if (purchase.mode === "gateway_cash") {
    const dispatch = gatewayDispatch(payment);
    const cash = record(payment.buyerCash);
    const settlement = record(payment.sellerSettlement);
    const buyerCashState = oneOf(
      cash.state,
      [
        "not_committed",
        "reserved",
        "charged",
        "charge_unconfirmed",
        "refund_pending",
        "refunded",
      ] as const,
      dispatch === "not_dispatched" ? "not_committed" : "charge_unconfirmed",
    );
    const settlementState = oneOf(
      settlement.state,
      ["not_dispatched", "settled", "unconfirmed"] as const,
      dispatch === "not_dispatched" ? "not_dispatched" : "unconfirmed",
    );
    const terminalFacts =
      buyerCashState === "charged" && settlementState === "settled";
    const untouchedFacts =
      buyerCashState === "not_committed"
      && settlementState === "not_dispatched";
    const completed = dispatch === "dispatched" && terminalFacts;
    const receipt: PurchaseReceiptV1 = {
      ...receiptBase(purchase, {
        dispatch,
        retry: completed
          ? "none"
          : dispatch === "not_dispatched" && untouchedFacts
            ? "new_prepare_required"
            : "reconcile_only",
        correlationId: text(payment.correlationId),
      }),
      mode: "gateway_cash",
      buyerCash: { state: buyerCashState },
      sellerSettlement: sellerSettlement(
        purchase,
        settlementState,
        text(settlement.transaction),
      ),
    };
    return {
      ...result,
      ...(dispatch === "not_dispatched" ? {} : { retryable: false }),
      purchaseReceipt: receipt,
    };
  }

  if (purchase.mode === "gateway_credit") {
    const dispatch = gatewayDispatch(payment);
    const exposure = record(payment.exposure);
    const obligation = record(payment.buyerObligation);
    const settlement = record(payment.sellerSettlement);
    const exposureState = oneOf(
      exposure.state,
      ["not_reserved", "reserved", "released", "unconfirmed"] as const,
      dispatch === "not_dispatched" ? "not_reserved" : "unconfirmed",
    );
    const obligationState = oneOf(
      obligation.state,
      ["not_finalized", "finalized", "reversed", "unconfirmed"] as const,
      dispatch === "not_dispatched" ? "not_finalized" : "unconfirmed",
    );
    const settlementState = oneOf(
      settlement.state,
      ["not_dispatched", "settled", "unconfirmed"] as const,
      dispatch === "not_dispatched" ? "not_dispatched" : "unconfirmed",
    );
    const terminalFacts =
      obligationState === "finalized" && settlementState === "settled";
    const untouchedFacts =
      exposureState === "not_reserved"
      && obligationState === "not_finalized"
      && settlementState === "not_dispatched";
    const completed = dispatch === "dispatched" && terminalFacts;
    const receipt: PurchaseReceiptV1 = {
      ...receiptBase(purchase, {
        dispatch,
        retry: completed
          ? "none"
          : dispatch === "not_dispatched" && untouchedFacts
            ? "new_prepare_required"
            : "reconcile_only",
        correlationId: text(payment.correlationId),
      }),
      mode: "gateway_credit",
      exposure: { state: exposureState },
      buyerObligation: {
        state: obligationState,
        claimId: text(obligation.claimId),
      },
      sellerSettlement: sellerSettlement(
        purchase,
        settlementState,
        text(settlement.transaction),
      ),
    };
    return {
      ...result,
      ...(dispatch === "not_dispatched" ? {} : { retryable: false }),
      purchaseReceipt: receipt,
    };
  }

  if (purchase.mode === "native_tab") {
    const tab = isRecord(result.tab) ? result.tab : {};
    const refused = tab.refused === true;
    const tabAccepted =
      (payment.rail === "tab" &&
        (payment.settled === "accrued_to_tab" || payment.settled === false)) ||
      tab.used === true;
    const uncertain =
      payment.settled === "unknown" ||
      payment.settled === "unconfirmed" ||
      String(result.error ?? "").toLowerCase().includes("unconfirmed") ||
      String(result.error ?? "").toLowerCase().includes("dispatched");
    const dispatch =
      tabAccepted || refused ? "dispatched" : uncertain ? "unknown" : "not_dispatched";
    const waitingForSamePrepared =
      dispatch === "not_dispatched" &&
      (
        result.mode === "tab_available" ||
        result.mode === "tab_pending" ||
        typeof result.connect_url === "string"
      );
    const retry = tabAccepted
      ? "none"
      : waitingForSamePrepared
        ? "same_prepared_only"
        : dispatch === "not_dispatched"
          ? "new_prepare_required"
          : "reconcile_only";
    const receipt: PurchaseReceiptV1 = {
      ...receiptBase(purchase, { dispatch, retry }),
      mode: "native_tab",
      voucher: {
        state: tabAccepted
          ? "accepted"
          : refused
            ? "refused"
            : uncertain
              ? "unconfirmed"
              : "not_issued",
        incrementAtomic: text(payment.incrementAtomic),
        cumulativeAtomic: text(payment.cumulativeAtomic ?? tab.cumulativeAtomic),
        channelId: text(payment.channelId),
        sequenceNumber: text(payment.sequenceNumber),
      },
      sellerCashSettlement:
        payment.cashSettled === true
          ? "settled"
          : uncertain
            ? "unconfirmed"
            : "not_settled",
    };
    return {
      ...result,
      ...(dispatch === "not_dispatched" ? {} : { retryable: false }),
      purchaseReceipt: receipt,
    };
  }

  const settled = payment.settled === true;
  const uncertain =
    payment.settled === "unknown" ||
    payment.settled === "unconfirmed" ||
    payment.retrySafe === false ||
    String(result.error ?? "").toLowerCase().includes("unconfirmed");
  const dispatch = settled ? "dispatched" : uncertain ? "unknown" : "not_dispatched";
  const retry = settled
    ? "none"
    : dispatch === "not_dispatched"
      ? "new_prepare_required"
      : "reconcile_only";
  const details = isRecord(payment.details) ? payment.details : {};
  const receipt: PurchaseReceiptV1 = {
    ...receiptBase(purchase, { dispatch, retry }),
    mode: "direct_exact",
    sellerSettlement: sellerSettlement(
      purchase,
      settled ? "settled" : uncertain ? "unconfirmed" : "not_dispatched",
      text(details.transaction),
    ),
  };
  return {
    ...result,
    ...(dispatch === "not_dispatched" ? {} : { retryable: false }),
    purchaseReceipt: receipt,
  };
}

export function buildPurchaseIntegrationRequired(
  purchase: ValidatedPurchaseV1,
  reason: string,
): Record<string, unknown> {
  return {
    status: 501,
    mode: "purchase_mode_integration_required",
    phase: "pre_dispatch",
    retryable: false,
    error: reason,
    message: `${purchase.mode} is not connected on this surface yet. Nothing was dispatched.`,
    payment: { dispatched: false, settled: false },
    purchaseReceipt: buildUnavailablePurchaseReceipt(
      purchase,
      reason,
      "integration_required",
    ),
  };
}
