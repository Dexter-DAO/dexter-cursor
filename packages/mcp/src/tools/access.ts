import {
  callHostedRuntimeTool,
  structuredToolResult,
} from "../connect/wallet.js";

/**
 * CLI entrypoint for the `opendexter access` subcommand.
 *
 * The MCP server and this CLI both proxy the canonical hosted tool. This file
 * owns only the npm-CLI-flavored output and has no local wallet-proof signer.
 */
export async function cliAccess(
  url: string,
  opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    body?: string;
    network?: string;
    dev: boolean;
  },
): Promise<void> {
  try {
    const response = await callHostedRuntimeTool({
      toolName: "x402_access",
      arguments: {
        url,
        method: opts.method,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.network !== undefined ? { network: opts.network } : {}),
      },
      dev: opts.dev,
      retryRejectedBearer: opts.method === "GET",
    });
    console.log(JSON.stringify(structuredToolResult(response), null, 2));
    if (response.isError === true) process.exit(1);
  } catch (err: any) {
    console.log(JSON.stringify({ error: err.message || String(err) }, null, 2));
    process.exit(1);
  }
}
