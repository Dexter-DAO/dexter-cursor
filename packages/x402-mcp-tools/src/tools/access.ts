import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  SIGN_IN_WITH_X,
  createSIWxPayload,
  encodeSIWxHeader,
} from "@x402/extensions/sign-in-with-x";
import type { AccessToolOpts } from "../types.js";
import type { WalletAdapter } from "../wallet-adapter.js";

/**
 * x402_access tool registration.
 *
 * Implements the Sign-In-With-X identity-gating flow. The wallet
 * adapter provides the Solana / EVM signer; the registrar handles the
 * 402 probe, SIWX payload construction, retry with the signed header,
 * and the response normalization. No filesystem reads, no global wallet
 * lookup — everything flows through opts.wallet.
 */

function parseResponse(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    return res.json().catch(() => res.text());
  }
  return res.text();
}

function chooseSiwxChain(
  extension: Record<string, unknown> | undefined,
  preferredNetwork?: string,
) {
  const supportedChains = Array.isArray((extension as any)?.supportedChains)
    ? ((extension as any).supportedChains as Array<{ chainId: string; type: string }>)
    : [];
  if (supportedChains.length === 0) return null;

  if (preferredNetwork) {
    return supportedChains.find((c) => c.chainId === preferredNetwork) || null;
  }

  return supportedChains[0] ?? null;
}

export async function accessWithWalletProof(
  params: { url: string; method: string; body?: string; preferredNetwork?: string },
  wallet: WalletAdapter | null,
): Promise<Record<string, unknown>> {
  if (!wallet) {
    return {
      status: 401,
      error: "No wallet configured",
      tip: "This endpoint requires a wallet proof. Provision a wallet for this MCP session and try again.",
    };
  }

  const requestHeaders: Record<string, string> = { "Content-Type": "application/json" };
  const fetchOpts: RequestInit = { method: params.method || "GET", headers: requestHeaders };
  if (params.body && params.method !== "GET") fetchOpts.body = params.body;

  const firstRes = await fetch(params.url, {
    ...fetchOpts,
    signal: AbortSignal.timeout(15_000),
  });
  if (firstRes.status !== 402) {
    return { status: firstRes.status, data: await parseResponse(firstRes) };
  }

  const paymentRequiredHeader =
    firstRes.headers.get("PAYMENT-REQUIRED") || firstRes.headers.get("payment-required");
  if (!paymentRequiredHeader) {
    return {
      status: 402,
      error: "Endpoint returned 402 without PAYMENT-REQUIRED header.",
    };
  }

  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
  const siwxExtension = paymentRequired.extensions?.[SIGN_IN_WITH_X] as
    | Record<string, unknown>
    | undefined;
  if (!siwxExtension) {
    return {
      status: 402,
      error: "Endpoint returned 402 but no Sign-In-With-X extension was present.",
      hint: "This endpoint may be paid rather than identity-gated. Use x402_check or x402_fetch instead.",
    };
  }

  const selectedChain = chooseSiwxChain(siwxExtension, params.preferredNetwork);
  if (!selectedChain) {
    return {
      status: 402,
      error: "Sign-In-With-X extension was present, but no supported chain could be selected.",
    };
  }

  const signer = String(selectedChain.chainId).startsWith("solana:")
    ? wallet.getSolanaSigner()
    : wallet.getEvmSigner();

  if (!signer) {
    return {
      status: 402,
      error: `Wallet does not have a signer for ${selectedChain.chainId}.`,
    };
  }

  const payload = await createSIWxPayload(
    {
      ...((siwxExtension as any).info || {}),
      chainId: selectedChain.chainId,
      type: selectedChain.type,
    },
    signer as any,
  );

  const authHeader = encodeSIWxHeader(payload);
  const retryHeaders = new Headers(fetchOpts.headers as Record<string, string>);
  retryHeaders.set("SIGN-IN-WITH-X", authHeader);

  const retryRes = await fetch(params.url, {
    ...fetchOpts,
    headers: retryHeaders,
    signal: AbortSignal.timeout(15_000),
  });

  return {
    status: retryRes.status,
    auth: {
      mode: "siwx",
      network: selectedChain.chainId,
      signedAddress: payload.address,
    },
    data: await parseResponse(retryRes),
  };
}

export function registerAccessTool(server: McpServer, opts: AccessToolOpts): void {
  const wallet = opts.wallet;
  // Access returns API-response data like a fetch, so it shares the fetch widget
  // (matches the hosted server's ACCESS_META = fetch widget).
  const meta = opts.metas.fetch;

  server.registerTool(
    "x402_access",
    {
      description:
        "Access identity-gated endpoints using a wallet proof instead of a payment. " +
        "Use this when an endpoint requires Sign-In-With-X / wallet authentication " +
        "rather than USDC settlement.",
      inputSchema: {
        url: z.string().url().describe("The protected endpoint URL"),
        method: z
          .enum(["GET", "POST", "PUT", "DELETE"])
          .default("GET")
          .describe("HTTP method"),
        body: z.string().optional().describe("JSON request body for POST/PUT"),
        network: z
          .string()
          .optional()
          .describe("Optional preferred auth network, e.g. solana:... or eip155:8453"),
      },
      _meta: meta,
    },
    async (args) => {
      try {
        const result = await accessWithWalletProof(
          {
            url: args.url,
            method: args.method,
            body: args.body,
            preferredNetwork: args.network,
          },
          wallet,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        } as any;
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err.message || String(err) }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
