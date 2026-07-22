import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkEndpointPricing, type CheckResult } from "@dexterai/x402-core";
import type { CheckToolOpts } from "../types.js";

/**
 * x402_check tool registration.
 *
 * Thin adapter over @dexterai/x402-core's checkEndpointPricing(). All probe
 * logic, schema extraction, and authMode classification live in x402-core —
 * this file owns the MCP-side surface (name, description, Zod schema,
 * widget metadata binding). Matches the hosted server's behavior so both
 * surfaces return identical `inputSchema`, `outputSchema`, and `authMode`.
 */
export function registerCheckTool(server: McpServer, opts: CheckToolOpts): void {
  const meta = opts.metas.check;

  server.registerTool(
    "x402_check",
    {
      description:
        "Probe an endpoint for x402 payment requirements without paying. " +
        "Returns pricing options per chain (Solana, Base, Polygon, Arbitrum, Optimism, Avalanche, BSC, SKALE), " +
        "input/output body schemas when the endpoint publishes them, and an authMode classification " +
        "(`paid`, `siwx`, `apiKey`, `apiKey+paid`, `unprotected`, or `unknown`). " +
        "Use this before x402_fetch to preview cost and request/response shape, " +
        "and before x402_access to detect whether identity gating applies.",
      inputSchema: {
        url: z.string().url().describe("The URL to check"),
        method: z
          .enum(["GET", "POST", "PUT", "DELETE"])
          .default("GET")
          .describe("HTTP method to probe with"),
      },
      _meta: meta,
    },
    async (args) => {
      try {
        const result: CheckResult = await checkEndpointPricing(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          _meta: meta,
        } as any;
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    },
  );
}
