import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  attachRuntimeAuthorityStatus,
  callHostedRuntimeTool,
  projectRuntimeAuthorityStatus,
  readGovernedAuthorityStatus,
  structuredToolResult,
  type HostedRuntimeToolName,
} from "../connect/wallet.js";

export const HOSTED_PROXY_TOOL_ROSTER = [
  "x402_search",
  "x402_check",
  "x402_fetch",
  "x402_status",
  "x402_access",
  "x402_wallet",
  "dexter_portfolio",
] as const satisfies readonly HostedRuntimeToolName[];

/** Exact operating contract for this proxy; the legacy shared rendering still
 * describes a caller-carried purchase contract and therefore cannot be served. */
export const HOSTED_PROXY_INSTRUCTIONS = `You are connected to OpenDexter's hosted governed x402 runtime through the local proxy. Account-bound tools use the stored OAuth bearer. The proxy never handles private keys and never switches to a local signer automatically.

# Tool routing

x402_search discovers live resources. x402_check probes exact terms without paying. A non-GET x402_check can still cause seller-side effects, so obtain separate explicit authorization for the exact probe before calling it; that probe authorization is not payment approval. Those two tools can use the anonymous hosted surface. x402_fetch, x402_status, x402_access, x402_wallet, and dexter_portfolio require the connected OAuth bearer. For a connected paid route, x402_check returns one opaque server-owned intentId; never parse, reconstruct, or replace it.

x402_fetch accepts only that intentId and a separately approved maxAmountAtomic ceiling. Those two values do not authorize a different URL, body, seller, route, amount, or payment mode. A failed or ambiguous fetch must never be retried blindly.

x402_status accepts the same intentId and is the read-only recovery path after an ambiguous or completed x402_fetch. Reconcile status before deciding whether any retry is appropriate.

x402_access calls SIWX-protected resources through the hosted wallet-bound principal. A non-GET x402_access can cause seller-side effects and requires separate explicit authorization for that exact request before it is sent. x402_wallet reads the hosted wallet and runtimeAuthority evidence. dexter_portfolio reads the session-bound governed asset inventory; portfolio value is not spendable cash.

# Authority truth

An OAuth bearer proves account authorization only. It does not prove an active grant, remaining capacity, or active on-chain role. Treat runtimeAuthority as active only when its exact live evidence reports active bounded_payment_authority. Report unavailable fields as unavailable. Never infer authority from a balance, address, token claim, or portfolio metadata.

Local wallet.json/environment signing is not a payment executor on this runtime. Existing local wallets may be inspected only through the explicitly labeled non-payment recovery view. There is no automatic or opt-in local payment fallback. Manage or revoke hosted authority at https://dexter.cash/wallet.

Read docs://opendexter/workflow, docs://opendexter/protocol, or docs://opendexter/debugging for deeper protocol detail.`;

const httpMethod = z.enum(["GET", "POST", "PUT", "DELETE"]);

export interface HostedProxyOptions {
  dev?: boolean;
  dataDir?: string;
  /** Test seam. Production always delegates to callHostedRuntimeTool. */
  callTool?: (
    toolName: HostedRuntimeToolName,
    args: Record<string, unknown>,
    retryRejectedBearer: boolean,
  ) => Promise<CallToolResult>;
  /** Test seam for the bearer-authenticated read-only authority endpoint. */
  readAuthorityStatus?: () => ReturnType<typeof readGovernedAuthorityStatus>;
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent = {
    ok: false,
    error: "hosted_runtime_call_failed",
    message,
    automaticLocalFallback: false,
  };
  return {
    isError: true,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

export function registerHostedProxyTools(
  server: McpServer,
  opts: HostedProxyOptions = {},
): void {
  const callTool = opts.callTool ?? ((toolName, args, retryRejectedBearer) =>
    callHostedRuntimeTool({
      toolName,
      arguments: args,
      dev: opts.dev,
      dataDir: opts.dataDir,
      retryRejectedBearer,
    }));
  const call = async (
    toolName: HostedRuntimeToolName,
    args: Record<string, unknown>,
    retryRejectedBearer = true,
  ): Promise<CallToolResult> => {
    try {
      return await callTool(toolName, args, retryRejectedBearer);
    } catch (error) {
      return errorResult(error);
    }
  };

  server.registerTool(
    "x402_search",
    {
      description: "Search the canonical hosted x402 marketplace.",
      inputSchema: z.object({
        query: z.string().min(1),
        network: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        unverified: z.boolean().optional(),
        testnets: z.boolean().optional(),
        rerank: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    (args) => call("x402_search", args),
  );

  server.registerTool(
    "x402_check",
    {
      description:
        "Probe exact x402 terms without paying. Non-GET probes can cause seller-side effects and require separate explicit probe authorization; connected checks return a server-owned purchase intent.",
      inputSchema: z.object({
        url: z.string().url(),
        method: httpMethod.optional(),
        body: z.string().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) => call("x402_check", args),
  );

  server.registerTool(
    "x402_fetch",
    {
      description:
        "Execute exactly one hosted, server-owned purchase intent under the connected governed authority.",
      inputSchema: z.object({
        intentId: z.string().min(1).max(256),
        maxAmountAtomic: z.string().regex(/^[1-9]\d{0,19}$/),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    // A rejected bearer after possible dispatch is not proof of non-payment.
    // Never refresh-and-retry this consequential tool automatically.
    (args) => call("x402_fetch", args, false),
  );

  server.registerTool(
    "x402_status",
    {
      description:
        "Read the exact server-owned purchase intent after an uncertain or completed fetch. This never dispatches payment.",
      inputSchema: z.object({
        intentId: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    (args) => call("x402_status", args),
  );

  server.registerTool(
    "x402_access",
    {
      description:
        "Use the hosted wallet-bound proof path for an SIWX-protected resource. Non-GET requests can cause seller-side effects and require separate explicit request authorization.",
      inputSchema: z.object({
        url: z.string().url(),
        method: httpMethod.optional(),
        body: z.string().optional(),
        sessionToken: z.string().optional(),
        sessionKey: z.string().optional(),
        network: z.string().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (args) => call("x402_access", args),
  );

  server.registerTool(
    "x402_wallet",
    {
      description:
        "Read the connected hosted wallet and exact governed x402-authority evidence.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const result = await call("x402_wallet", {});
      const wallet = structuredToolResult(result);
      const endpointStatus = opts.readAuthorityStatus
        ? await opts.readAuthorityStatus()
        : await readGovernedAuthorityStatus({
            dev: opts.dev,
            dataDir: opts.dataDir,
          });
      // Until the bearer endpoint is source-complete it truthfully returns an
      // unavailable projection. An exact evidence tuple embedded by the hosted
      // wallet remains acceptable and is never inferred from balances.
      const embeddedStatus = projectRuntimeAuthorityStatus(wallet);
      const status = endpointStatus.evidenceNamespace
        ? endpointStatus
        : embeddedStatus.evidenceNamespace
          ? embeddedStatus
          : endpointStatus;
      return attachRuntimeAuthorityStatus(result, status);
    },
  );

  server.registerTool(
    "dexter_portfolio",
    {
      description: "Read the governed portfolio bound to the connected hosted principal.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    () => call("dexter_portfolio", {}),
  );
}
