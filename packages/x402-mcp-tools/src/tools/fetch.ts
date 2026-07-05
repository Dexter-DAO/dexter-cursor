import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FetchToolOpts, TabLaneHook } from "../types.js";
import type { WalletAdapter } from "../wallet-adapter.js";

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
  const header = res.headers.get("payment-response") || res.headers.get("PAYMENT-RESPONSE");
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

function parse402(body: unknown): {
  requirements: Record<string, unknown> | null;
  firstAccept: Record<string, unknown> | null;
} {
  const obj = body as Record<string, unknown> | null;
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
}

export async function x402Fetch(
  params: {
    url: string;
    method: string;
    body?: string;
    headers?: Record<string, string>;
    multipart?: MultipartInput;
  },
  wallet: WalletAdapter | null,
  runtime: RuntimeFetchOpts,
): Promise<Record<string, unknown>> {
  const isMultipart = Boolean(params.multipart && typeof params.multipart === "object");

  if (isMultipart && params.method !== "POST" && params.method !== "PUT") {
    return { status: 400, error: "multipart_requires_post_or_put" };
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
      return { status: 400, error: err?.message || "multipart_build_failed" };
    }
  } else if (params.body && params.method !== "GET") {
    fetchOpts.body = params.body;
  }

  const probeTimeoutMs = isMultipart ? 60_000 : 15_000;
  const probeRes = await fetch(params.url, {
    ...fetchOpts,
    signal: AbortSignal.timeout(probeTimeoutMs),
  });

  if (probeRes.status !== 402) {
    return { status: probeRes.status, data: await parseResponse(probeRes) };
  }

  let body402: unknown = null;
  try {
    body402 = await probeRes.json();
  } catch {
    try {
      body402 = await probeRes.text();
    } catch {}
  }

  const { requirements } = parse402(body402);

  // ── Tab lane (before any exact payment) ─────────────────────────────
  // The consumer-custodied tab lane gets first look at every parsed 402.
  // A `done:true` outcome IS the result (voucher-paid, or a loud tab error
  // that must not be papered over by paying exact). A `done:false` outcome
  // falls through to the exact path exactly as before, with its optional
  // note riding the final result under `tab` — a skipped tab is loud,
  // never silent. A lane crash must never take down the paid path.
  let tabNote: Record<string, unknown> | undefined;
  if (runtime.tabLane && !isMultipart) {
    try {
      const outcome = await runtime.tabLane(
        {
          url: params.url,
          method: params.method || "GET",
          headers: requestHeaders,
          body: typeof fetchOpts.body === "string" ? fetchOpts.body : undefined,
        },
        requirements,
      );
      if (outcome.done) return outcome.result;
      tabNote = outcome.note;
    } catch (err: any) {
      tabNote = {
        rail: "tab",
        used: false,
        error: `tab lane failed: ${err?.message ?? String(err)}`,
      };
    }
  }
  const withTab = (r: Record<string, unknown>): Record<string, unknown> =>
    tabNote ? { ...r, tab: tabNote } : r;

  // Mode 1: Wallet auto-pay
  if (wallet) {
    try {
      const policyCheck = await evaluatePaymentRequirements(
        wallet,
        requirements,
        runtime.maxAmountUsdc,
      );
      if (!policyCheck.ok) {
        return withTab({ status: 402, error: policyCheck.error, requirements });
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
            requirements,
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
          requirements,
        });
      }

      // payAndFetch is the SDK's version-agnostic payment seam — it probes
      // once, detects x402 v1 (challenge in the body) vs v2 (challenge in
      // the PAYMENT-REQUIRED header), handles Sign-In-With-X transparently,
      // and pays via the matching strategy. Routing through it (rather than
      // the v2-only wrapFetch) is what makes the CLI able to pay v1 servers.
      const { payAndFetch, createKeypairWallet, createEvmKeypairWallet } =
        await import("@dexterai/x402/client");

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
      if (isMultipart) {
        try {
          paidFetchOpts.body = await buildMultipartFormData(params.multipart!);
        } catch (err: any) {
          return { status: 400, error: err?.message || "multipart_rebuild_failed" };
        }
      }

      const payResult = await payAndFetch(
        params.url,
        paidFetchOpts,
        walletSet as never,
        {},
      );

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
            requirements,
          });
        }
        // A typed, expected failure — never a thrown error. SIW-X endpoints
        // surface here too (the v1/v2 strategies don't recognise an
        // identity-only challenge as payable). These reasons all mean no
        // money moved (or the merchant rejected the payload) — retry-safe.
        return withTab({
          status: 402,
          error: `Payment failed: ${payResult.reason}${
            payResult.detail ? ` — ${payResult.detail}` : ""
          }`,
          requirements,
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
          requirements,
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
      return withTab({ status: 402, error: `Payment failed: ${err.message}`, requirements });
    }
  }

  // No signing wallet: return canonical x402 requirements only.
  return withTab({
    status: 402,
    message:
      "Payment required. Provide payment-signature manually or configure a wallet for automatic settlement.",
    requirements,
  });
}

export function registerFetchTool(server: McpServer, opts: FetchToolOpts): void {
  const wallet = opts.wallet;
  const hasWallet = wallet !== null;
  const meta = opts.metas.fetch;
  const getMaxAmountUsdc =
    opts.getMaxAmountUsdc ?? (() => Number.POSITIVE_INFINITY);

  const description = hasWallet
    ? "Call any x402-protected API with automatic USDC payment across Solana, Base, Polygon, Arbitrum, Optimism, and Avalanche. " +
      "Signs and pays using the configured wallet. Returns the API response directly."
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
      .describe("Optional per-call spend cap override in USDC."),
    tab: z
      .boolean()
      .optional()
      .describe(
        "Whether to pay via an open spend-tab when the seller offers scheme " +
          "'tab' and one is connected (default true). Set false to force the " +
          "one-shot exact payment for THIS call — the escape hatch when a tab " +
          "is refusing vouchers and you just need the single call to go through.",
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
    tab?: boolean;
    multipart?: MultipartInput;
  }) => {
    try {
      const effectiveMax = args.maxAmountUsdc ?? getMaxAmountUsdc();
      // Resolve the rolling-budget hooks fresh per call (live settings + a
      // current ledger read). Absent hook = budget disabled.
      const budget = opts.getBudgetRuntime?.();
      // Resolve the tab lane fresh per call too — a tab approved while the
      // server is running becomes payable without a restart. `tab: false` is
      // the per-call opt-out (the exact-payment escape hatch).
      const tabLane = args.tab === false ? null : (opts.getTabLane?.() ?? null);
      const result = await x402Fetch(
        {
          url: args.url,
          method: args.method,
          body: args.body,
          headers: args.headers,
          multipart: args.multipart,
        },
        wallet,
        {
          maxAmountUsdc: effectiveMax,
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

  server.tool("x402_fetch", description, inputSchema, runFetch);

  server.tool(
    "x402_pay",
    "Alias of x402_fetch for clients that want an explicit payment verb. " +
      "Uses the same wallet x402 payment flow and returns the same settlement/result payload.",
    inputSchema,
    runFetch,
  );
}
