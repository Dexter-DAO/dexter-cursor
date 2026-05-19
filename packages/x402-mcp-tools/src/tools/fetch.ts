import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FetchToolOpts } from "../types.js";
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

function extractPriceUsdc(accept: Record<string, unknown>): number | null {
  const amount = Number(accept.amount || 0);
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const accepts = Array.isArray(requirements?.accepts)
    ? (requirements.accepts as Array<Record<string, unknown>>)
    : [];
  if (accepts.length === 0) return { ok: true };

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
      .map((row) => `$${row.priceUsdc!.toFixed(2)} on ${row.network}`)
      .join(", ");
    return {
      ok: false,
      error:
        `Payment policy blocked this call. Available options: ${prices}. ` +
        `Current maxAmountUsdc is $${effectiveMaxAmount.toFixed(2)}.`,
    };
  }

  const funded = withinPolicy.filter(
    (row) => row.priceUsdc != null && row.availableUsdc >= row.priceUsdc,
  );
  if (funded.length === 0) {
    const balances = withinPolicy
      .map(
        (row) =>
          `${row.network}: have $${row.availableUsdc.toFixed(2)}, need $${row.priceUsdc!.toFixed(2)}`,
      )
      .join("; ");
    return { ok: false, error: `Insufficient balance for this call. ${balances}` };
  }

  return { ok: true };
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
  maxAmountUsdc: number;
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

  // Mode 1: Wallet auto-pay
  if (wallet) {
    try {
      const policyCheck = await evaluatePaymentRequirements(
        wallet,
        requirements,
        runtime.maxAmountUsdc,
      );
      if (!policyCheck.ok) {
        return { status: 402, error: policyCheck.error, requirements };
      }

      const signers = wallet.getPaymentSigners();
      if (!signers.solanaPrivateKey && !signers.evmPrivateKey) {
        return {
          status: 402,
          error:
            "Wallet does not expose private keys for auto-pay. " +
            "Settle the payment externally and retry, or configure a wallet that supports auto-pay.",
          requirements,
        };
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
        // A typed, expected failure — never a thrown error. SIW-X endpoints
        // surface here too (the v1/v2 strategies don't recognise an
        // identity-only challenge as payable).
        return {
          status: 402,
          error: `Payment failed: ${payResult.reason}${
            payResult.detail ? ` — ${payResult.detail}` : ""
          }`,
          requirements,
        };
      }

      const paidRes = payResult.response;
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

      return result;
    } catch (err: any) {
      return { status: 402, error: `Payment failed: ${err.message}`, requirements };
    }
  }

  // No signing wallet: return canonical x402 requirements only.
  return {
    status: 402,
    message:
      "Payment required. Provide payment-signature manually or configure a wallet for automatic settlement.",
    requirements,
  };
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
    multipart?: MultipartInput;
  }) => {
    try {
      const effectiveMax = args.maxAmountUsdc ?? getMaxAmountUsdc();
      const result = await x402Fetch(
        {
          url: args.url,
          method: args.method,
          body: args.body,
          headers: args.headers,
          multipart: args.multipart,
        },
        wallet,
        { maxAmountUsdc: effectiveMax },
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
