import {
  callHostedRuntimeTool,
  structuredToolResult,
} from "../connect/wallet.js";

/**
 * CLI entrypoint for the `opendexter check` subcommand.
 *
 * The MCP server and this CLI both proxy the canonical hosted tool. This file
 * owns only the npm-CLI-flavored output and has no local signer path.
 */
export async function cliCheck(
  url: string,
  opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    body?: string;
    dev: boolean;
  },
): Promise<void> {
  try {
    const response = await callHostedRuntimeTool({
      toolName: "x402_check",
      arguments: {
        url,
        method: opts.method,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      },
      dev: opts.dev,
    });
    console.log(JSON.stringify(structuredToolResult(response), null, 2));
    if (response.isError === true) process.exit(1);
  } catch (err: any) {
    console.log(JSON.stringify({ error: err.message || String(err) }, null, 2));
    process.exit(1);
  }
}
