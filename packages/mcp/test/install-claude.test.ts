import { describe, expect, it } from "vitest";
import { VERSION } from "../src/config.js";
import { buildClaudeCodeMcpCommand } from "../src/cli/install/claude.js";

describe("Claude Code local MCP installer", () => {
  it("adds the release-pinned local stdio MCP without installing a hosted plugin", () => {
    const command = buildClaudeCodeMcpCommand(false, "/tmp/opendexter-source");

    expect(command).toEqual({
      command: "claude",
      args: [
        "mcp",
        "add",
        "--scope",
        "user",
        "opendexter",
        "--",
        "npx",
        "-y",
        `@dexterai/opendexter@${VERSION}`,
      ],
    });
    expect(command.args).not.toContain("marketplace");
    expect(command.args).not.toContain("plugin");
    expect(command.args).not.toContain("plugins");
    expect(command.args).not.toContain("@latest");
  });

  it("points development installs at the checked-out build", () => {
    expect(
      buildClaudeCodeMcpCommand(true, "/tmp/opendexter-source").args,
    ).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "opendexter",
      "--",
      "node",
      "/tmp/opendexter-source/dist/index.js",
      "--dev",
    ]);
  });
});
