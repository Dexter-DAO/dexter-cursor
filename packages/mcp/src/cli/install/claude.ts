import { resolve } from "node:path";
import { VERSION } from "../../config.js";
import { requireRegistrationName } from "./collision.js";

export interface ClaudeMcpCommand {
  command: "claude";
  args: string[];
}

/**
 * Build the Claude Code command for the local npm MCP.
 *
 * The repository plugin is a separate hosted product. The npm installer must
 * never add that marketplace package or it would silently replace local
 * wallet authority with the hosted connector.
 */
export function buildClaudeCodeMcpCommand(
  dev: boolean,
  cwd = process.cwd(),
  registrationName = "opendexter",
): ClaudeMcpCommand {
  const name = requireRegistrationName(registrationName);
  const server = dev
    ? ["node", resolve(cwd, "dist/index.js"), "--dev"]
    : ["npx", "-y", `@dexterai/opendexter@${VERSION}`];

  return {
    command: "claude",
    args: ["mcp", "add", "--scope", "user", name, "--", ...server],
  };
}
