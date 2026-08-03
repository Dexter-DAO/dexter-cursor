import { describe, expect, it } from "vitest";

import {
  classifyExistingMcpProbe,
  existingMcpCommand,
  existingRegistrationMessage,
} from "../src/cli/install/collision.js";

describe("local and hosted OpenDexter registration collision gate", () => {
  it("uses each client's supported read-only MCP lookup", () => {
    expect(existingMcpCommand("claude-code")).toEqual({
      command: "claude",
      args: ["mcp", "get", "opendexter"],
    });
    expect(existingMcpCommand("codex")).toEqual({
      command: "codex",
      args: ["mcp", "get", "opendexter"],
    });
    expect(existingMcpCommand("cursor")).toBeNull();
  });

  it("treats a successful lookup as an existing registration", () => {
    expect(
      classifyExistingMcpProbe(
        0,
        "opendexter\\n  transport: streamable_http\\n  url: https://open.dexter.cash/mcp",
        "",
      ).state,
    ).toBe("present");
  });

  it("recognizes the clients' explicit not-found response", () => {
    expect(
      classifyExistingMcpProbe(1, "", 'No MCP server named "opendexter".').state,
    ).toBe("absent");
  });

  it("fails closed when the client cannot prove the name is unused", () => {
    expect(classifyExistingMcpProbe(null, "", "command not found").state).toBe("unknown");
    expect(existingRegistrationMessage("Codex", "unknown")).toMatch(
      /left the client unchanged/i,
    );
  });
});
