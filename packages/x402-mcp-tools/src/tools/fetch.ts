import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  fetchPublicExternalUrl,
  parsePaymentRequiredHeader,
  UnsafeExternalUrlError,
} from "@dexterai/x402-core";
import type { FetchToolOpts, TabLaneHook, TabOfferMaterials } from "../types.js";
import type { WalletAdapter } from "../wallet-adapter.js";
import {
  PURCHASE_MODES,
  preparedPurchaseSchema,
  attachPurchaseReceipt,
  buildPurchaseIntegrationRequired,
  sellerOfferMatches,
  validatePurchaseExecution,
  type PreparedPurchaseV1,
  type PurchaseAttemptStateV1,
  type PurchaseAttemptStoreV1,
  type PurchaseReceiptV1,
  type ValidatedPurchaseV1,
} from "../purchase-contract.js";

const MULTIPART_MAX_BYTES = 200 * 1024 * 1024;

interface MultipartInput {
  fields?: Record<string, string>;
  files?: Array<{
    fieldName: string;
    path: string;
    filename?: string;
    contentType?: string;
  }>;
}

/**
 * Build a FormData from a multipart descriptor. Reads each file from disk
 * into memory. Throws with a stable error code on validation failures so the
 * caller can surface them without leaking paths.
 */
async function buildMultipartFormData(multipart: MultipartInput): Promise<FormData> {
  const form = new FormData();
  for (const [k, v] of Object.entries(multipart.fields || {})) {
    form.append(k, String(v));
  }
  let total = 0;
  for (const f of multipart.files || []) {
    if (!f || !f.fieldName || !f.path) {
      throw new Error("multipart_file_missing_fieldName_or_path");
    }
    const info = await stat(f.path);
    if (!info.isFile()) {
      throw new Error(`multipart_file_not_found: ${f.path}`);
    }
    total += info.size;
    if (total > MULTIPART_MAX_BYTES) {
      throw new Error(`multipart_payload_exceeds_${MULTIPART_MAX_BYTES}_bytes`);
    }
    const data = await readFile(f.path);
    form.append(
      f.fieldName,
      new Blob([new Uint8Array(data)], {
        type: f.contentType || "application/octet-stream",
      }),
      f.filename || basename(f.path),
    );
  }
  return form;
}

/**
 * Format a USD amount for an agent-facing message. x402 prices are routinely
 * sub-cent ($0.001, $0.005) — `.toFixed(2)` would round $0.005 to "$0.01" and
 * $0.001 to "$0.00", misreporting the very numbers a spend cap turns on. Show
 * up to 6 decimals, trimmed of trailing zeros.
 */
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  const s = n.toFixed(6).replace(/\.?0+$/, "");
  return `$${s || "0"}`;
}

function extractPriceUsdc(accept: Record<string, unknown>): number | null {
  // x402 v2 names the price field `amount`; x402 v1 names it
  // `maxAmountRequired`. Reading only `amount` made every v1 endpoint
  // evaluate as $0 — which silently disabled the spend cap for the entire
  // v1 (body-challenge) category, web-search/scrape included. Read both.
  const rawAmount = accept.amount ?? accept.maxAmountRequired;
  // A genuinely-absent price is `null` (unknown), NOT 0 — a 0 would sail
  // through any cap. Only treat an explicit numeric/string value as a price.
  if (rawAmount == null || rawAmount === "") return null;
  const amount = Number(rawAmount);
  const extra =
    accept.extra && typeof accept.extra === "object"
      ? (accept.extra as Record<string, unknown>)
      : null;
  const decimals = Number(extra?.decimals ?? 6);
  if (!Number.isFinite(amount) || !Number.isFinite(decimals)) return null;
  return amount / Math.pow(10, decimals);
}

/**
 * Money-safety gate for x402_fetch. Given the 402 `accepts` array, the
 * wallet, and the per-call USDC cap, decides whether any payment option
 * is both within policy (price <= cap) and funded (balance >= price).
 * Exported so it can be unit-tested directly — it is the single most
 * important spend-safety check on the paid path.
 */
export async function evaluatePaymentRequirements(
  wallet: WalletAdapter,
  requirements: Record<string, unknown> | null,
  effectiveMaxAmount: number,
): Promise<{ ok: true; priceUsdc: number | null } | { ok: false; error: string }> {
  const accepts = Array.isArray(requirements?.accepts)
    ? (requirements.accepts as Array<Record<string, unknown>>)
    : [];
  // No accepts[] — nothing priced to evaluate (e.g. an identity-only / SIWX
  // challenge). Let it through; price is unknown.
  if (accepts.length === 0) return { ok: true, priceUsdc: null };

  const evaluated = await Promise.all(
    accepts.map(async (accept) => {
      const network = String(accept.network || "");
      const priceUsdc = extractPriceUsdc(accept);
      const availableUsdc = network ? await wallet.getAvailableUsdc(network) : 0;
      return { network, priceUsdc, availableUsdc };
    }),
  );

  const withinPolicy = evaluated.filter(
    (row) => row.priceUsdc != null && row.priceUsdc <= effectiveMaxAmount,
  );
  if (withinPolicy.length === 0) {
    const prices = evaluated
      .filter((row) => row.priceUsdc != null)
      .map((row) => `${fmtUsd(row.priceUsdc!)} on ${row.network}`)
      .join(", ");
    return {
      ok: false,
      error:
        `Payment policy blocked this call. Available options: ${prices}. ` +
        `Current maxAmountUsdc is ${fmtUsd(effectiveMaxAmount)}.`,
    };
  }

  const funded = withinPolicy.filter(
    (row) => row.priceUsdc != null && row.availableUsdc >= row.priceUsdc,
  );
  if (funded.length === 0) {
    const balances = withinPolicy
      .map(
        (row) =>
          `${row.network}: have ${fmtUsd(row.availableUsdc)}, need ${fmtUsd(row.priceUsdc!)}`,
      )
      .join("; ");
    return { ok: false, error: `Insufficient balance for this call. ${balances}` };
  }

  // Report the cheapest funded, in-policy price — that is what this call will
  // actually cost, and the rolling-budget gate needs it.
  const priceUsdc = Math.min(...funded.map((row) => row.priceUsdc!));
  return { ok: true, priceUsdc };
}

async function parseResponse(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    try {
      return await res.json();
    } catch {
      return await res.text();
    }
  }
  return await res.text();
}

function extractSettlement(res: Response): unknown {
  const header =
    res.headers.get("payment-response")
    || res.headers.get("PAYMENT-RESPONSE")
    || res.headers.get("x-payment-response")
    || res.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return null;
  try {
    return JSON.parse(atob(header));
  } catch {
    try {
      return JSON.parse(header);
    } catch {
      return null;
    }
  }
}

/**
 * A tab-only seller offers no rail the exact path could pay: every accept
 * in the 402 is scheme 'tab'. For such a seller the in-band tab offer is
 * the call's whole answer; for a dual-rail seller it rides alongside the
 * exact result instead.
 */
function isTabOnly(requirements: Record<string, unknown> | null): boolean {
  const accepts = Array.isArray(requirements?.accepts)
    ? (requirements!.accepts as Array<Record<string, unknown>>)
    : [];
  return accepts.length > 0 && accepts.every((a) => a.scheme === "tab");
}

/**
 * The in-band tab offer as a call's WHOLE response (tab-only seller, or
 * any case where nothing exact-payable exists). Mirrors the open MCP's
 * `vault_required` funnel: mode + link + human-relayable message + model
 * instructions + a retry echo that preserves the exact call across the
 * consent detour.
 */
function buildTabOfferResponse(
  offer: TabOfferMaterials,
  params: { url: string; method: string; body?: string },
  requirements: Record<string, unknown> | null,
): Record<string, unknown> {
  const pending = offer.mode === "tab_pending";
  return {
    status: 402,
    mode: offer.mode,
    connect_url: offer.connectUrl,
    ...(offer.priceUsdcPerCall != null
      ? { price_per_call_usdc: offer.priceUsdcPerCall }
      : {}),
    // Human-relayable copy. Written to be handed to the user verbatim.
    message: pending
      ? "Your tab with this seller is waiting for your approval. Open the " +
        "link, approve with your passkey, and I'll run this call again."
      : "This seller runs tabs. Open one and your next calls here stream " +
        "against it with one approval, under a limit you set. Open the " +
        "link, approve with your passkey, and I'll run this call again.",
    instructions: pending
      ? "The tab needs the human's approval before this call can pay. " +
        "Relay message and connect_url to the user, then re-run this " +
        "exact call (see retry) once they approve."
      : "Relay message and connect_url to the user. After they approve, " +
        "re-run this exact call (see retry). The retried call finds the " +
        "open tab and pays on it. If the approval has not landed yet, the " +
        "retry answers with mode tab_pending.",
    // Preserve the original intent so the agent can retry the SAME call.
    retry: {
      tool: "x402_fetch",
      url: params.url,
      method: params.method || "GET",
      body: params.body ?? null,
    },
    requirements,
  };
}

/**
 * The in-band tab offer ATTACHED to a dual-rail result. The call already
 * ran on the exact rail (paid, or failed on its own terms) — this field is
 * the invitation only. No retry echo here, deliberately: telling the model
 * to re-run a call that already completed could pay twice.
 */
function buildAttachedTabOffer(offer: TabOfferMaterials): Record<string, unknown> {
  const pending = offer.mode === "tab_pending";
  return {
    mode: offer.mode,
    connect_url: offer.connectUrl,
    ...(offer.priceUsdcPerCall != null
      ? { price_per_call_usdc: offer.priceUsdcPerCall }
      : {}),
    message: pending
      ? "A tab with this seller is waiting for your approval. Open the " +
        "link and approve with your passkey; calls after that ride the " +
        "tab automatically."
      : "This seller also runs tabs. Approve one once and paid calls to " +
        "this seller stream against it automatically, under a limit you " +
        "set. Open the link and approve with your passkey to set one up.",
    instructions:
      "This is an invitation, separate from the result above. Do not " +
      "re-run the call. If the user wants a tab with this seller, show " +
      "them connect_url; calls after their approval ride the tab " +
      "automatically.",
  };
}

function parse402(body: unknown, paymentRequiredHeader: string | null = null): {
  requirements: Record<string, unknown> | null;
  firstAccept: Record<string, unknown> | null;
} {
  let obj = body as Record<string, unknown> | null;
  if (!obj?.accepts || !Array.isArray(obj.accepts) || obj.accepts.length === 0) {
    const header = parsePaymentRequiredHeader(paymentRequiredHeader);
    if (Array.isArray(header.accepts) && header.accepts.length > 0) {
      obj = {
        accepts: header.accepts,
        x402Version: header.x402Version ?? 2,
        resource: header.resource,
      };
    }
  }
  if (!obj?.accepts || !Array.isArray(obj.accepts))
    return { requirements: null, firstAccept: null };
  return {
    requirements: { accepts: obj.accepts, x402Version: obj.x402Version ?? 2, resource: obj.resource },
    firstAccept: (obj.accepts[0] as Record<string, unknown>) || null,
  };
}

interface RuntimeFetchOpts {
  /** Per-call spend cap in USDC — no single paid call may exceed this. */
  maxAmountUsdc: number;
  /**
   * Optional rolling-budget hook. The caller (the mcp package, which owns the
   * spend ledger) supplies these; x402-mcp-tools stays storage-agnostic.
   *  - dailyBudgetUsdc: the rolling 24h ceiling. 0/undefined = no budget.
   *  - spentLast24hUsdc: witnessed spend in the trailing 24h.
   *  - recordSpend: called after a successful settlement so the ledger grows.
   */
  dailyBudgetUsdc?: number;
  spentLast24hUsdc?: number;
  recordSpend?: (usdc: number, url: string) => void;
  /**
   * Optional tab lane (see TabLaneHook in types.ts). Offered every parsed
   * 402 BEFORE the generic exact path. `done:true` outcomes are final;
   * `done:false` notes ride the eventual result under `tab` so a skipped
   * or unavailable tab is never silent. Multipart calls skip the lane —
   * a voucher re-issue cannot replay a consumed FormData stream.
   */
  tabLane?: TabLaneHook | null;
  /** Atomic ceiling approved for an explicit prepared purchase. */
  maxAmountAtomic?: string;
  /** Durable prepared-identity claim store for explicit purchase modes. */
  purchaseAttempts?: PurchaseAttemptStoreV1 | null;
  /**
   * Test seam only. Production callers leave this absent so explicit probes
   * use x402-core's DNS-pinned public-HTTPS transport with redirects disabled.
   */
  explicitExternalFetch?: typeof fetch;
}

function paymentResponseTransaction(response: Response): string | undefined {
  const settlement = extractSettlement(response);
  if (!settlement || typeof settlement !== "object") return undefined;
  const record = settlement as Record<string, unknown>;
  const transaction =
    record.transaction ?? record.txHash ?? record.transactionHash;
  return typeof transaction === "string" ? transaction : undefined;
}

async function responseFailureDetail(response: Response): Promise<string> {
  try {
    const body = await parseResponse(response.clone());
    const text =
      typeof body === "string" ? body : JSON.stringify(body);
    return text.slice(0, 1_000);
  } catch {
    return `merchant_http_${response.status}`;
  }
}

/**
 * x402 v2's public strategy re-probes and chooses by preferred network. That
 * is insufficient for a prepared purchase because two offers on one network
 * can differ by asset, amount, payee, or facilitator. This adapter builds and
 * sends exactly the already revalidated raw accept—there is no second probe
 * and no network-only selection.
 */
async function paySelectedV2Offer({
  x402Client,
  url,
  requestInit,
  requirements,
  selectedAccept,
  wallets,
  maxAmountAtomic,
  onDispatch,
  externalFetch,
}: {
  x402Client: typeof import("@dexterai/x402/client");
  url: string;
  requestInit: RequestInit;
  requirements: Record<string, unknown> | null;
  selectedAccept: Record<string, unknown>;
  wallets: Record<string, unknown>;
  maxAmountAtomic: string;
  onDispatch: () => void;
  externalFetch: typeof fetch;
}) {
  const network = String(selectedAccept.network ?? "");
  const amount = String(
    selectedAccept.amount ?? selectedAccept.maxAmountRequired ?? "",
  );
  const networkRef = x402Client.toNetworkRef(network);
  if (!networkRef || !/^[1-9]\d*$/.test(amount)) {
    return {
      ok: false as const,
      reason: "no_payment_options" as const,
      detail: "selected_v2_offer_is_not_payable",
      paymentDispatched: false,
    };
  }
  if (BigInt(amount) > BigInt(maxAmountAtomic)) {
    return {
      ok: false as const,
      reason: "budget_exceeded" as const,
      detail: "selected_v2_offer_exceeds_atomic_ceiling",
      paymentDispatched: false,
    };
  }
  if (String(selectedAccept.amount ?? "") !== amount) {
    return {
      ok: false as const,
      reason: "no_payment_options" as const,
      detail: "selected_v2_offer_missing_amount",
      paymentDispatched: false,
    };
  }

  const adapter =
    networkRef.family === "svm"
      ? x402Client.createSolanaAdapter()
      : x402Client.createEvmAdapter();
  const wallet =
    networkRef.family === "svm" ? wallets.solana : wallets.evm;
  if (!wallet || !adapter.canHandle(network) || !adapter.isConnected(wallet)) {
    return {
      ok: false as const,
      reason: "unsupported_network" as const,
      paymentDispatched: false,
    };
  }

  try {
    const accept = { ...selectedAccept };
    const rpcUrl = adapter.getDefaultRpcUrl(network);
    const signed = await adapter.buildTransaction(
      accept as never,
      wallet,
      rpcUrl,
    );
    const payload =
      adapter.name === "EVM"
        ? JSON.parse(signed.serialized)
        : { transaction: signed.serialized };
    const paymentSignature: Record<string, unknown> = {
      x402Version: 2,
      resource: requirements?.resource ?? { url },
      accepted: accept,
      payload,
    };
    if (signed.extensions) {
      paymentSignature.extensions = signed.extensions;
    }

    const headers = new Headers(requestInit.headers ?? undefined);
    headers.set(
      "PAYMENT-SIGNATURE",
      Buffer.from(JSON.stringify(paymentSignature)).toString("base64"),
    );
    const controller = new AbortController();
    const signal = requestInit.signal
      ? AbortSignal.any([requestInit.signal, controller.signal])
      : controller.signal;
    const paidInit: RequestInit = {
      method: requestInit.method ?? "GET",
      headers,
      redirect: requestInit.redirect ?? "error",
      signal,
    };
    if (typeof requestInit.body === "string") {
      paidInit.body = requestInit.body;
    }
    onDispatch();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await externalFetch(url, paidInit);
      clearTimeout(timeout);
      if (!response.ok) {
        return {
          ok: false as const,
          reason:
            response.status === 402
              ? ("merchant_rejected" as const)
              : ("settlement_failed" as const),
          detail: await responseFailureDetail(response),
          paymentDispatched: true,
        };
      }
      return {
        ok: true as const,
        paid: true as const,
        response,
        amountPaid: amount,
        network: networkRef,
        txSignature: paymentResponseTransaction(response),
        paymentDispatched: true,
      };
    } catch (error) {
      clearTimeout(timeout);
      if (signed.settlementProbe && adapter.confirmSettlement) {
        try {
          const confirmation = await adapter.confirmSettlement(
            signed.settlementProbe,
            rpcUrl,
          );
          if (confirmation.settled) {
            return {
              ok: true as const,
              paid: true as const,
              response: undefined,
              amountPaid: amount,
              network: networkRef,
              txSignature: confirmation.txSignature,
              paymentDispatched: true,
            };
          }
        } catch {
          // Unknown remains unknown. Never turn a failed reconciliation read
          // into permission to sign a second authorization.
        }
      }
      return {
        ok: false as const,
        reason: "payment_unconfirmed" as const,
        detail: error instanceof Error ? error.message : String(error),
        paymentDispatched: true,
      };
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: "error" as const,
      detail: error instanceof Error ? error.message : String(error),
      paymentDispatched: false,
    };
  }
}

async function paySelectedV1Offer({
  x402Client,
  url,
  requestInit,
  challenge,
  wallets,
  maxAmountAtomic,
  onDispatch,
  externalFetch,
}: {
  x402Client: typeof import("@dexterai/x402/client");
  url: string;
  requestInit: RequestInit;
  challenge: import("@dexterai/x402/client").PaymentChallenge;
  wallets: Record<string, unknown>;
  maxAmountAtomic: string;
  onDispatch: () => void;
  externalFetch: typeof fetch;
}) {
  const built = await x402Client.buildV1PaymentHeader(
    challenge as never,
    wallets as never,
    { maxAmountAtomic },
  );
  if (!built.ok) {
    return {
      ok: false as const,
      reason: built.reason,
      detail: built.detail,
      paymentDispatched: false,
    };
  }

  const headers = new Headers(requestInit.headers ?? undefined);
  headers.set("X-PAYMENT", built.headerValue);
  const controller = new AbortController();
  const signal = requestInit.signal
    ? AbortSignal.any([requestInit.signal, controller.signal])
    : controller.signal;
  const paidInit: RequestInit = {
    method: requestInit.method ?? "GET",
    headers,
    redirect: requestInit.redirect ?? "error",
    signal,
  };
  if (typeof requestInit.body === "string") paidInit.body = requestInit.body;

  try {
    onDispatch();
  } catch (error) {
    return {
      ok: false as const,
      reason: "error" as const,
      detail: error instanceof Error ? error.message : String(error),
      paymentDispatched: false,
    };
  }

  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await externalFetch(url, paidInit);
    clearTimeout(timeout);
    if (!response.ok) {
      return {
        ok: false as const,
        reason:
          response.status === 402
            ? ("merchant_rejected" as const)
            : ("settlement_failed" as const),
        detail: await responseFailureDetail(response),
        paymentDispatched: true,
      };
    }
    return {
      ok: true as const,
      paid: true as const,
      response,
      amountPaid: built.option.amount,
      network: built.option.network,
      txSignature: paymentResponseTransaction(response),
      paymentDispatched: true,
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      ok: false as const,
      reason: "payment_unconfirmed" as const,
      detail:
        "The v1 proof-bearing request was dispatched through the guarded " +
        `seller route, but its result is unknown (${error instanceof Error ? error.message : String(error)}).`,
      paymentDispatched: true,
    };
  }
}

function receiptFromResult(
  result: Record<string, unknown>,
): PurchaseReceiptV1 | null {
  const receipt = result.purchaseReceipt;
  return receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? (receipt as PurchaseReceiptV1)
    : null;
}

function completedAttemptState(
  receipt: PurchaseReceiptV1,
): Exclude<PurchaseAttemptStateV1, "claimed" | "dispatching"> {
  if (receipt.retry === "same_prepared_only") return "awaiting_action";
  if (receipt.dispatch === "not_dispatched") return "failed_pre_dispatch";
  if (receipt.retry === "none") return "completed";
  return "reconciliation_required";
}

export async function x402Fetch(
  params: {
    url: string;
    method: string;
    body?: string;
    headers?: Record<string, string>;
    multipart?: MultipartInput;
    purchase?: PreparedPurchaseV1;
  },
  wallet: WalletAdapter | null,
  runtime: RuntimeFetchOpts,
): Promise<Record<string, unknown>> {
  const isMultipart = Boolean(params.multipart && typeof params.multipart === "object");
  let validatedPurchase: ValidatedPurchaseV1 | null = null;
  let attemptStore: PurchaseAttemptStoreV1 | null = null;
  let attemptClaimed = false;
  let attemptCompleted = false;
  const explicitExternalFetch: typeof fetch =
    runtime.explicitExternalFetch
    ?? (async (input, init) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return fetchPublicExternalUrl(rawUrl, init, {
        maxRedirects: 0,
        timeoutMs: 120_000,
      });
    });

  if (params.purchase) {
    if (isMultipart) {
      return {
        status: 400,
        mode: "purchase_contract_error",
        phase: "pre_dispatch",
        retryable: false,
        error: "prepared_purchase_multipart_not_supported",
        message:
          "A multipart purchase needs a prepared manifest containing file hashes. Nothing was dispatched.",
        payment: { dispatched: false, settled: false },
      };
    }
    const validation = validatePurchaseExecution({
      purchase: params.purchase,
      url: params.url,
      method: params.method || "GET",
      payload: params.body ?? null,
      approvedAmountCeilingAtomic: runtime.maxAmountAtomic ?? "",
      allowedModes: PURCHASE_MODES,
    });
    if (!validation.ok) {
      return {
        status: 400,
        mode: "purchase_contract_error",
        phase: "pre_dispatch",
        retryable: false,
        error: validation.code,
        message: validation.message,
        payment: { dispatched: false, settled: false },
      };
    }
    validatedPurchase = validation.value;
    if (
      validatedPurchase.mode === "gateway_cash" ||
      validatedPurchase.mode === "gateway_credit"
    ) {
      return buildPurchaseIntegrationRequired(
        validatedPurchase,
        `${validatedPurchase.mode}_adapter_required`,
      );
    }
    attemptStore = runtime.purchaseAttempts ?? null;
    if (!attemptStore) {
      return buildPurchaseIntegrationRequired(
        validatedPurchase,
        "durable_purchase_attempt_store_required",
      );
    }
    let claim;
    try {
      claim = attemptStore.begin(validatedPurchase);
    } catch {
      return buildPurchaseIntegrationRequired(
        validatedPurchase,
        "durable_purchase_attempt_store_unavailable",
      );
    }
    if (!claim.acquired) {
      if (claim.receipt) {
        return {
          status: 409,
          mode: "purchase_attempt_already_recorded",
          phase: "idempotency",
          retryable: false,
          error: "prepared_purchase_already_used",
          message:
            "This prepared purchase already has a durable attempt. No new request was dispatched.",
          purchaseReceipt: claim.receipt,
        };
      }
      const uncertain = [
        "claimed",
        "dispatching",
        "reconciliation_required",
        "unknown",
      ].includes(claim.state);
      const result = attachPurchaseReceipt(
        {
          status: 409,
          mode: "purchase_attempt_already_recorded",
          phase: "idempotency",
          retryable: false,
          error: uncertain
            ? "prepared_purchase_requires_reconciliation"
            : "prepared_purchase_already_used",
          message: uncertain
            ? "A prior attempt with this prepared identity may have dispatched. Reconcile it; do not retry."
            : "This prepared identity was already used before dispatch. Prepare a new purchase.",
          payment: uncertain
            ? { settled: "unknown", retrySafe: false }
            : { dispatched: false, settled: false },
        },
        validatedPurchase,
      );
      return result;
    }
    attemptClaimed = true;
  }

  const withPurchase = (result: Record<string, unknown>): Record<string, unknown> => {
    const withReceipt =
      validatedPurchase ? attachPurchaseReceipt(result, validatedPurchase) : result;
    if (
      !validatedPurchase
      || !attemptStore
      || !attemptClaimed
      || attemptCompleted
    ) {
      return withReceipt;
    }
    const receipt = receiptFromResult(withReceipt);
    if (!receipt) return withReceipt;
    attemptCompleted = true;
    try {
      attemptStore.complete(
        validatedPurchase,
        completedAttemptState(receipt),
        receipt,
      );
      return withReceipt;
    } catch {
      return {
        ...withReceipt,
        retryable: false,
        attemptState: "reconciliation_required",
        attemptError: "purchase_attempt_record_update_failed",
      };
    }
  };

  const markAttemptDispatching = (): boolean => {
    if (!validatedPurchase || !attemptStore || !attemptClaimed) return false;
    try {
      attemptStore.markDispatching(validatedPurchase);
      return true;
    } catch {
      return false;
    }
  };

  if (isMultipart && params.method !== "POST" && params.method !== "PUT") {
    return withPurchase({ status: 400, error: "multipart_requires_post_or_put" });
  }

  const requestHeaders: Record<string, string> = {
    ...(params.headers || {}),
  };
  if (isMultipart) {
    // fetch must set Content-Type itself so the multipart boundary is
    // correct. Drop any caller-supplied Content-Type (any casing) so a
    // stray header cannot corrupt the upload.
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === "content-type") delete requestHeaders[key];
    }
  } else {
    requestHeaders["Content-Type"] = "application/json";
  }

  const fetchOpts: RequestInit = {
    method: params.method || "GET",
    headers: requestHeaders,
  };

  if (isMultipart) {
    try {
      // Build once for the probe; the client will rebuild for the retry so
      // streams are not consumed twice.
      fetchOpts.body = await buildMultipartFormData(params.multipart!);
    } catch (err: any) {
      return withPurchase({ status: 400, error: err?.message || "multipart_build_failed" });
    }
  } else if (params.body && params.method !== "GET") {
    fetchOpts.body = params.body;
  }

  const probeTimeoutMs = isMultipart ? 60_000 : 15_000;
  const probeUrl = validatedPurchase?.route.resolvedUrl ?? params.url;
  let probeRes: Response;
  try {
    const probeInit = {
      ...fetchOpts,
      ...(validatedPurchase ? { redirect: "error" as const } : {}),
      signal: AbortSignal.timeout(probeTimeoutMs),
    };
    probeRes = validatedPurchase
      ? await explicitExternalFetch(probeUrl, probeInit)
      : await fetch(probeUrl, probeInit);
  } catch (error) {
    if (validatedPurchase && error instanceof UnsafeExternalUrlError) {
      return withPurchase({
        status: 400,
        mode: "purchase_contract_error",
        phase: "pre_dispatch",
        retryable: false,
        error: "prepared_resolved_url_not_public_https",
        message:
          "The prepared seller route is not a public HTTPS destination. Nothing was dispatched.",
        payment: { dispatched: false, settled: false },
      });
    }
    return withPurchase({
      status: 502,
      mode: "purchase_probe_failed",
      phase: "pre_dispatch",
      retryable: false,
      error: "seller_probe_failed",
      message:
        error instanceof Error
          ? `The seller could not be reached before payment dispatch: ${error.message}`
          : "The seller could not be reached before payment dispatch.",
      payment: { dispatched: false, settled: false },
    });
  }
  const paymentChallengeResponse =
    probeRes.status === 402 ? probeRes.clone() : null;

  const freshResolvedUrl = probeRes.url || probeUrl;
  if (
    validatedPurchase
    && freshResolvedUrl !== validatedPurchase.route.resolvedUrl
  ) {
    return withPurchase({
      status: 409,
      mode: "purchase_route_changed",
      phase: "pre_dispatch",
      retryable: false,
      error: "seller_resolved_url_changed",
      message:
        "The seller route resolved to a different URL than the prepared " +
        "purchase. Nothing was dispatched; check current terms again.",
      payment: { dispatched: false, settled: false },
    });
  }

  if (probeRes.status !== 402) {
    return withPurchase({ status: probeRes.status, data: await parseResponse(probeRes) });
  }

  let body402: unknown = null;
  try {
    body402 = await probeRes.json();
  } catch {
    try {
      body402 = await probeRes.text();
    } catch {}
  }

  const { requirements } = parse402(
    body402,
    probeRes.headers.get("payment-required"),
  );
  let selectedRequirements = requirements;
  let selectedAccept: Record<string, unknown> | null = null;
  let selectedAcceptIndex = -1;
  if (validatedPurchase) {
    const accepts = Array.isArray(requirements?.accepts)
      ? (requirements.accepts as Array<Record<string, unknown>>)
      : [];
    const matchingAccepts = accepts
      .map((accept, index) => ({ accept, index }))
      .filter(({ accept }) =>
        sellerOfferMatches(validatedPurchase!.route.sellerOffer, accept),
      );
    if (matchingAccepts.length === 1) {
      selectedAccept = matchingAccepts[0].accept;
      selectedAcceptIndex = matchingAccepts[0].index;
    }
    if (
      Number(requirements?.x402Version ?? 2) !==
        validatedPurchase.route.sellerOffer.x402Version ||
      !selectedAccept
    ) {
      return withPurchase({
        status: 409,
        mode: "purchase_terms_changed",
        phase: "pre_dispatch",
        retryable: false,
        error: "selected_seller_offer_not_found",
        message:
          "The seller no longer offers the exact route that was prepared. Nothing was dispatched; check current terms again.",
        payment: { dispatched: false, settled: false },
        requirements,
      });
    }
    selectedRequirements = {
      ...(requirements || {}),
      accepts: [selectedAccept],
    };
  }

  // ── Tab lane (before any exact payment) ─────────────────────────────
  // The consumer-custodied tab lane gets first look at every parsed 402.
  // A `done:true` outcome IS the result (voucher-paid, or a loud tab error
  // that must not be papered over by paying exact). A `done:false` outcome
  // falls through to the exact path exactly as before, with its optional
  // note riding the final result under `tab` — a skipped tab is loud,
  // never silent. An `offer` is the in-band tab invitation: for a
  // dual-rail seller it rides the exact result under `tab_offer` (the
  // call is never blocked on consent); for a tab-only seller it IS the
  // response. A lane crash must never take down the paid path.
  let tabNote: Record<string, unknown> | undefined;
  let tabOffer: TabOfferMaterials | undefined;
  const strictNativeTab = validatedPurchase?.mode === "native_tab";
  const executionUrl =
    validatedPurchase?.route.resolvedUrl ?? params.url;
  if (strictNativeTab && !runtime.tabLane) {
    return withPurchase({
      status: 501,
      mode: "native_tab_unavailable",
      phase: "pre_dispatch",
      retryable: false,
      error: "native_tab_adapter_unavailable",
      message: "Native Tab is selected, but no Tab adapter is available. Nothing was dispatched.",
      payment: { dispatched: false, settled: false },
      requirements: selectedRequirements,
    });
  }
  if (strictNativeTab && !markAttemptDispatching()) {
    return withPurchase({
      status: 503,
      mode: "purchase_attempt_store_error",
      phase: "pre_dispatch",
      retryable: false,
      error: "purchase_attempt_dispatch_mark_failed",
      message:
        "OpenDexter could not durably mark this Native Tab attempt before dispatch. Nothing was sent.",
      payment: { dispatched: false, settled: false },
      requirements: selectedRequirements,
    });
  }
  if (
    runtime.tabLane &&
    !isMultipart &&
    (!validatedPurchase || strictNativeTab)
  ) {
    try {
      const outcome = await runtime.tabLane(
        {
          url: executionUrl,
          method: params.method || "GET",
          headers: requestHeaders,
          body: typeof fetchOpts.body === "string" ? fetchOpts.body : undefined,
          ...(strictNativeTab
            ? { externalFetch: explicitExternalFetch }
            : {}),
        },
        selectedRequirements,
      );
      if (outcome.done) return withPurchase(outcome.result);
      if (strictNativeTab) {
        return withPurchase({
          status: 402,
          mode: outcome.offer?.mode ?? "native_tab_unavailable",
          phase: "pre_dispatch",
          retryable: false,
          error: "native_tab_not_ready",
          message:
            "Native Tab was selected, but this Tab is not ready for dispatch. " +
            "Open or approve the Tab, then resume this same prepared purchase.",
          payment: { dispatched: false, settled: false },
          requirements: selectedRequirements,
          ...(outcome.note ? { tab: outcome.note } : {}),
          ...(outcome.offer
            ? {
                tab_offer: buildAttachedTabOffer(outcome.offer),
                connect_url: outcome.offer.connectUrl,
              }
            : {}),
        });
      }
      tabNote = outcome.note;
      tabOffer = outcome.offer;
    } catch (err: any) {
      if (strictNativeTab) {
        return withPurchase({
          status: 502,
          mode: "native_tab_error",
          phase: "dispatch_unknown",
          retryable: false,
          error: "native_tab_adapter_failed",
          message:
            "Native Tab failed after entering its dispatch adapter. The " +
            "voucher outcome is unknown; reconcile this prepared attempt " +
            `and do not retry. (${err?.message ?? String(err)})`,
          payment: { settled: "unknown", retrySafe: false },
          requirements: selectedRequirements,
        });
      }
      tabNote = {
        rail: "tab",
        used: false,
        error: `tab lane failed: ${err?.message ?? String(err)}`,
      };
    }
  }
  if (tabOffer && isTabOnly(selectedRequirements)) {
    return withPurchase(buildTabOfferResponse(
      tabOffer,
      { url: params.url, method: params.method || "GET", body: params.body },
      selectedRequirements,
    ));
  }
  const withTab = (r: Record<string, unknown>): Record<string, unknown> => {
    let out = tabNote ? { ...r, tab: tabNote } : r;
    if (tabOffer) out = { ...out, tab_offer: buildAttachedTabOffer(tabOffer) };
    return withPurchase(out);
  };

  // Mode 1: Wallet auto-pay
  if (wallet) {
    try {
      const policyCheck = await evaluatePaymentRequirements(
        wallet,
        selectedRequirements,
        runtime.maxAmountUsdc,
      );
      if (!policyCheck.ok) {
        return withTab({ status: 402, error: policyCheck.error, requirements: selectedRequirements });
      }

      // Rolling-budget gate. The per-call cap above only asks "is THIS call
      // too big" — it cannot stop a loop of small in-cap calls draining the
      // wallet. The budget does: if this call's price would push witnessed
      // 24h spend over dailyBudgetUsdc, refuse before paying.
      const budget = runtime.dailyBudgetUsdc ?? 0;
      const callPrice = policyCheck.priceUsdc;
      if (budget > 0 && callPrice != null) {
        const spent = runtime.spentLast24hUsdc ?? 0;
        if (spent + callPrice > budget) {
          return withTab({
            status: 402,
            error:
              `Rolling budget blocked this call. This call costs ` +
              `${fmtUsd(callPrice)}; ${fmtUsd(spent)} of the ` +
              `${fmtUsd(budget)} 24h budget is already spent through ` +
              `this tool. Raise dailyBudgetUsdc or wait for the window to roll.`,
            requirements: selectedRequirements,
          });
        }
      }

      const signers = wallet.getPaymentSigners();
      if (!signers.solanaPrivateKey && !signers.evmPrivateKey) {
        return withTab({
          status: 402,
          error:
            "Wallet does not expose private keys for auto-pay. " +
            "Settle the payment externally and retry, or configure a wallet that supports auto-pay.",
          requirements: selectedRequirements,
        });
      }

      // Legacy calls retain payAndFetch's version-agnostic behavior. Explicit
      // Direct Exact calls use a route-pinned adapter: v1 consumes one
      // filtered parsed option; v2 builds the selected raw accept directly
      // and never performs the SDK's network-only second probe.
      const x402Client = await import("@dexterai/x402/client");
      const {
        payAndFetch,
        createKeypairWallet,
        createEvmKeypairWallet,
      } = x402Client;

      // Build the WalletSet payAndFetch expects, from whatever keys the
      // adapter exposes — same factories wrapFetch used internally.
      const walletSet: Record<string, unknown> = {};
      if (signers.solanaPrivateKey) {
        walletSet.solana = await createKeypairWallet(signers.solanaPrivateKey);
      }
      if (signers.evmPrivateKey) {
        walletSet.evm = await createEvmKeypairWallet(signers.evmPrivateKey);
      }

      // payAndFetch does its own probe + paid retry. Multipart bodies are
      // single-use streams, so rebuild a fresh FormData for this call path.
      const paidFetchOpts: RequestInit = { ...fetchOpts };
      if (validatedPurchase) {
        paidFetchOpts.redirect = "error";
      }
      if (isMultipart) {
        try {
          paidFetchOpts.body = await buildMultipartFormData(params.multipart!);
        } catch (err: any) {
          return { status: 400, error: err?.message || "multipart_rebuild_failed" };
        }
      }

      let payResult;
      if (validatedPurchase?.mode === "direct_exact") {
        if (!paymentChallengeResponse) {
          return withTab({
            status: 409,
            mode: "purchase_terms_changed",
            phase: "pre_dispatch",
            retryable: false,
            error: "payment_challenge_missing",
            message: "The prepared payment challenge is no longer available. Nothing was dispatched.",
            payment: { dispatched: false, settled: false },
          });
        }
        const strategy = await x402Client.detectStrategy(
          paymentChallengeResponse.clone(),
        );
        const challenge = strategy
          ? await strategy.parseChallenge(paymentChallengeResponse.clone())
          : null;
        const selected = validatedPurchase.route.sellerOffer;
        const selectedOption = challenge?.options[selectedAcceptIndex];
        const selectedOptionMatches = selectedOption
          ? (() => {
              const networkMatches =
                selectedOption.network.caip2 === selected.network
                || selectedOption.network.bare === selected.network;
              return (
                selectedOption.scheme === selected.scheme
                && networkMatches
                && selectedOption.amount === selected.amountAtomic
                && selectedOption.asset === selected.asset
                && selectedOption.payTo === selected.payTo
              );
            })()
          : false;
        if (
          !strategy
          || !challenge
          || !selectedOption
          || !selectedOptionMatches
        ) {
          return withTab({
            status: 409,
            mode: "purchase_terms_changed",
            phase: "pre_dispatch",
            retryable: false,
            error: "selected_strategy_offer_not_found",
            message:
              "The payment strategy could not preserve the one prepared seller offer. Nothing was dispatched.",
            payment: { dispatched: false, settled: false },
            requirements: selectedRequirements,
          });
        }
        if (challenge.x402Version === 2) {
          if (!selectedAccept) {
            return withTab({
              status: 409,
              mode: "purchase_terms_changed",
              phase: "pre_dispatch",
              retryable: false,
              error: "selected_raw_offer_not_found",
              message:
                "The selected raw seller offer is no longer available. Nothing was dispatched.",
              payment: { dispatched: false, settled: false },
              requirements: selectedRequirements,
            });
          }
          payResult = await paySelectedV2Offer({
            x402Client,
            url: executionUrl,
            requestInit: paidFetchOpts,
            requirements: selectedRequirements,
            selectedAccept,
            wallets: walletSet,
            maxAmountAtomic:
              validatedPurchase.approvedAmountCeilingAtomic,
            onDispatch: () => {
              if (!markAttemptDispatching()) {
                throw new Error("purchase_attempt_dispatch_mark_failed");
              }
            },
            externalFetch: explicitExternalFetch,
          });
        } else {
          payResult = await paySelectedV1Offer({
            x402Client,
            url: executionUrl,
            requestInit: paidFetchOpts,
            challenge: { ...challenge, options: [selectedOption] },
            wallets: walletSet,
            maxAmountAtomic:
              validatedPurchase.approvedAmountCeilingAtomic,
            onDispatch: () => {
              if (!markAttemptDispatching()) {
                throw new Error("purchase_attempt_dispatch_mark_failed");
              }
            },
            externalFetch: explicitExternalFetch,
          });
        }
      } else {
        payResult = await payAndFetch(
          params.url,
          paidFetchOpts,
          walletSet as never,
          {},
        );
      }

      if (!payResult.ok) {
        // `payment_unconfirmed` is NOT a plain payment failure: the payment
        // authorization was already sent to the merchant and MAY have settled
        // on-chain — the merchant just never answered in time. Surfacing it as
        // "Payment failed" would read as safe-to-retry, and a retry signs a
        // fresh authorization and can pay a second time. Give it its own
        // shape: an explicit money-moved, do-not-retry signal.
        if (payResult.reason === "payment_unconfirmed") {
          return withTab({
            status: 402,
            error:
              "Payment unconfirmed — the payment was sent and may have " +
              "settled on-chain, but the merchant did not respond in time. " +
              "DO NOT retry this call: a retry can pay a second time. " +
              "Check the wallet / chain for a settled transaction before " +
              "deciding what to do." +
              (payResult.detail ? ` (${payResult.detail})` : ""),
            payment: { settled: "unconfirmed", retrySafe: false },
            requirements: selectedRequirements,
          });
        }
        // A typed, expected failure — never a thrown error. SIW-X endpoints
        // surface here too (the v1/v2 strategies don't recognise an
        // identity-only challenge as payable). These reasons all mean no
        // money moved (or the merchant rejected the payload) — retry-safe.
        const dispatchProof = (
          payResult as { paymentDispatched?: boolean }
        ).paymentDispatched;
        const dispatchedFailure =
          dispatchProof === true ||
          payResult.reason === "merchant_rejected" ||
          payResult.reason === "settlement_failed" ||
          (
            validatedPurchase !== null
            && payResult.reason === "error"
            && dispatchProof !== false
          );
        return withTab({
          status: 402,
          error: `Payment failed: ${payResult.reason}${
            payResult.detail ? ` — ${payResult.detail}` : ""
          }`,
          ...(dispatchedFailure
            ? {
                payment: { settled: "unconfirmed", retrySafe: false },
                retryable: false,
              }
            : {
                payment: { dispatched: false, settled: false },
                retryable: false,
              }),
          requirements: selectedRequirements,
        });
      }

      // ok:true with paid:false — the endpoint returned a non-402 directly,
      // no payment was made. Reaching here is unexpected (we already saw a
      // 402 on the probe above) but the discriminated union requires the
      // branch; handle it rather than mis-reading payment fields off it.
      if (!payResult.paid) {
        return withTab({
          status: payResult.response.status,
          data: await parseResponse(payResult.response),
        });
      }

      // ok:true, paid:true — but `response` can still be undefined: the
      // payment was confirmed settled on-chain yet the merchant never
      // answered before the deadline. Money moved, no data came back.
      // parseResponse(undefined) would throw — handle it as its own result.
      if (!payResult.response) {
        const network =
          payResult.network?.caip2 ?? payResult.network?.bare;
        return withTab({
          status: 402,
          error:
            "Payment settled on-chain, but the merchant returned no " +
            "response before the deadline. The money was spent and the " +
            "call produced no data. DO NOT retry: the payment already " +
            "went through.",
          payment: {
            settled: true,
            retrySafe: false,
            details: {
              amountPaid: payResult.amountPaid,
              network,
              ...(payResult.txSignature
                ? { transaction: payResult.txSignature }
                : {}),
            },
          },
          requirements: selectedRequirements,
        });
      }

      const paidRes: Response = payResult.response;
      const data = await parseResponse(paidRes);
      // payAndFetch reports settlement on the PayResult itself (amountPaid,
      // network, txSignature) — authoritative. Fall back to the response's
      // PAYMENT-RESPONSE header for any extra receipt detail.
      const headerSettlement = extractSettlement(paidRes);
      const settlement: Record<string, unknown> = {
        amountPaid: payResult.amountPaid,
        network: payResult.network?.caip2 ?? payResult.network?.bare,
        ...(payResult.txSignature ? { transaction: payResult.txSignature } : {}),
        ...(headerSettlement && typeof headerSettlement === "object"
          ? (headerSettlement as Record<string, unknown>)
          : {}),
      };

      const { getSponsoredRecommendations, fireImpressionBeacon } = await import(
        "@dexterai/x402/client"
      );
      let sponsoredRecs = getSponsoredRecommendations(paidRes);
      if (
        !sponsoredRecs &&
        data &&
        typeof data === "object" &&
        Array.isArray((data as any)._x402_sponsored)
      ) {
        sponsoredRecs = (data as any)._x402_sponsored;
      }
      if (sponsoredRecs) {
        fireImpressionBeacon(paidRes).catch(() => {});
      }

      // payResult.ok === true means payAndFetch completed settlement.
      // Record the witnessed spend so the rolling budget sees it next call.
      // amountPaid is authoritative (atomic units from the PayResult); fall
      // back to the policy-check price if the SDK did not surface it.
      //
      // Per-chain decimals: BSC USDC is 18, every other supported chain is 6.
      // Hardcoding /1e6 would have silently under-reported a $5 BSC spend as
      // $0.000000000000005, also breaking the rolling-budget check. Inline
      // lookup keeps the fix self-contained in this tool — when more chains
      // join the family, add them here too.
      if (runtime.recordSpend) {
        const paidAtomic = Number(payResult.amountPaid);
        const network = payResult.network?.caip2 ?? payResult.network?.bare ?? "";
        const decimals = network === "eip155:56" || network === "bsc" ? 18 : 6;
        const paidUsdc = Number.isFinite(paidAtomic) && paidAtomic > 0
          ? paidAtomic / Math.pow(10, decimals)
          : (policyCheck.priceUsdc ?? 0);
        if (paidUsdc > 0) {
          try { runtime.recordSpend(paidUsdc, params.url); } catch {}
        }
      }

      const result: Record<string, unknown> = {
        status: paidRes.status,
        data,
        payment: { settled: true, details: settlement },
      };

      if (sponsoredRecs?.length) {
        result.recommendations = sponsoredRecs;
        result._recommendations_hint = `Sponsored: ${sponsoredRecs
          .map((r) => `${r.sponsor} — ${r.description} (${r.resourceUrl})`)
          .join("; ")}. Call with x402_fetch if relevant.`;
      }

      return withTab(result);
    } catch (err: any) {
      return withTab({
        status: 402,
        error: `Payment failed: ${err.message}`,
        ...(validatedPurchase
          ? {
              payment: { settled: "unknown", retrySafe: false },
              retryable: false,
            }
          : {}),
        requirements: selectedRequirements,
      });
    }
  }

  // No signing wallet: return canonical x402 requirements only.
  return withTab({
    status: 402,
    message:
      "Payment required. Provide payment-signature manually or configure a wallet for automatic settlement.",
    requirements: selectedRequirements,
  });
}

export function registerFetchTool(server: McpServer, opts: FetchToolOpts): void {
  const wallet = opts.wallet;
  const hasWallet = wallet !== null;
  const meta = opts.metas.fetch;
  const getMaxAmountUsdc =
    opts.getMaxAmountUsdc ?? (() => Number.POSITIVE_INFINITY);

  const description = hasWallet
    ? "Call an x402 API after x402_check and explicit approval. Preserve the prepared purchase, selected seller offer, route, mode, request digest, and atomic ceiling. " +
      "direct_exact and native_tab use distinct adapters; gateway_cash and gateway_credit fail before dispatch until their adapters are connected. OpenDexter never silently changes modes."
    : "Call any x402-protected API. Returns payment requirements when settlement is needed. " +
      (opts.walletlessHint ?? "Provision a wallet for this MCP session to enable automatic payment.");

  const inputSchema = {
    url: z.string().url().describe("The x402 resource URL to call"),
    method: z
      .enum(["GET", "POST", "PUT", "DELETE"])
      .default("GET")
      .describe("HTTP method"),
    body: z.string().optional().describe("JSON request body for POST/PUT"),
    headers: z
      .record(z.string())
      .optional()
      .describe(
        "Optional custom request headers, e.g. an Authorization or X-API-Key " +
          "header for an endpoint whose authMode is apiKey or apiKey+paid. " +
          "Content-Type is managed automatically (JSON, or the multipart " +
          "boundary) — do not set it here.",
      ),
    maxAmountUsdc: z
      .number()
      .positive()
      .optional()
      .describe("Legacy local settings override in display USDC."),
    maxAmountAtomic: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional()
      .describe(
        "User-approved atomic-unit ceiling for purchase. Required whenever purchase is present.",
      ),
    purchase: preparedPurchaseSchema
      .optional()
      .describe(
        "Exact prepared purchase returned by x402_check. Pins the seller offer, route, mode, URL, method, body digest, and prepared identity.",
      ),
    tab: z
      .boolean()
      .optional()
      .describe(
        "Legacy compatibility only. Automatic Tab-first behavior applies only " +
          "when purchase is omitted. New calls choose direct_exact or native_tab through purchase.mode.",
      ),
    multipart: z
      .object({
        fields: z
          .record(z.string())
          .optional()
          .describe(
            "Text form fields to forward. Keys are field names, values are strings.",
          ),
        files: z
          .array(
            z.object({
              fieldName: z
                .string()
                .describe(
                  "Form field name the upstream endpoint expects (e.g. 'transcript').",
                ),
              path: z.string().describe("Absolute path to the file on the local filesystem."),
              filename: z
                .string()
                .optional()
                .describe(
                  "Override Content-Disposition filename (defaults to basename(path)).",
                ),
              contentType: z
                .string()
                .optional()
                .describe("MIME type (defaults to application/octet-stream)."),
            }),
          )
          .optional()
          .describe(
            "File attachments read from disk and forwarded as multipart file parts.",
          ),
      })
      .optional()
      .describe(
        "When present, POSTs multipart/form-data instead of JSON. POST/PUT only. " +
          "Max total payload 200 MB. Use for endpoints that accept file uploads.",
      ),
  };

  const runFetch = async (args: {
    url: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    body?: string;
    headers?: Record<string, string>;
    maxAmountUsdc?: number;
    maxAmountAtomic?: string;
    purchase?: PreparedPurchaseV1;
    tab?: boolean;
    multipart?: MultipartInput;
  }) => {
    try {
      const effectiveMax = args.maxAmountUsdc ?? getMaxAmountUsdc();
      // Resolve the rolling-budget hooks fresh per call (live settings + a
      // current ledger read). Absent hook = budget disabled.
      const budget = opts.getBudgetRuntime?.();
      // Resolve the tab lane fresh per call too — a tab approved while the
      // server is running becomes payable without a restart. For an explicit
      // purchase, mode selects whether this adapter is used; `tab` only
      // controls the legacy no-purchase path.
      const tabLane = args.tab === false ? null : (opts.getTabLane?.() ?? null);
      const result = await x402Fetch(
        {
          url: args.url,
          method: args.method,
          body: args.body,
          headers: args.headers,
          multipart: args.multipart,
          purchase: args.purchase,
        },
        wallet,
        {
          maxAmountUsdc: effectiveMax,
          maxAmountAtomic: args.maxAmountAtomic,
          purchaseAttempts: opts.getPurchaseAttemptStore?.() ?? null,
          ...(budget
            ? {
                dailyBudgetUsdc: budget.dailyBudgetUsdc,
                spentLast24hUsdc: budget.spentLast24hUsdc,
                recordSpend: budget.recordSpend,
              }
            : {}),
          ...(tabLane ? { tabLane } : {}),
        },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        _meta: meta,
      } as any;
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  };

  server
    .tool("x402_fetch", description, inputSchema, runFetch)
    ?.update?.({ _meta: meta });

  if (opts.registerPayAlias !== false) {
    server.tool(
      "x402_pay",
      "Alias of x402_fetch for clients that want an explicit payment verb. " +
        "Accepts the same prepared purchase, explicit mode, selected seller offer, " +
        "route, and atomic ceiling, and returns the same mode-specific receipt. " +
        "Never call both aliases for one intended purchase.",
      inputSchema,
      runFetch,
    )?.update?.({ _meta: meta });
  }
}
