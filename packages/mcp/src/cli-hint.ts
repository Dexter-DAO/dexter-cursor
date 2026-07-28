/**
 * Version-safe CLI hint.
 *
 * The tab lane is the single paid path behind BOTH the `opendexter fetch` CLI
 * and the MCP server's canonical `x402_fetch` tool. Its outcomes — refusal
 * explanations, dead-grant notes, settle receipts — ride back through the MCP
 * result and get relayed by an agent to a human whose GLOBAL `opendexter` may
 * be months stale. A bare `opendexter tab connect …` hint choked with "Unknown
 * arguments" on exactly such a box (register R2b): the tab commands did not
 * exist in the version that was installed.
 *
 * The `npx -y …@latest` form is immune: it always fetches and runs the current
 * CLI regardless of what — if anything — is installed globally. Use this for
 * every copy-pasteable command hint that leaves the process as relayable data.
 */
export function cliHint(subcommand: string): string {
  return `npx -y @dexterai/opendexter@latest ${subcommand}`;
}
