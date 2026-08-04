import {
  capabilitySearch,
  buildSearchErrorResponse,
  buildSearchResponse,
} from "@dexterai/x402-core";
import { getApiBase, CAPABILITY_PATH } from "../config.js";

/**
 * CLI entrypoint for the `opendexter search` subcommand.
 *
 * The MCP tool registration for `x402_search` lives in the shared
 * @dexterai/x402-mcp-tools package and is mounted in src/server/index.ts.
 * This file owns only the npm-CLI-flavored output (a single JSON blob
 * to stdout, exit-code-on-failure).
 */
export async function cliSearch(query: string, opts: { dev: boolean }): Promise<void> {
  try {
    const endpoint = `${getApiBase(opts.dev)}${CAPABILITY_PATH}`;
    const result = await capabilitySearch({ query, endpoint });
    console.log(JSON.stringify(buildSearchResponse(result), null, 2));
  } catch (err: any) {
    console.log(
      JSON.stringify(
        buildSearchErrorResponse(err.message || String(err)),
        null,
        2,
      ),
    );
    process.exit(1);
  }
}
