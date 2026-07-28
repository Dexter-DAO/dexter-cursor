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
 * The immutable package-version form is immune to both a stale global install
 * and dist-tag drift: every command relayed by this RC runs the same reviewed
 * CLI that emitted it.
 */
import { VERSION } from "./config.js";

export function cliHint(subcommand: string): string {
  return `npx -y @dexterai/opendexter@${VERSION} ${subcommand}`;
}
