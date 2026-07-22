import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  capabilitySearch,
  buildSearchResponse,
  buildSearchErrorResponse,
} from "@dexterai/x402-core";
import type { SearchToolOpts } from "../types.js";
import { DEFAULT_CAPABILITY_PATH } from "../types.js";

/**
 * x402_search tool registration.
 *
 * Thin adapter over @dexterai/x402-core's capabilitySearch() and
 * buildSearchResponse(). All HTTP, formatting, and ranking logic lives
 * in x402-core — this file owns the MCP-side surface (name, description,
 * Zod schema, widget metadata binding, error contract).
 */
export function registerSearchTool(server: McpServer, opts: SearchToolOpts): void {
  const path = opts.capabilityPath ?? DEFAULT_CAPABILITY_PATH;
  const endpoint = `${opts.apiBaseUrl}${path}`;
  const meta = opts.metas.search;

  server.tool(
    "x402_search",
    "Search the Dexter x402 marketplace for paid API resources using semantic capability search. " +
      "Returns two tiers: strong matches (high-confidence capability hits) and related matches " +
      "(adjacent services that cleared the similarity floor but not the strong threshold). " +
      "Handles synonyms and alternate phrasings internally — pass the user's natural-language " +
      "intent directly. Use x402_fetch to call any result. " +
      "Each result carries `serviceProfile` (structured input semantics + good-response shape) " +
      "when the catalog has OpenAPI-derived behavioral truth for it; null otherwise. The response " +
      "also includes `confidence` (profileCoverage + topMatchProfileBacked) and, when actionable, " +
      "`triangulate` (a recommendation to cross-check with a profile-backed alternate before paying " +
      "the top match). Treat the presence of `triangulate` as load-bearing: it means the top result " +
      "is ranked on marketing text alone and an ambiguous query could yield a confidently-wrong answer.",
    {
      query: z
        .string()
        .describe(
          "Natural-language description of the capability you want. " +
            "e.g. 'check wallet balance on Base', 'generate an image', 'ETH price feed', " +
            "'translate text'. Do NOT pre-filter by chain or category — the search layer " +
            "handles expansion and ranking.",
        ),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max results across strong + related tiers combined (1-50, default 20)"),
      unverified: z
        .boolean()
        .optional()
        .describe("Include unverified resources in results (default false)"),
      testnets: z
        .boolean()
        .optional()
        .describe("Include testnet-only resources (default false — testnets hidden by default)"),
      rerank: z
        .boolean()
        .optional()
        .describe(
          "Cross-encoder LLM rerank of top strong results (default true). Set false for " +
            "deterministic order or lowest-latency path.",
        ),
    },
    async (args) => {
      try {
        const result = await capabilitySearch({ ...args, endpoint });
        const data = buildSearchResponse(result);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
          _meta: meta,
        } as any;
      } catch (err: any) {
        const payload = buildSearchErrorResponse(err.message || "search_failed");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
          _meta: meta,
          isError: true,
        } as any;
      }
    },
  ).update({ _meta: meta });
}
